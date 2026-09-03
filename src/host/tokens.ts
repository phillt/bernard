/**
 * The design tokens every applet is styled from (#424).
 *
 * **Served once from a route, never copied per applet.** A copy in each
 * `appletAssetDir` would re-create at applet scale exactly the drift this
 * exists to fix, and a generated applet is the last thing that can be trusted
 * to keep a copy in sync.
 *
 * The palette is lifted from `docs/*.html`, and the lift is narrower than #424
 * assumed. That issue says all four documents share a byte-identical `:root`;
 * measured, there are three variants. The **colours** are identical everywhere
 * — and `--accent` is the same orange as `bernard.accent` in `src/theme.ts`,
 * the one token already spanning the TUI and the web — but `--mono` has
 * drifted (`index.html` leads with `'JetBrains Mono'`, `home.html` does not)
 * and `index.html` carries a `--nav-height` the others lack.
 *
 * So only the colours are extracted. Typography and layout are per-document,
 * and promoting them to shared tokens would invent an agreement that never
 * existed. The drift itself is the argument: things repeated by hand drift,
 * which is why this is a served artifact rather than a paragraph in a prompt.
 */

/** Path the host serves the stylesheet from, inside its reserved namespace. */
export const TOKENS_PATH = '/__bernard/tokens.css';

/** The colour palette, as a plain record so a test can assert it against `theme.ts`. */
export const APPLET_COLOR_TOKENS: Record<string, string> = {
  '--bg': '#0d1117',
  '--surface': '#161b22',
  '--border': '#30363d',
  '--text': '#e6edf3',
  '--text-secondary': '#8b949e',
  '--accent': '#f97316',
  '--accent-dim': 'rgba(249, 115, 22, 0.15)',
};

/**
 * The stylesheet, tokens plus the handful of element rules that make an applet
 * look like one product without an author choosing anything.
 *
 * Deliberately small. This is a floor, not a framework: an applet that adds
 * nothing still looks right, and an applet that needs more writes its own CSS
 * against these variables rather than against hex values.
 */
/**
 * Built once, not per request.
 *
 * `APPLET_COLOR_TOKENS` is a module constant and the body is a literal, so the
 * result is the same string for the life of the process — and this route is hit
 * by every applet page load, on the request path.
 */
let cached: string | undefined;

export function tokensStylesheet(): string {
  return (cached ??= buildStylesheet());
}

function buildStylesheet(): string {
  const vars = Object.entries(APPLET_COLOR_TOKENS)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
  return `:root {
${vars}
  --radius: 6px;
  --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  --mono: 'SF Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  padding: 2rem 1rem;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.5 var(--sans);
}

main, .app { max-width: 42rem; margin: 0 auto; }

h1, h2, h3 { line-height: 1.25; margin: 0 0 0.5rem; }
p { margin: 0 0 1rem; }
.muted, .note { color: var(--text-secondary); font-size: 0.875rem; }
.error, .err { color: #f85149; }

label { display: block; margin-bottom: 0.75rem; }

input, textarea, select {
  width: 100%;
  padding: 0.5rem 0.625rem;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font: inherit;
}

input:focus, textarea:focus, select:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

button {
  padding: 0.5rem 1rem;
  background: var(--accent);
  color: #ffffff;
  border: 1px solid transparent;
  border-radius: var(--radius);
  font: inherit;
  cursor: pointer;
}

button:hover { filter: brightness(1.08); }
button:disabled { opacity: 0.5; cursor: default; }
button.secondary { background: var(--surface); color: var(--text); border-color: var(--border); }

pre, .output {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1rem;
  font-family: var(--mono);
  font-size: 0.875rem;
}

ul, ol { padding-left: 1.25rem; }
`;
}
