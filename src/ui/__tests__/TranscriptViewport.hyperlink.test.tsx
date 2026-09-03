/**
 * #464 — a URL rendered as `https://phone`, cut from
 * `https://phoneburner.zoom.us/my/philllt`, with the full URL intact in history.
 *
 * Its own file because `supports-hyperlinks` resolves `stdout` ONCE at module
 * load from `process.stdout`, so no in-test env change can reach it — the branch
 * has to be mocked, and a file-scoped mock keeps that out of every other
 * markdown test (`markdown.ts` also holds a module-level parser cache and a
 * one-slot render cache, so the isolation is doing real work). Every existing
 * markdown test runs non-TTY, where the hyperlink branch is unreachable — which
 * is exactly why this shipped.
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
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import stripAnsi from 'strip-ansi';
import { Box, Text } from 'ink';
import type { CoreMessage } from 'ai';

// Put the run in a terminal that supports hyperlinks — where the defect lives,
// and where no test has ever run.
//
// An env assignment rather than `vi.mock`: `marked-terminal` lives in
// node_modules and vitest externalises it, so it resolves `supports-hyperlinks`
// through Node and never sees a mock. `supports-hyperlinks` reads
// `FORCE_HYPERLINK` when it computes `stdout`, and it computes it ONCE at module
// load — so this has to run before the first import that reaches it. Static
// imports hoist above this line but none of them pull in `marked-terminal`; the
// dynamic imports below are ordinary statements and run after. Vitest isolates
// module registries per file (no `isolate: false` in vitest.config.ts), so this
// cannot leak into another file's parser.
process.env.FORCE_HYPERLINK = '1';

const { TranscriptViewport } = await import('../TranscriptViewport.js');
const { DimensionsProvider } = await import('../DimensionsContext.js');
const { renderMarkdown } = await import('../markdown.js');
const { getThemeColors } = await import('../../theme.js');
const { tick } = await import('./_keys.js');

const LINK = 'https://phoneburner.zoom.us/my/philllt';
const FRAME_ROWS = 12;

function replyItem(text: string) {
  return [
    {
      key: 'k0',
      message: { role: 'assistant', content: text } as CoreMessage,
      toolDetails: false,
    },
  ];
}

function mountFramed(items: ReturnType<typeof replyItem>) {
  return render(
    createElement(
      DimensionsProvider,
      null,
      createElement(
        Box,
        { flexDirection: 'column', height: FRAME_ROWS },
        createElement(TranscriptViewport, { items } as never),
        createElement(Text, null, 'CHROME'),
      ),
    ),
  );
}

describe('transcript hyperlinks (#464)', () => {
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

  it('styles a link with one underline, opened and closed once', () => {
    // marked-terminal applies `href` to the link text and then wraps the result
    // in `link`; setting both to the same style nested underline inside
    // underline and emitted a teardown that re-enabled it. Measured before:
    // opened 3, closed 2, 180 raw bytes for 44 visible columns.
    const out = renderMarkdown(`Zoom: ${LINK}`, 80, getThemeColors());
    const codes = [...out.matchAll(/\[([0-9;]*)m/g)].map((m) => m[1]);
    expect(codes.filter((c) => c === '4')).toHaveLength(1);
    expect(codes.filter((c) => c === '24')).toHaveLength(1);
  });

  it('still renders an email autolink without a mailto echo', () => {
    // The one link case that was already special-cased; it has to survive the
    // options change.
    const out = stripAnsi(
      renderMarkdown('- **Ken <ken@example.com>** wrote', 80, getThemeColors()),
    );
    expect(out).toContain('ken@example.com');
    expect(out).not.toContain('mailto:');
  });
});
