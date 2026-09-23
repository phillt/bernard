import { ICON_PATHS } from './icon-data.js';
import { ICON_SIZES } from './icons.js';

/**
 * The client an applet page talks to Bernard through.
 *
 * **Served once from a route, never copied per applet** — the same argument
 * `tokens.ts` makes for the palette, and a stronger one. A page that gets the
 * stylesheet wrong looks wrong; a page that gets the protocol wrong does not
 * work at all, and fails as an opaque `403` that is deliberately
 * indistinguishable from a rebinding attack (`guard.ts`).
 *
 * Before this existed the whole "SDK" was a ~30-line `fetch` trio inside the
 * bundled demo's `index.html`, and the `applet` tool's `page` description told
 * a model to "read the bundled demo applet for the shape" — naming no path,
 * never mentioning the token, and pointing at a file the tool's own `read`
 * action could not return. A generated page duly omitted the
 * `x-bernard-token` header and every button 403'd.
 *
 * ## A classic script, not a module
 *
 * `<script type="module">` is **always deferred**, so a page that writes
 *
 *     <script src="/__bernard/applet.js" type="module"></script>
 *     <script>bernard.invoke('hello')</script>
 *
 * gets `bernard is not defined` — the inline classic script runs first. A
 * classic external script executes before any later inline one, which is the
 * only ordering a generating model reliably produces. The alternative is
 * asking that model to also make its own script a module, on a page whose
 * failure mode is precisely "got a protocol detail wrong".
 *
 * ## What it deliberately is not
 *
 * A protocol client, not a framework. No widgets, no DOM helpers, no data
 * binding. The palette is the UI floor; two floors is a framework, and the
 * page owns everything visual.
 */

/** Path the host serves the client from, inside its reserved namespace. */
export const SDK_PATH = '/__bernard/applet.js';

/**
 * What the SDK says when the guard refuses it.
 *
 * The guard answers every refusal with one terse `Forbidden` on purpose: a
 * per-cause message on the wire is an oracle a prober can enumerate. That
 * leaves a developer with nothing, so the explanation lives **here** instead —
 * in a file the prober can already `GET`, where it discloses nothing new and
 * tells the page's author everything. This is the one place both properties
 * can hold at once.
 */
const FORBIDDEN_HELP = [
  'The applet host refused this request.',
  'The SDK did present the token, so the usual causes are:',
  '(1) the page was loaded through "localhost", an alias or a proxy rather than',
  '    the 127.0.0.1:<port> origin the host serves, or',
  '(2) the applet host restarted, which mints a new token — reload the page.',
].join(' ');

