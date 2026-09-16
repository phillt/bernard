/**
 * @module ui/markdown
 *
 * Markdown → ANSI conversion for assistant prose. Pure module (no Ink
 * imports) so it's unit-testable: `renderMarkdown` feeds the accumulated
 * text through `marked` + `marked-terminal` themed from the active
 * `ThemeColors`, and `healStreamMarkdown` closes incomplete mid-stream
 * syntax (`**partial`, unterminated fences) via `remend` so streaming
 * never flashes raw delimiters.
 */

import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { Chalk, type ChalkInstance } from 'chalk';
import remend from 'remend';
import type { ThemeColors } from '../theme.js';

// Force ANSI output regardless of TTY detection — the rendered string is
// embedded in Ink <Text> nodes, which pass it through verbatim, and tests
// run without a TTY but still assert on escape codes.
const chalk = new Chalk({ level: 3 });

/** Named Ink/ANSI colors used by themes → chalk getters. */
const NAMED_COLORS: Record<string, ChalkInstance> = {
  black: chalk.black,
  red: chalk.red,
  green: chalk.green,
  yellow: chalk.yellow,
  blue: chalk.blue,
  magenta: chalk.magenta,
  cyan: chalk.cyan,
  white: chalk.white,
  gray: chalk.gray,
  grey: chalk.gray,
  blackBright: chalk.blackBright,
  redBright: chalk.redBright,
  greenBright: chalk.greenBright,
  yellowBright: chalk.yellowBright,
  blueBright: chalk.blueBright,
  magentaBright: chalk.magentaBright,
  cyanBright: chalk.cyanBright,
  whiteBright: chalk.whiteBright,
};

// Only the lengths chalk.hex() accepts (#rgb / #rrggbb) — a malformed theme
// value falls through to the named-color map / white fallback instead of
// reaching chalk with an invalid string.
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Map a `ThemeColors` value (hex string or named Ink color) to a chalk
 * styling function. Unknown names fall back to plain white rather than
 * throwing — a theme typo shouldn't break the transcript.
 */
export function normalizeColor(color: string): ChalkInstance {
  if (HEX_RE.test(color)) return chalk.hex(color);
  return NAMED_COLORS[color] ?? chalk.white;
}

/**
 * Columns a code block is indented by. Ours as well as marked-terminal's,
 * because the `code` renderer below reproduces the indent for the one case it
 * takes over — see there.
 */
const CODE_TAB = 2;

function buildTerminalOptions(
  colors: ThemeColors,
  width: number,
): Parameters<typeof markedTerminal>[0] {
  const accent = normalizeColor(colors.accent);
  const code = normalizeColor(colors.toolCall);
  const muted = normalizeColor(colors.muted);
  return {
    heading: accent.bold,
    firstHeading: accent.bold.underline,
    // marked-terminal applies `href` to the link TEXT and then wraps the result
    // in `link` (`Renderer.prototype.link`), so the two compose. Underlining in
    // both nests underline inside underline; measured in a real terminal, one
    // link opened underline three times and closed it twice, with the teardown
    // re-enabling it mid-close.
    //
    // Deleting `href` is NOT the fix, though it looks like one: marked-terminal
    // then falls back to its own `chalk.blue.underline`, which underlines just
    // the same AND hard-codes blue, losing the theme — the exact TTY-and-theme
    // blindness `normalizeColor` and the forced-level chalk above exist to
    // avoid. Measured, `FORCE_COLOR=3`: before 3 opens / 2 closes with the
    // accent kept; `href` deleted 3 / 2 with links blue; colour-only 1 / 1 with
    // the accent kept. So `href` carries the colour and `link` carries the
    // underline, and each attribute is applied exactly once.
    link: accent.underline,
    href: accent,
    code,
    codespan: code,
    blockquote: muted.italic,
    hr: muted,
    html: muted,
    strong: chalk.bold,
    em: chalk.italic,
    del: chalk.dim.strikethrough,
    listitem: chalk.reset,
    paragraph: chalk.reset,
    table: chalk.reset,
    width,
    reflowText: false, // Ink owns wrapping; width only sizes tables/rules
    tab: CODE_TAB,
    showSectionPrefix: false,
    emoji: false,
    unescape: true,
  };
}

// Lazily (re)built parser, invalidated on theme switch or terminal resize.
// `getThemeColors()` returns a stable reference per theme, so reference
// equality is a sufficient cache key.
let cachedParser: Marked | null = null;
let cachedColors: ThemeColors | null = null;
let cachedWidth = 0;

