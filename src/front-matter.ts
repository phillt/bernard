/**
 * Front matter, without a YAML parser.
 *
 * Three or four known keys, one line each, no nesting — the argument
 * `docs-store.ts` made first and `page-validate.ts` makes for not growing an
 * HTML parser: a dependency here would be carried by every worker dispatch to
 * read a handful of strings. There is no YAML parser in `package.json` and this
 * is the house answer to that.
 *
 * A leaf with no imports at all, because both consumers are `node:fs`-level
 * modules and neither should acquire the other's graph. `memory.ts` is imported
 * almost everywhere including worker dispatches; `docs-store.ts` reaches
 * `docs-generated.ts` and from there `host/tokens`, `host/ui-runtime`,
 * `apps/brief` and `ui/slash-commands`. Copying the parser was the alternative
 * considered and rejected — this repo's own third option is a pure leaf, which
 * is what `tool-bytes.ts`, `mcp-names.ts`, `token-estimate.ts` and
 * `headless-posture.ts` all are.
 *
 * **The copies had already drifted, which is the evidence rather than the
 * theory.** `docs-store.parseDoc` matched field names with `/^([a-z]+):/` —
 * lowercase only — so a camelCase key in a doc's front matter was silently
 * dropped, while the memory parser needed `writtenAt` and `supersededBy` and so
 * used `[a-zA-Z]+`. One shared `[a-zA-Z]+` is a strict superset and fixes the
 * doc side for free.
 *
 * What is deliberately NOT shared is policy. Each caller decides what a missing
 * or unrecognised field means, and the two answer differently on purpose:
 * `parseDoc` returns `null` and its callers drop the doc, while a memory file
 * is the user's and cannot be dropped, so an unrecognised fence is treated as
 * body.
 */

/** The fence's parsed fields plus the body that follows it. */
export interface FrontMatter {
  fields: Record<string, string>;
  /** Everything after the closing fence, untouched — no trim, no reflow. */
  body: string;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const FIELD = /^([a-zA-Z]+):\s*(.*)$/;

/**
 * How a field's value is read: trimmed, with one layer of surrounding quotes
 * removed.
 *
 * **Exported so a WRITER can apply the same rule.** It was private, and the
 * asymmetry that created was a real defect: `memory.ts` serialized a raw key
 * verbatim and compared the incoming key verbatim, while the read side stripped
 * quotes — so a key of `"foo"` was written as `key: "foo"`, read back as `foo`,
 * and every later rewrite of that same key raised a collision against itself.
 * The record became permanently un-rewritable, and the model's only escape was
 * to invent a second key — creating exactly the duplicate the collision check
 * exists to prevent.
 *
 * A writer that normalizes before serializing cannot drift from the reader,
 * which is why this is one function rather than a rule stated twice.
 */
export function normalizeFrontMatterValue(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, '');
}

/**
 * Splits a leading `---` fence off a source string.
 *
 * Returns `null` when there is no fence at all, which is distinct from a fence
 * carrying nothing recognisable — the caller decides what to do with that.
 *
 * The body is `source.slice(match[0].length)` with nothing else done to it, for
 * the reason `docs-store` gives: whatever a test asserts round-trips must be
 * what a model receives.
 */
export function splitFrontMatter(source: string): FrontMatter | null {
  const match = FENCE.exec(source);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = FIELD.exec(line.trim());
    if (kv) fields[kv[1]] = normalizeFrontMatterValue(kv[2]);
  }
  return { fields, body: source.slice(match[0].length) };
}