function build(): string {
  // Authored as a string rather than a compiled asset: `tokens.ts` and
  // `webmanifest.ts` already establish that shape for served text, and a real
  // file would add a `readFileSync`, a `package.json` files entry and a
  // dependency on the dist layout for no gain.
  return `/* Bernard applet client. Served by the applet host; do not vendor a copy. */
(function () {
  'use strict';

  var BOOTSTRAP = '/__bernard/bootstrap.json';
  var INVOKE = '/__bernard/invoke';
  var STORE = '/__bernard/store';
  var VIOLATION = '/__bernard/violation';
  var FORBIDDEN_HELP = ${JSON.stringify(FORBIDDEN_HELP)};
  var ICON_PATHS = ${JSON.stringify(ICON_PATHS)};
  var ICON_SIZES = ${JSON.stringify(ICON_SIZES)};

  function BernardError(message, code) {
    var err = new Error(message);
    err.name = 'BernardError';
    err.code = code;
    return err;
  }

  var booted = null;

  /** Resolves once per page load; every call reuses the same handles. */
  function bootstrap() {
    if (booted) return booted;
    booted = fetch(BOOTSTRAP)
      .then(function (res) {
        if (!res.ok) throw BernardError('Could not reach the applet host (' + res.status + ').', 'bootstrap_failed');
        return res.json();
      })
      .catch(function (err) {
        // Never cache a failure: a page that loaded before the host was ready
        // would otherwise be broken until reload.
        booted = null;
        throw err;
      });
    return booted;
  }

  function post(url, boot, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bernard-token': boot.token },
      body: JSON.stringify(body),
    }).then(function (res) {
      if (res.status === 403) throw BernardError(FORBIDDEN_HELP, 'forbidden');
      return res.json().catch(function () {
        throw BernardError('The applet host returned a malformed response (' + res.status + ').', 'bad_response');
      });
    });
  }

  /**
   * Runs one of this applet's actions.
   *
   * Resolves to the action's result and THROWS on failure, rather than handing
   * back an { ok: false } envelope. A forgotten "if (!body.ok)" is silent and
   * leaves a dead button; a forgotten catch surfaces as an unhandled rejection,
   * which the handler below renders. Loud beats silent.
   */
  function invoke(action, args) {
    return bootstrap().then(function (boot) {
      var handle = boot.handles && boot.handles[action];
      if (!handle) {
        var declared = Object.keys(boot.handles || {});
        throw BernardError(
          'This applet declares no action "' + action + '". Declared: ' +
            (declared.length ? declared.join(', ') : '(none)') + '.',
          'unknown_action'
        );
      }
      return post(INVOKE, boot, { handle: handle, args: args || {} }).then(function (body) {
        if (body && body.ok === false) {
          var e = (body && body.error) || {};
          throw BernardError(e.message || 'The action failed.', e.code || 'failed');
        }
        return body ? body.result : undefined;
      });
    });
  }

  function storeOp(op, key, value, opts) {
    return bootstrap().then(function (boot) {
      var body = { op: op };
      if (key !== undefined) body.key = key;
      if (value !== undefined) body.value = value;
      if (opts && opts.prefix !== undefined) body.prefix = opts.prefix;
      if (opts && opts.limit !== undefined) body.limit = opts.limit;
      if (opts && opts.after !== undefined) body.after = opts.after;
      return post(STORE, boot, body).then(function (res) {
        // The two doors do not agree on the error shape: /invoke answers
        // { error: { code, message } } and /store answers { error: "..." }.
        // Normalised here rather than in either route, because changing a
        // route's envelope is a contract change for anything already reading it.
        if (res && res.ok === false) {
          var e = res.error;
          var msg = typeof e === 'string' ? e : (e && e.message);
          var code = typeof e === 'string' ? 'failed' : ((e && e.code) || 'failed');
          throw BernardError(msg || 'The store operation failed.', code);
        }
        return res ? res.result : undefined;
      });
    });
  }

  /**
   * One error floor, not a framework.
   *
   * Unopinionated about layout — the page owns everything visual — and
   * opinionated about silence, which is the failure actually observed. A page
   * that wants its own handling gets it by handling the rejection.
   */
  function show(message) {
    try {
      var el = document.getElementById('bernard-error');
      if (!el) {
        el = document.createElement('p');
        el.id = 'bernard-error';
        el.setAttribute('role', 'alert');
        // The class, not an inline colour. The served floor styles \`.error\`
        // with \`--danger\`, which exists now (#465) — the old
        // \`var(--danger, #f85149)\` carried a fallback hex precisely because
        // it did not. For the record, that line was never CSP-broken:
        // \`style-src\` does not govern a CSSOM property setter. It was only a
        // hard-coded colour in Bernard's own floor.
        el.className = 'error';
        document.body.appendChild(el);
      }
      el.textContent = String(message);
    } catch (e) {
      /* A page with no body yet; the console still has it. */
    }
  }

  addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason;
    if (r && r.name === 'BernardError') show(r.message);
  });

  /**
   * Tell Bernard what the browser refused to load.
   *
   * A blocked image or fetch fails SILENTLY — no error, no rejection, nothing
   * the page can catch — so without this the applet just looks wrong and
   * nobody can say why. Reported here rather than through a CSP report-uri
   * because a browser-generated report carries no headers, and accepting one
   * would mean exempting a path from the host's token check.
   *
   * Deduped in-page as well as in the host: one broken image in a list of
   * thirty fires thirty times, and the count that matters is kept server-side.
   * Best-effort throughout — failing to report a block must never become a
   * second, louder failure on top of the first.
   */
  var reported = {};
  addEventListener('securitypolicyviolation', function (ev) {
    try {
      var key = ev.effectiveDirective + '|' + ev.blockedURI;
      if (reported[key]) return;
      reported[key] = 1;
      bootstrap().then(function (boot) {
        return fetch(VIOLATION, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-bernard-token': boot.token },
          body: JSON.stringify({ directive: ev.effectiveDirective, blockedURL: ev.blockedURI }),
        });
      })['catch'](function () {});
    } catch (e) {
      /* Never worth a second failure. */
    }
  });

  var bernard = {
    version: 1,
    /** { appId, actions } once the handles are in hand. */
    get ready() {
      return bootstrap().then(function (boot) {
        return { appId: boot.appId, actions: Object.keys(boot.handles || {}) };
      });
    },
    invoke: invoke,
    showError: show,
    icon: icon,
    // Capitalised because it is a component, and htm only resolves a tag as
    // a value when the name is. A lowercase one would be read as an unknown
    // HTML element and render nothing. See the applet-ui-runtime document
    // for the spelling; it cannot be written here, because an interpolation
    // in this comment is still an interpolation of the string this file is.
    Icon: Icon,
    icons: { hydrate: hydrateIcons, names: Object.keys(ICON_PATHS).sort() },
    store: {
      get: function (key) { return storeOp('get', key); },
      set: function (key, value) { return storeOp('set', key, value); },
      // limit/after were supported by the route and dropped here, so a page
      // with more than 100 entries silently got 100 and could not tell.
      list: function (prefix, opts) {
        return storeOp('list', undefined, undefined, {
          prefix: prefix,
          limit: opts && opts.limit,
          after: opts && opts.after,
        });
      },
      delete: function (key) { return storeOp('delete', key); },
    },
  };

  /**
   * Everything an icon is, before it is a string or a vnode.
   *
   * Two renderers need the same four decisions — does the name exist, what
   * size, what class, and the a11y rule. That last one is the one that must
   * never diverge: hidden from assistive tech unless the caller supplies a
   * label, because the common case is an icon beside its own text where
   * announcing it reads as a stutter, while an icon-ONLY control must pass a
   * title or it is unreachable. Written twice, one copy loses that.
   *
   * Returns null for a name the set does not have; both callers degrade.
   */
  function iconParts(name, opts) {
    var body = Object.prototype.hasOwnProperty.call(ICON_PATHS, name) ? ICON_PATHS[name] : null;
    if (body === null) return null;
    opts = opts || {};
    return {
      body: body,
      px: ICON_SIZES[opts.size] || ICON_SIZES.md,
      // Both spellings: className is what the string form documents and
      // class is what an htm template naturally writes on a component.
      cls: 'icon' + (opts.className || opts.class ? ' ' + (opts.className || opts.class) : ''),
      title: opts.title || '',
    };
  }

  /**
   * One icon, as SVG markup.
   *
   * Returns '' for a name that does not exist rather than throwing: an icon
   * is decoration on a control that already works, and a page that dies
   * because of a typo'd icon name is a worse outcome than a missing glyph.
   * page-validate catches the typo at authoring time, where it is cheap.
   */
  function icon(name, opts) {
    var p = iconParts(name, opts);
    if (!p) return '';
    var a11y = p.title
      ? 'role="img" aria-label="' + esc(p.title) + '"'
      : 'aria-hidden="true" focusable="false"';
    return (
      '<svg class="' + esc(p.cls) + '" xmlns="http://www.w3.org/2000/svg" width="' + p.px +
      '" height="' + p.px + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' + a11y + '>' +
      p.body + '</svg>'
    );
  }

  /**
   * The same icon, as a Preact vnode, for a page built on the UI runtime.
   *
   * **Neither existing spelling works there, which is why this exists.**
   * bernard.icon() returns a STRING, and bernard.icons.hydrate() sets
   * innerHTML on a node Preact owns — so the next render throws the glyph
   * away and nothing re-hydrates. A page with a changing list and more than
   * four controls is exactly the shape UI_RUNTIME_RULE sends to the runtime,
   * and it was the one shape that could not use the icon set at all.
   *
   * There is no wrapper element: the markup rides dangerouslySetInnerHTML
   * on the <svg> itself, so the glyph is the flex item a button lays out,
   * exactly as the string spelling produces. A wrapping <span> would need
   * display: contents to stay out of the way, which is a second rule and a
   * second thing to get wrong.
   *
   * The runtime is resolved **at call time, not at load**. sdk.js and
   * ui.js are two classic scripts with no guaranteed order, so a reference
   * captured when this module evaluates may be undefined forever — but a
   * component renders long after both have run. Returns null when the runtime
   * is absent, which on a plain HTML page is the correct answer rather than
   * an error.
   */
  function Icon(props) {
    var rt = typeof window !== 'undefined' ? window.htmPreact : null;
    if (!rt || typeof rt.h !== 'function') return null;
    var p = iconParts(props && props.name, props);
    if (!p) return null;
    var attrs = {
      class: p.cls,
      xmlns: 'http://www.w3.org/2000/svg',
      width: p.px,
      height: p.px,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      dangerouslySetInnerHTML: { __html: p.body },
    };
    if (p.title) {
      attrs.role = 'img';
      attrs['aria-label'] = p.title;
    } else {
      attrs['aria-hidden'] = 'true';
      attrs.focusable = 'false';
    }
    return rt.h('svg', attrs);
  }

  function esc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /**
   * Replaces every <span data-icon="name"> under root with its markup.
   *
   * The declarative half, and the one that matters most: the default applet
   * is plain HTML with no rendering code, so an icon API that could only be
   * reached from JavaScript would go unused there. Writing
   * <span data-icon="search"></span> needs no script of the author's own.
   *
   * Runs on DOMContentLoaded and is re-callable after any dynamic render.
   * Marks what it has done, so calling it twice is free.
   */
  function hydrateIcons(root) {
    var scope = root || (typeof document === 'undefined' ? null : document);
    // Tolerant of a host with no queryable DOM. The SDK is a classic script
    // that runs the moment it loads, so this fires before the page has said
    // anything about itself — and it must not be able to take the whole
    // client down with it. Every other member of bernard is unreachable if
    // this throws at load.
    if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
    var nodes = scope.querySelectorAll('[data-icon]:not([data-icon-done])');
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      var markup = icon(el.getAttribute('data-icon'), {
        size: el.getAttribute('data-icon-size') || undefined,
        title: el.getAttribute('data-icon-title') || undefined,
      });
      if (!markup) continue;
      el.innerHTML = markup;
      el.setAttribute('data-icon-done', '');
    }
    return nodes.length;
  }

  if (typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { hydrateIcons(); });
  } else {
    hydrateIcons();
  }

  window.bernard = bernard;
})();
`;
}

/**
 * Built once at module load.
 *
 * `build()` closes over nothing but module constants, so there is no runtime
 * input to memoize against — a `cached ??=` guard here was ceremony, and the
 * test that claimed to pin it could not: `toBe` on two strings is value
 * equality, so it passed identically with or without the cache.
 */
const SCRIPT = build();

export function appletSdkScript(): string {
  return SCRIPT;
}