function getParser(colors: ThemeColors, width: number): Marked {
  if (cachedParser && cachedColors === colors && cachedWidth === width) {
    return cachedParser;
  }
  const parser = new Marked();
  parser.use(markedTerminal(buildTerminalOptions(colors, width)) as Parameters<Marked['use']>[0]);
  // marked-terminal@7's `text` renderer returns `token.text` raw and never
  // descends into `token.tokens`, so inline markdown inside tight list items
  // (which marked ≥12 wraps in a `text` token with inline children) renders
  // as literal `**bold**` / `[link](url)`. Layer a corrected renderer on
  // top: parse inline children when present, fall through (`false`) to
  // marked-terminal's renderer for plain text tokens.
  const accent = normalizeColor(colors.accent);
  const code = normalizeColor(colors.toolCall);
  parser.use({
    renderer: {
      text(token) {
        if ('tokens' in token && token.tokens?.length) {
          return this.parser.parseInline(token.tokens);
        }
        return false;
      },
      // Email autolinks (`<ken@example.com>`) otherwise echo a redundant
      // `(mailto:ken@example.com)` suffix via marked-terminal's link
      // renderer; show just the styled address.
      link(token) {
        if (token.href === `mailto:${token.text}`) {
          return accent.underline(token.text);
        }
        return false;
      },
      /**
       * A block that declares no language is not guessed at.
       *
       * marked-terminal hands every code block to `cli-highlight`, which does
       * `options.language ? hljs.highlight(...) : hljs.highlightAuto(...)` — so
       * an undeclared block is auto-detected, and English prose is duly
       * detected as source code. The reported symptom was an apostrophe turning
       * the rest of a paragraph red: `'` opens a string literal, and the span
       * runs to the next apostrophe or to the end of the block. Keywords go
       * blue in the same pass, which is the other half of the same tell.
       *
       * Reachable from ordinary prose, which is what makes it worth fixing
       * rather than a curiosity about code blocks: four spaces of indentation
       * IS an indented code block in markdown, so a drafted email with indented
       * paragraphs becomes one. A fenced block with no info string — shell
       * output, a log, a directory listing — lands here too.
       *
       * The block still renders AS a block, in the theme's code colour, which
       * is what marked-terminal's own error path falls back to (`style(code)`).
       * What is given up is only the guess. A declared language returns `false`
       * and keeps real highlighting, so ```ts is unaffected.
       *
       * Styled per line rather than once around the whole block: the transcript
       * is sliced into lines by `MarkdownLines`, and a span that opens on one
       * line and closes on another survives that only by accident. The indent
       * sits OUTSIDE the styling, where marked-terminal's own `indentify` puts
       * it, so nothing is painted into the left margin.
       */
      code(token) {
        if (token.lang !== undefined && token.lang !== '') return false;
        const pad = ' '.repeat(CODE_TAB);
        const body = token.text
          .split('\n')
          .map((line) => (line === '' ? '' : pad + code(line)))
          .join('\n');
        // `section()`'s trailing blank line, which every other block renderer
        // in marked-terminal emits and `renderMarkdown` trims off the end.
        return `${body}\n\n`;
      },
    },
  });
  cachedParser = parser;
  cachedColors = colors;
  cachedWidth = width;
  return parser;
}

// One-slot render cache: streaming re-renders fire on every store event,
// including tool-call/result events that leave the text unchanged — skip
// the re-parse (and the remend heal) in that common case.
let lastInput = '';
let lastWidth = 0;
let lastColors: ThemeColors | null = null;
let lastHeal = false;
let lastOutput = '';

/**
 * Render markdown to an ANSI-styled string themed from `colors`. Empty or
 * whitespace-only input passes through unchanged; trailing newlines that
 * marked-terminal appends per block are trimmed. `heal` runs the buffer
 * through {@link healStreamMarkdown} first (streaming path) — it lives
 * behind the cache check so a re-render with unchanged text skips both the
 * remend pass and the re-parse.
 */
export function renderMarkdown(
  text: string,
  width: number,
  colors: ThemeColors,
  heal = false,
): string {
  if (!text?.trim()) return text;
  if (text === lastInput && width === lastWidth && colors === lastColors && heal === lastHeal) {
    return lastOutput;
  }
  const source = heal ? healStreamMarkdown(text) : text;
  let output: string;
  try {
    output = (getParser(colors, width).parse(source) as string).trimEnd();
  } catch {
    // A parser failure should never take the transcript down — fall back
    // to the raw markdown text.
    output = text.trimEnd();
  }
  lastInput = text;
  lastWidth = width;
  lastColors = colors;
  lastHeal = heal;
  lastOutput = output;
  return output;
}

/**
 * Close incomplete markdown syntax in a mid-stream buffer (unterminated
 * bold/italic/code spans and fences) so partial text renders cleanly.
 */
export function healStreamMarkdown(text: string): string {
  if (!text) return text;
  try {
    return remend(text);
  } catch {
    return text;
  }
}
