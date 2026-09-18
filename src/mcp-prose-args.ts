/**
 * @module mcp-prose-args
 *
 * Which outbound MCP arguments are **prose a person will read**, and therefore
 * safe to fold to ASCII typography (#442).
 *
 * ## Why this exists
 *
 * The fold itself has existed since #mojibake: a Gmail MCP server wrote raw
 * UTF-8 into a `Subject:` header, where RFC 5322 requires US-ASCII, so a plain
 * em dash came back as `Ã¢Â€Â”` — and compounded, one generation per hop. That
 * server was fixed. The next one cannot be, so the deterministic defence is to
 * hand it nothing that can break.
 *
 * It shipped applied to EVERY argument of every MCP tool, and the review that
 * followed reversed the default with measurements rather than opinions. Against
 * the real `foldTypographyDeep`:
 *
 * ```
 * {"body":"{\"note\":\"a — b\",\"q\":\"“x”\"}"}  -> …"q":""x""}   no longer parses
 * {"content":"see ‹note› below"}               -> "see <note> below"
 * {"url":"https://ex.com/a–b?q=x"}             -> a DIFFERENT resource
 * {"path":"/home/u/Don’t Panic – notes.md"}    -> a different file
 * {"selector":"text=Sign in — it’s free"}      -> stops matching the page
 * {"pattern":"loading…$"}                      -> a literal becomes ANY three chars
 * ```
 *
 * The CLAUDE.md entry for `BERNARD_ASCII_OUTBOUND` names the way back:
 * *"A narrowing to prose-shaped arguments — per-tool opt-in, or driven by the
 * JSON-Schema description — would be the way to make it default-on again."*
 * This is that narrowing.
 *
 * ## The two gates, and why both are needed
 *
 * **1. The tool must EMIT.** {@link hasEmitVerb} is reused rather than a second
 * classification, and its own docstring is the argument: *"A message is sent, a
 * calendar event is created, a row is appended — each repeat is a new artefact
 * somebody receives."* That is exactly the population whose text lands in front
 * of a human through a transport we do not control. `write_file` and `edit_file`
 * carry write verbs and **not** emit verbs, so a filesystem server is ineligible
 * by construction — which is the fold's own stated exclusion principle
 * ("folding an em dash out of a document the user asked for is corruption")
 * enforced rather than merely written down.
 *
 * **2. The argument must be NAMED here.** An allowlist, so a new argument on a
 * new server is not folded until somebody declares it and says why. The failure
 * directions are wildly asymmetric: a miss costs one em dash in an email, a
 * false positive silently rewrites data. Fail-closed is the only defensible
 * default, and it is what makes adding a server a one-line, reviewable edit.
 *
 * ## And a value guard on top of both
 *
 * Even a declared prose argument can carry a machine value — an email body that
 * IS a JSON document, or that is nothing but a URL. Those are decidable from the
 * value in hand, so they are decided rather than assumed. {@link isProseValue}
 * is deliberately small: it answers the two cases measured above and does not
 * try to be clever about the rest.
 *
 * **Known limit, stated because it is the one thing this cannot see:** a URL
 * *embedded inside* prose is folded along with the prose around it. A path
 * segment containing an en dash would be rewritten. Nothing short of parsing the
 * body would catch that, and a body is prose by declaration.
 */
import { foldTypography } from './text.js';
import { hasEmitVerb, isReadOnlyMCPToolName } from './risk.js';

/** One declared prose argument. */
export interface ProseArg {
  /** The argument name as the server spells it, lower-cased. */
  readonly name: string;
  /** Why this argument carries prose a person reads. One line, per entry. */
  readonly why: string;
}

/**
 * The table. Every entry is an argument name that, on an emitting tool, carries
 * text a human will read in a client Bernard does not control.
 *
 * Short on purpose. Each addition is a decision about data somebody will later
 * find rewritten, so the bar is "a person reads this sentence", not "this looks
 * texty". Two names are deliberately ABSENT and worth naming so they are not
 * added by reflex:
 *
 *  - `content` — a filesystem server's `create_file(path, content)` carries an
 *    emit verb, and its `content` is a document, not prose. A Gmail server that
 *    calls its body `content` is therefore not covered; covering it needs a
 *    per-server declaration, which is the extension point rather than a wider
 *    name.
 *  - `title` / `name` — a page or file title is an identifier as often as it is
 *    a sentence, and it is what somebody later searches for.
 */
export const PROSE_ARGS: readonly ProseArg[] = [
  {
    name: 'subject',
    why: "an email subject line — #442's named symptom, and the RFC 5322 header that produced the original mojibake",
  },
  { name: 'body', why: 'the body of an email, message or post' },
  { name: 'text', why: "a chat message's text (`send_message` on beeper, Slack)" },
  { name: 'message', why: 'the same field under another name' },
  { name: 'description', why: 'a calendar event or issue description' },
  { name: 'summary', why: 'a calendar event title — RFC 5545 names it `summary`' },
];

const PROSE_ARG_NAMES: ReadonlySet<string> = new Set(PROSE_ARGS.map((a) => a.name));

/**
 * Whether this MCP tool is eligible at all.
 *
 * ANDed with the read test exactly as `ToolMeta.nonIdempotent` is, and for the
 * same reason `hasEmitVerb`'s docstring gives: `list_drafts` and `search_posts`
 * carry emit verbs and are lookups. A lookup has no outbound prose.
 */
export function emitsProse(rawToolName: string): boolean {
  return !isReadOnlyMCPToolName(rawToolName) && hasEmitVerb(rawToolName);
}

/**
 * Whether a declared prose argument's VALUE really is prose.
 *
 * Two refusals, both decidable and both measured as corruptions above:
 *
 *  - it parses as a JSON object or array — a document pasted into a body;
 *  - it is nothing but a URL — folding one addresses a different resource.
 *
 * A bare number or quoted string also "parses as JSON"; those are prose as far
 * as this matters, so only the two container forms refuse.
 */
export function isProseValue(v: string): boolean {
  const t = v.trim();
  if (t.length === 0) return true;
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      const parsed = JSON.parse(t);
      if (parsed !== null && typeof parsed === 'object') return false;
    } catch {
      // Not JSON after all — brace-quoted prose, a template, a code fragment.
      // Prose by declaration; the guard refuses only what it can prove.
    }
  }
  // Whole-value URL only. `includes` would refuse every body that mentions a
  // link, which is most of them, and the fold is the point.
  if (/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(t)) return false;
  return true;
}

/**
 * Folds typography in the declared prose arguments of one MCP tool call.
 *
 * Returns `args` **by identity** when the tool does not emit, so an ineligible
 * call costs one name classification and no allocation.
 *
 * Walks plain objects and arrays the way {@link foldTypographyDeep} does — same
 * prototype check, so a class instance passes through rather than being rebuilt
 * — but folds only at a key the table names, at any depth. Depth rather than top
 * level because servers nest (`{message: {subject, body}}`); the key is the gate
 * either way, so nesting widens coverage without widening what is folded.
 */
export function foldProseArgs(args: unknown, rawToolName: string): unknown {
  if (!emitsProse(rawToolName)) return args;
  return walk(args, false);
}

function walk(value: unknown, folding: boolean): unknown {
  if (typeof value === 'string') {
    return folding && isProseValue(value) ? foldTypography(value) : value;
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, folding));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = walk(v, PROSE_ARG_NAMES.has(k.toLowerCase()));
    }
    return out;
  }
  return value;
}
