import stringWidth from 'string-width';

/**
 * Why a bordered panel's title may not contain an emoji glyph.
 *
 * ## The defect
 *
 * A `<Box borderStyle>` whose text contains `⏰`, `✉`, `⚠`, `⏹`, `✔`, `⚙` or `ℹ`
 * renders **one column wider than every other row in the box**, so the right
 * border wraps and the corner is lost. Measured on Ink 5.2.1: a 40-column box
 * emits a 41-column header row.
 *
 * It is invisible until the box reaches the terminal's full width — below that
 * the extra column is absorbed by slack — which is why all three panels carried
 * it from the day they were written and it surfaced only when a long
 * instruction pushed one to the edge.
 *
 * ## Why these characters and not others
 *
 * Measured across the family rather than inferred:
 *
 * | glyph | units | string-width | `\p{Emoji}` | frame |
 * |-------|-------|--------------|-------------|-------|
 * | `⏰` `✉` `⚠` `⏹` `✔` `⚙` `ℹ` | 1 | 2 | yes | **broken** |
 * | `漢` `字` `ア` `한`           | 1 | 2 | no  | fine |
 * | `😀`                          | 2 | 2 | yes | fine |
 * | `A` `✓` `→` `·` `»` `◷` `▲`   | 1 | 1 | no  | fine |
 *
 * So it is neither "wide characters" nor `.length` — CJK is two columns and one
 * code unit and lays out correctly. It is the legacy symbols Unicode also
 * classifies as emoji, whose width depends on a **presentation** choice that
 * Ink and the terminal make independently.
 *
 * `\p{Emoji_Presentation}` is NOT the discriminator, and looks like it should
 * be: it is **false** for `✉` and `⚠`, which default to text presentation and
 * break anyway.
 *
 * ## Why this is a predicate and not a repair
 *
 * The first fix appended U+FE0E (text presentation) to make Ink's two measures
 * agree, and it did — every row measured correct. **It made the frame worse on a
 * real terminal.** VTE honours the selector by drawing the glyph in ONE column
 * while Ink still allocates two, so the header came out one column SHORT and the
 * border broke the other way. Both halves were "measured"; only one of them
 * measured the thing that matters, which is what the terminal paints.
 *
 * There is no repair available, because the disagreement is not ours to settle:
 * two independent programs are choosing a width for the same character and we
 * control neither. What we control is whether a character with a presentation
 * choice appears in a frame at all. So the rule is a refusal, enforced by a test
 * over the panels rather than by a transformation that hides the problem:
 * **a bordered title uses glyphs no one can disagree about** — one code unit,
 * `string-width` 1, not emoji.
 *
 * Containment does not help either, and each was measured: `width="100%"`,
 * `flexGrow`, `wrap="truncate"` and a fixed-width icon cell all still emit 41 in
 * a 40 box. `PlanPanel`'s fixed icon cell therefore buys column ALIGNMENT, not
 * frame width; its comment is about locales and should not be read as a defence
 * against this.
 */

// Module-scoped and NOT `/g`: a global regex carries `lastIndex` between
// `.test()` calls, so alternate characters would silently escape the rule.
const EMOJI = /\p{Emoji}/u;

/**
 * True when a terminal and Ink can disagree about how many columns `ch` takes.
 *
 * All three conditions are load-bearing. A surrogate pair (`😀`) lays out
 * correctly and is excluded by the first; a width-1 glyph has nothing to
 * disagree about and is excluded by the second; and CJK is two columns with no
 * presentation choice, excluded by the third — a rule without it would flag
 * every ideograph and there would be nothing to replace them with.
 */
export function hasPresentationChoice(ch: string): boolean {
  return ch.length === 1 && stringWidth(ch) === 2 && EMOJI.test(ch);
}

/** Every such glyph in `s`, for a test to name what it is refusing. */
export function presentationAmbiguousGlyphs(s: string): string[] {
  // Iterated by code POINT, so a surrogate pair arrives whole and its
  // `.length === 2` correctly excludes it.
  return [...s].filter(hasPresentationChoice);
}
