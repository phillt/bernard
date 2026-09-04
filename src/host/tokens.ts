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
  // Raised from `#30363d`, which was 1.55:1 on `--bg` and 1.42:1 on
  // `--surface` against WCAG 1.4.11's 3:1 for a non-text UI boundary (#465).
  // A border is how an input's edge is conveyed, so this was the one token
  // that was not merely thin but wrong. Now 4.12 / 3.77.
  '--border': '#6e7681',
  '--text': '#e6edf3',
  '--text-secondary': '#8b949e',
  '--accent': '#f97316',
  '--accent-dim': 'rgba(249, 115, 22, 0.15)',
  /**
   * Text on a solid fill.
   *
   * `#ffffff` on `--accent` was **2.80:1** — failing AA normal text and even
   * the 3:1 large-text floor, on the most-clicked element of every applet.
   * This is 6.75 on accent and clears 4.5 on all four state fills too, which
   * is why there are no per-state companions.
   *
   * **A literal, deliberately never `var(--bg)`.** They are the same value
   * today and different roles: aliasing them would flip button text to
   * near-white on orange the moment a light-mode block changed `--bg` — a
   * 2.1:1 regression from an edit that looks unrelated.
   */
  '--accent-fg': '#0d1117',
  // The four states are equiluminant against `--bg` (7.45-7.51, a spread of
  // 0.06) so no state shouts louder than another. That is a decision, not a
  // coincidence — and it is why a checker can hold them to one threshold.
  '--danger': '#ff7b72',
  '--success': '#3fb950',
  '--warning': '#d29922',
  '--info': '#58a6ff',
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

  /* 4px base. Every step but \`--space-1\` is consumed by a rule below; that one
     and \`--text-xs\` are the two ends the floor never reaches for, kept so an
     author is not pushed off the scale at its edges. Naming them is the point —
     a scale whose steps nobody can account for is a framework, which this
     is not. */
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.5rem;
  --space-6: 2rem;

  /* 1.25 major third from a 16px root. \`--text-sm\` is the 0.875rem that was
     already hard-coded twice, in \`.muted\` and \`pre\`. */
  --text-xs: 0.75rem;
  --text-sm: 0.875rem;
  --text-base: 1rem;
  --text-lg: 1.25rem;
  --text-xl: 1.5rem;
  --text-2xl: 2rem;

  --leading-tight: 1.25;
  --leading-body: 1.5;

  /* Tells the browser which scheme its own widgets should paint in. Without
     it, native scrollbars, \`<select>\` popups and date pickers render
     light-on-dark. Becomes \`light dark\` when a light palette lands. */
  color-scheme: dark;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  padding: var(--space-6) var(--space-4);
  background: var(--bg);
  color: var(--text);
  font: var(--text-base)/var(--leading-body) var(--sans);
}

main, .app { max-width: 42rem; margin: 0 auto; }

h1, h2, h3 { line-height: var(--leading-tight); margin: 0 0 var(--space-2); }
/* Explicit sizes: these inherited UA defaults, which is much of why two
   applets did not read as siblings. */
h1 { font-size: var(--text-2xl); }
h2 { font-size: var(--text-xl); }
h3 { font-size: var(--text-lg); }
p { margin: 0 0 var(--space-4); }
/* One \`<section>\` per action is what \`page-template.ts\` emits, so this is the
   rhythm the scaffold has been missing. */
section + section { margin-top: var(--space-5); }
.muted, .note { color: var(--text-secondary); font-size: var(--text-sm); }
.error, .err { color: var(--danger); }
.success { color: var(--success); }
.warning { color: var(--warning); }
.info { color: var(--info); }

label { display: block; margin-bottom: var(--space-3); }

input, textarea, select {
  width: 100%;
  padding: var(--space-2) 0.625rem;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font: inherit;
}

/* Global, and \`:focus-visible\` rather than \`:focus\`: buttons had no focus
   ring at all before this, and keyboard focus was indistinguishable from
   mouse focus. The ring is \`--accent\`, 6.75 on the page, well over the 3:1
   that 1.4.11 asks of a focus indicator. */
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
:focus:not(:focus-visible) { outline: none; }

button {
  padding: var(--space-2) var(--space-4);
  /* 36px, over the 24px WCAG 2.2 SC 2.5.8 asks of a target. */
  min-height: 2.25rem;
  background: var(--accent);
  color: var(--accent-fg);
  border: 1px solid transparent;
  border-radius: var(--radius);
  font: inherit;
  cursor: pointer;
}

button:hover { filter: brightness(1.08); }
button:disabled { opacity: 0.5; cursor: default; }
button.secondary { background: var(--surface); color: var(--text); border-color: var(--border); }
button.danger { background: var(--danger); color: var(--accent-fg); }

/* No border, deliberately — this is what pays for the heavier \`--border\`.
   A \`pre\` is delimited by its own fill, so 1.4.11 does not apply to it, and
   dropping the line here leaves the strong border only on inputs and
   \`button.secondary\` — exactly where 3:1 is required. One honest border
   token beats a second "decorative divider" one a checker could not police. */
pre, .output {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--surface);
  border-radius: var(--radius);
  padding: var(--space-4);
  font-family: var(--mono);
  font-size: var(--text-sm);
}

ul, ol { padding-left: 1.25rem; }

/* The floor has no motion. It is served anyway because an applet's own \`.css\`
   is where motion appears, and that file is the one thing nobody reviews. */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
`;
}
