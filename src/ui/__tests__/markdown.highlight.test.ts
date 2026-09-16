/**
 * An apostrophe in prose turned the rest of the paragraph red (#447 follow-up).
 *
 * Reported as "a markdown leak when using `'`", and the apostrophe is the
 * symptom rather than the cause. marked-terminal hands every code block to
 * `cli-highlight`, which branches
 * `options.language ? hljs.highlight(...) : hljs.highlightAuto(...)` — so a
 * block that declares no language is AUTO-DETECTED, and English prose is duly
 * detected as source code. `'` then opens a string literal whose span runs to
 * the next apostrophe or to the end of the block, and keywords go blue in the
 * same pass.
 *
 * It reaches ordinary prose because four spaces of indentation IS an indented
 * code block in markdown: a drafted email with indented paragraphs becomes one.
 *
 * ## Why this is its own file, and why it needs colour forced
 *
 * `highlight()` in marked-terminal opens with `if (chalk.level === 0) return
 * code;` — its OWN chalk, which sits at level 0 under `vitest run`. So every
 * existing markdown test runs with the highlighter switched off entirely and is
 * structurally blind to this, which is exactly why it shipped.
 *
 * **And `_force-color.js` cannot switch it back on**, which is worth writing
 * down because that module's whole premise is that a module-level assignment is
 * early enough. It is, for chalk@5 — `ink` and `marked-terminal` both resolve
 * the top-level copy and evaluate their level lazily. `cli-highlight` resolves
 * a NESTED **chalk@4**, which caches its level when the module is first
 * required, and under vitest that happens before anything this file can do.
 * Measured: with `FORCE_COLOR` set by the module, `highlight(code, {language:
 * 'ts'})` returns the code bare; with it set in the SHELL, the same call
 * returns it coloured. So the highlighter is only observable from a test run
 * as `FORCE_COLOR=3 npx vitest`, and the assertions below are written to hold
 * either way rather than to pass vacuously in the ordinary one.
 *
 * What is asserted is therefore which RENDERER took the block, which is the
 * property the fix is about: our own styling uses `markdown.ts`'s forced
 * level-3 chalk and so is visible in both regimes, and no highlighter output
 * can be mistaken for it. The import is still static and FIRST, and
 * `markdown.ts` holds a module-level parser cache and a one-slot render cache,
 * so the isolation is doing real work. Same shape as
 * `TranscriptViewport.hyperlink.test.tsx`.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { restoreForceColor } from './_force-color.js';

const { renderMarkdown, normalizeColor } = await import('../markdown.js');
const { getThemeColors } = await import('../../theme.js');

afterAll(restoreForceColor);

const colors = getThemeColors();
/** The theme's code colour, derived rather than written down — the point is
 *  that a block wears ONE colour, not which one this theme picks. */
const [CODE_OPEN, CODE_CLOSE] = normalizeColor(colors.toolCall)('x').split('x');
/** Every block renderer in marked-terminal wraps its output in a reset. */
const RESET = '\u001b[0m';

const render = (md: string) => renderMarkdown(md, 80, colors);
/** Text with every SGR sequence removed. */
const bare = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');
/** Every SGR sequence in a rendered string, in order. */
const sgr = (s: string) => s.match(/\u001b\[[0-9;]*m/g) ?? [];

const PROSE = "The rate works for us, and that's what we'd like. She's sharp.";

describe('a code block that declares no language is not guessed at', () => {
  it('leaves indented prose in one colour, apostrophes and all', () => {
    // The reported frame: `that` white, `'s what we'` red, `for`/`and`/`like`
    // blue. Asserted as "one colour" rather than "not red", because the red is
    // one symptom of a guess that has several.
    const out = render(`Hi.\n\n    ${PROSE}`);
    const block = out.split('\n').slice(2).join('\n');
    expect(new Set(sgr(block))).toEqual(new Set([CODE_OPEN, CODE_CLOSE]));
    // The text itself survives intact — a highlighter that ate an apostrophe
    // would satisfy the colour assertion above.
    expect(bare(out)).toContain(PROSE);
    // And it still LOOKS like a block. Our renderer reproduces marked-terminal's
    // indent, and without it an undeclared block is prose in an odd colour.
    // Measured against a declared-language block rather than written down, so
    // the two cannot drift and `tab` stays configured in one place.
    const indent = /^ */.exec(bare(render('```ts\nx\n```')))![0];
    expect(indent.length).toBeGreaterThan(0);
    for (const line of bare(block)
      .split('\n')
      .filter((l) => l !== '')) {
      expect(line.startsWith(indent), line).toBe(true);
    }
  });

  it('does the same for a fence with no info string', () => {
    // Shell output, a log, a directory listing. The commoner shape, and the one
    // whose breakage reads as "the terminal is confused" rather than as ours.
    const out = render("```\nls -la\nit's fine\n```");
    expect(new Set(sgr(out))).toEqual(new Set([CODE_OPEN, CODE_CLOSE]));
  });

  it('leaves a block that declares one to the highlighter', () => {
    // Guard the guard, and the reason this is not simply "turn highlighting
    // off": widened to every block, the two assertions above would pass for the
    // wrong reason. The renderer declining is what is checked, not the colours
    // it declines to — see the chalk@4 note at the top for why the colours are
    // not observable here. Under `FORCE_COLOR=3 npx vitest` this block comes
    // back with keyword, type and number spans.
    const out = render('```ts\nconst x: number = 1;\n```');
    expect(out).not.toContain(CODE_OPEN);
    // Stripped, because when the highlighter IS live it interleaves spans
    // through this line — which is the whole point, and would make a raw
    // `toContain` fail under `FORCE_COLOR=3` while passing everywhere else.
    expect(bare(out)).toContain('const x: number = 1;');
  });

  it('leaves prose that is not in a block alone', () => {
    // The same sentence one indent to the left is a paragraph, and was never
    // affected — pinned so a later fix aimed at the apostrophe itself, rather
    // than at the guess, would be visible as the wrong fix.
    const out = render(PROSE);
    expect(sgr(out).every((c) => c === RESET)).toBe(true);
  });
});
