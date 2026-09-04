/**
 * #464 — a URL rendered as `https://phone`, cut from
 * `https://phoneburner.zoom.us/my/philllt`, with the full URL intact in history.
 *
 * Its own file because the hyperlink branch has to be forced on before any
 * import reaches `supports-hyperlinks`, and `markdown.ts` additionally holds a
 * module-level parser cache and a one-slot render cache — so the isolation is
 * doing real work. See `_force-hyperlink.ts` for the mechanism and why it is a
 * module. Every existing markdown test runs non-TTY, where the branch is
 * unreachable — which is exactly why this shipped.
 *
 * The assertion has to go through the REAL Ink tree with the clip in place. The
 * markdown layer was never wrong: `renderMarkdown` returns the whole URL at
 * every width. The truncation is Ink's horizontal clip calling
 * `sliceAnsi(line, from, stringWidth(line))`, and `slice-ansi@7` mis-parses
 * OSC 8 — it reads at most 19 bytes looking for a terminating `m`, swallows the
 * escape's opening plus the first characters of the URL as "an ANSI code", and
 * counts the rest of the URL and the BEL as visible characters. A test at the
 * `renderMarkdown` level passes while the bug is fully present.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createElement } from 'react';
import type { CoreMessage } from 'ai';
// Static imports, and they must come FIRST — their env assignments run before
// the dynamic imports below reach `supports-hyperlinks` and construct chalk.
// Note `ink` and `strip-ansi` are dynamic for exactly that reason: importing
// `ink` statically pulls chalk in ahead of these lines, chalk caches its level
// at construction, and the colour half then silently does nothing. Measured —
// with `ink` static, the styling assertion below passes with `href` deleted,
// i.e. with the theme-loss defect fully present. Same ordering constraint
// `MenuRow.theme.test.tsx` follows.
//
// BOTH are needed, and colour is the less obvious one: marked-terminal styles
// links with its OWN chalk instance, which sits at level 0 under `vitest run`,
// so `href` emits nothing and the nesting is invisible.
import { restoreForceHyperlink } from './_force-hyperlink.js';
import { restoreForceColor } from './_force-color.js';

const { render } = await import('ink-testing-library');
const { Box, Text } = await import('ink');
const stripAnsi = (await import('strip-ansi')).default;
const { TranscriptViewport } = await import('../TranscriptViewport.js');
const { DimensionsProvider } = await import('../DimensionsContext.js');
const { renderMarkdown } = await import('../markdown.js');
const { getThemeColors } = await import('../../theme.js');
const { tick } = await import('./_keys.js');

const LINK = 'https://phoneburner.zoom.us/my/philllt';
const FRAME_ROWS = 12;

type ViewportProps = Parameters<typeof TranscriptViewport>[0];

function replyItem(text: string): ViewportProps['items'] {
  return [
    {
      key: 'k0',
      message: { role: 'assistant', content: text } as CoreMessage,
      toolDetails: false,
    },
  ];
}

function mountFramed(items: ViewportProps['items']) {
  return render(
    createElement(
      DimensionsProvider,
      null,
      createElement(
        Box,
        { flexDirection: 'column', height: FRAME_ROWS },
        createElement(TranscriptViewport, { items }),
        createElement(Text, null, 'CHROME'),
      ),
    ),
  );
}

describe('transcript hyperlinks (#464)', () => {
  afterAll(restoreForceHyperlink);
  afterAll(restoreForceColor);

  it('emits an OSC 8 hyperlink when the terminal supports one', () => {
    // Guards the mock itself. If this stops being true, the two tests below
    // pass for the wrong reason — exactly how the pre-existing suite behaved.
    const out = renderMarkdown(`Zoom: ${LINK}`, 80, getThemeColors());
    expect(out).toContain(']8;;');
  });

  it('renders a long URL whole inside the clipped viewport', async () => {
    const { lastFrame } = mountFramed(replyItem(`Zoom: ${LINK}`));
    await tick();
    // `stripAnsi` removes the OSC 8 target too, so what is left is what the
    // reader actually sees.
    expect(stripAnsi(lastFrame() ?? '')).toContain(LINK);
  });

  it('renders URLs of other lengths whole too', async () => {
    // The cut landed at a different point per URL — `https://example.com/x`
    // became `https://exa` — which is why it read as intermittent.
    for (const url of ['https://example.com/x', 'https://a.io/b/c/d/e/f/g']) {
      const { lastFrame } = mountFramed(replyItem(`Link: ${url}`));
      await tick();
      expect(stripAnsi(lastFrame() ?? '')).toContain(url);
    }
  });

  it('applies each link attribute exactly once, keeping the theme accent', () => {
    // marked-terminal applies `href` to the link text and then wraps the result
    // in `link`, so the two compose. Underlining in both nested underline inside
    // underline: 3 opens, 2 closes, with the teardown re-enabling it. Deleting
    // `href` does NOT fix it — marked-terminal falls back to its own
    // `chalk.blue.underline`: still underlined, and now ignoring the theme.
    const out = renderMarkdown(`Zoom: ${LINK}`, 80, getThemeColors());
    const codes = [...out.matchAll(/\[([0-9;]*)m/g)].map((m) => m[1]);
    expect(codes.filter((c) => c === '4')).toHaveLength(1);
    expect(codes.filter((c) => c === '24')).toHaveLength(1);
    // SGR 34 is chalk's blue — marked-terminal's default, i.e. the theme lost.
    expect(codes).not.toContain('34');
  });
});
