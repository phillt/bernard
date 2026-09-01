import { describe, it, expect } from 'vitest';
import { buildPreviewLines, plainLines, renderJsonValue } from '../overlays/preview-lines.js';

/** Every span's text on one line, as the renderer would paint it. */
const text = (lines: ReturnType<typeof plainLines>) =>
  lines.map((l) => l.map((s) => s.text).join(''));

describe('buildPreviewLines width fitting', () => {
  /**
   * The invariant the whole card rests on: one `RichLine` is one terminal row.
   * A line wider than the card wraps into two and desyncs the windowing, which
   * is the blank/overflowing-card class the redesign exists to fix.
   */
  const NARROW = 20;

  it('fits the `<tool>:` header to the width on the table path', () => {
    // A 40-character prefix is the longest the grammar accepts, and the card's
    // inner width can be far narrower on a small terminal.
    const prefix = 'a_very_long_mcp_tool_name_that_goes_on__';
    expect(prefix).toHaveLength(40);
    const content = `${prefix}: [{"id":1,"state":"open"},{"id":2,"state":"shut"}]`;
    for (const line of buildPreviewLines(content, NARROW)) {
      const width = line.map((s) => s.text).join('').length;
      expect(width).toBeLessThanOrEqual(NARROW);
    }
  });

  it('keeps every line inside the width on the pretty-printed fallback too', () => {
    // Nested objects are not tabular, so this takes the `plainLines` route —
    // which never had the bug, and must stay that way.
    const content = 'plan: {"action":"create","steps":{"a":1,"b":2}}';
    for (const line of buildPreviewLines(content, NARROW)) {
      expect(line.map((s) => s.text).join('').length).toBeLessThanOrEqual(NARROW);
    }
  });

  it('keeps the header readable when the width allows it', () => {
    const lines = text(buildPreviewLines('plan: [{"id":1},{"id":2}]', 60));
    expect(lines[0]).toContain('plan:');
  });

  it('leaves content with no JSON body as wrapped prose', () => {
    const lines = text(buildPreviewLines('just some prose, no json here', 60));
    expect(lines.join(' ')).toContain('just some prose');
  });
});

describe('renderJsonValue key column', () => {
  it('truncates an over-long key instead of letting it break the column', () => {
    // `padEnd` is a no-op past the column width, so the row that most needed
    // the alignment was the one that lost it — its value started late and every
    // other row's value no longer lined up with it.
    const rendered = renderJsonValue({
      a_key_far_longer_than_the_column: 1,
      b: 2,
    });
    const [first, second] = rendered.split('\n');
    expect(first.indexOf('1')).toBe(second.indexOf('2'));
  });

  it('aligns ordinary keys and renders null as null', () => {
    const rendered = renderJsonValue({ action: 'update', done: null });
    const [first, second] = rendered.split('\n');
    expect(first.indexOf('update')).toBe(second.indexOf('null'));
  });

  it('pretty-prints anything that is not a flat object', () => {
    expect(renderJsonValue({ a: { b: 1 } })).toContain('\n  ');
    expect(renderJsonValue([1, 2])).toBe('[\n  1,\n  2\n]');
  });
});
