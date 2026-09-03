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
  var FORBIDDEN_HELP = ${JSON.stringify(FORBIDDEN_HELP)};

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
        el.style.color = 'var(--danger, #f85149)';
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
    store: {
      get: function (key) { return storeOp('get', key); },
      set: function (key, value) { return storeOp('set', key, value); },
      list: function (prefix) { return storeOp('list', undefined, undefined, { prefix: prefix }); },
      delete: function (key) { return storeOp('delete', key); },
    },
  };

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
