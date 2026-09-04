import { MANIFEST_PATH } from '../host/webmanifest.js';
import { SDK_PATH } from '../host/sdk.js';
import { TOKENS_PATH } from '../host/tokens.js';
import { escapeXml } from '../text.js';
import type { RawAppAction } from './manifest.js';

/**
 * The page an applet gets when nobody writes one.
 *
 * Three jobs, and the first is what makes the validator usable at all: every
 * refusal `page-validate.ts` can raise now has a remedy the model reaches in
 * one call — `applet create` with no `page`. A gate with no door beside it is
 * an obstruction.
 *
 * Second, a manifest alone produces a working applet, which is the shape
 * `applet-detector.ts`'s suggestions actually want — a button per action, not
 * a design brief.
 *
 * Third, it is the fixture that keeps the validator honest: a test asserts the
 * template passes `validateAppletPage`, so the rule and the example cannot
 * disagree. That is the same anti-drift argument as serving the stylesheet
 * rather than copying it.
 *
 * Deliberately plain. It is a floor to build on and a thing that works today,
 * not a design — `applet-styler` is what makes an applet look considered.
 */
export function defaultAppletPage(
  name: string,
  description: string | undefined,
  actions: Record<string, RawAppAction>,
): string {
  const entries = Object.entries(actions);
  return `<title>${esc(name)}</title>
<link rel="stylesheet" href="${TOKENS_PATH}" />
<link rel="manifest" href="${MANIFEST_PATH}" />
<script src="${SDK_PATH}"></script>

<main>
  <h1>${esc(name)}</h1>
${description ? `  <p>${esc(description)}</p>\n` : ''}${entries.map(section).join('\n')}
  <pre id="out">Ready.</pre>
  <p id="bernard-error" class="error" role="alert"></p>
</main>

<script>
  async function run(action, inputs) {
    const out = document.getElementById('out');
    out.textContent = 'Working…';
    const args = {};
    for (const name of inputs) {
      const el = document.getElementById('arg-' + action + '-' + name);
      if (el && el.value !== '') args[name] = el.value;
    }
    try {
      const result = await bernard.invoke(action, args);
      out.textContent = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    } catch (err) {
      out.textContent = err.message;
    }
  }

${entries.map(wire).join('\n')}
</script>
`;
}

function section([action, spec]: [string, RawAppAction]): string {
  const args = Object.entries(spec.args ?? {});
  const fields = args
    .map(
      ([name, arg]) =>
        `    <label>${esc(name)} <input id="arg-${esc(action)}-${esc(name)}"${
          arg.type === 'number' ? ' type="number"' : ''
        } /></label>`,
    )
    .join('\n');
  return `  <section>
    <h2>${esc(action)}</h2>
${spec.description ? `    <p>${esc(spec.description)}</p>\n` : ''}${fields ? `${fields}\n` : ''}    <button id="run-${esc(action)}">Run</button>
  </section>`;
}

function wire([action, spec]: [string, RawAppAction]): string {
  const names = Object.keys(spec.args ?? {});
  return `  document
    .getElementById('run-${action}')
    .addEventListener('click', () => run('${action}', ${JSON.stringify(names)}));`;
}

/**
 * The manifest is user-editable, so a name reaches this untrusted.
 *
 * `escapeXml` plus the quote: unlike its other callers, values here land
 * inside double-quoted HTML attributes, where a bare quote breaks out of the
 * attribute. Only the extra escape is written here; the base three are not
 * retyped a third time.
 */
function esc(s: string): string {
  return escapeXml(s).replace(/"/g, '&quot;');
}
