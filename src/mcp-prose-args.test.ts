import { describe, it, expect } from 'vitest';
import { PROSE_ARGS, emitsProse, foldProseArgs, isProseValue } from './mcp-prose-args.js';
import { hasEmitVerb, isReadOnlyMCPToolName } from './risk.js';

/**
 * One case: an argument sent to a tool, and what should reach the server.
 *
 * `folded === value` means "must cross untouched", which is the direction that
 * matters most — a false fold silently rewrites somebody's data, a missed fold
 * costs an em dash.
 */
interface Case {
  readonly tool: string;
  readonly arg: string;
  readonly value: string;
  readonly folded: string;
  readonly why: string;
}

const EM = '—';
const CURLY = '’';

const CASES: readonly Case[] = [
  // ── Every declared prose argument, on an emitting tool. ────────────────────
  {
    tool: 'send_email',
    arg: 'subject',
    value: `Daily Blaze ${EM} Wed 9/9`,
    folded: 'Daily Blaze - Wed 9/9',
    why: "#442's named symptom: an RFC 5322 header that requires US-ASCII",
  },
  {
    tool: 'send_email',
    arg: 'body',
    value: `Hi! Quick update ${EM} I got help over the phone`,
    folded: 'Hi! Quick update - I got help over the phone',
    why: "#442's quoted sent message, verbatim",
  },
  {
    tool: 'send_message',
    arg: 'text',
    value: `Hey babe, date night ${EM} 7pm?`,
    folded: 'Hey babe, date night - 7pm?',
    why: "beeper/Slack's name for a chat message",
  },
  {
    tool: 'post_comment',
    arg: 'message',
    value: `it${CURLY}s done`,
    folded: "it's done",
    why: 'the same field under another name',
  },
  {
    tool: 'create_event',
    arg: 'description',
    value: `Standup ${EM} daily`,
    folded: 'Standup - daily',
    why: 'a calendar event or issue description',
  },
  {
    tool: 'create_event',
    arg: 'summary',
    value: `Q4 review ${EM} draft`,
    folded: 'Q4 review - draft',
    why: 'RFC 5545 names a calendar event title `summary`',
  },

  // ── Every shape the blanket fold was measured to corrupt. ──────────────────
  // Sent to a tool that DOES emit, so the only thing refusing them is the table.
  {
    tool: 'send_email',
    arg: 'url',
    value: 'https://ex.com/a–b?q=x',
    folded: 'https://ex.com/a–b?q=x',
    why: 'a folded URL addresses a different resource',
  },
  {
    tool: 'send_email',
    arg: 'path',
    value: `/home/u/Don${CURLY}t Panic – notes.md`,
    folded: `/home/u/Don${CURLY}t Panic – notes.md`,
    why: 'a folded path names a different file',
  },
  {
    tool: 'send_email',
    arg: 'selector',
    value: `text=Sign in ${EM} it${CURLY}s free`,
    folded: `text=Sign in ${EM} it${CURLY}s free`,
    why: 'real page copy uses curly apostrophes; a folded selector stops matching',
  },
  {
    tool: 'send_email',
    arg: 'xpath',
    value: "//button[contains(., '…more')]",
    folded: "//button[contains(., '…more')]",
    why: 'same, through the other selector language',
  },
  {
    tool: 'send_email',
    arg: 'pattern',
    value: 'loading…$',
    folded: 'loading…$',
    why: 'a literal ellipsis would become "any three characters"',
  },
  {
    tool: 'send_email',
    arg: 'content',
    value: 'see ‹note› below',
    folded: 'see ‹note› below',
    why: 'a filesystem `create_file(path, content)` emits; its content is a document',
  },
  {
    tool: 'send_email',
    arg: 'title',
    value: `Q4 ${EM} plan`,
    folded: `Q4 ${EM} plan`,
    why: 'a page or file title is an identifier as often as a sentence',
  },

  // ── The value guard, inside a DECLARED prose argument. ─────────────────────
  {
    tool: 'send_email',
    arg: 'body',
    value: `{"note":"a ${EM} b","q":"“x”"}`,
    folded: `{"note":"a ${EM} b","q":"“x”"}`,
    why: 'a JSON document pasted into a body; folding the quotes stops it parsing',
  },
  {
    tool: 'send_message',
    arg: 'text',
    value: 'https://ex.com/a–b',
    folded: 'https://ex.com/a–b',
    why: 'a message that is nothing but a link',
  },

  // ── Ineligible TOOLS, with a declared prose argument. ──────────────────────
  {
    tool: 'write_file',
    arg: 'content',
    value: `a ${EM} b`,
    folded: `a ${EM} b`,
    why: '`write` is a write verb and not an emit verb: a filesystem server is ineligible',
  },
  {
    tool: 'get_message',
    arg: 'text',
    value: `a ${EM} b`,
    folded: `a ${EM} b`,
    why: 'a lookup has no outbound prose',
  },
  {
    tool: 'list_drafts',
    arg: 'subject',
    value: `a ${EM} b`,
    folded: `a ${EM} b`,
    why: 'carries an emit verb AND is a lookup — the reason `hasEmitVerb` is ANDed',
  },
  {
    tool: 'browser_click',
    arg: 'text',
    value: `Sign in ${EM} free`,
    folded: `Sign in ${EM} free`,
    why: 'neither verb, so not an emit; a click sends nobody a message',
  },
];

const FOLDING = CASES.filter((c) => c.folded !== c.value);
const PROSE_NAMES = new Set(PROSE_ARGS.map((a) => a.name));

describe('the prose-argument table decides what an outbound MCP fold touches (#442)', () => {
  it.each(CASES)('$tool($arg): $why', ({ tool, arg, value, folded }) => {
    expect(foldProseArgs({ [arg]: value }, tool)).toEqual({ [arg]: folded });
  });

  // ── The two anti-drift directions. ────────────────────────────────────────

  it('names every declared prose argument in a folding case', () => {
    // Record → cases. An entry added to the table with no case is an argument
    // nobody decided was safe to rewrite, which is the whole thing this table
    // exists to make deliberate.
    const covered = new Set(FOLDING.map((c) => c.arg));
    expect([...PROSE_NAMES].filter((n) => !covered.has(n))).toEqual([]);
  });

  it('folds nothing the table does not declare', () => {
    // Cases → record. A case asserting a fold for an undeclared argument means
    // the behaviour and the table disagree, which is the direction the mistake
    // is made in: someone widens `walk` and writes a case to match.
    expect(FOLDING.filter((c) => !PROSE_NAMES.has(c.arg)).map((c) => c.arg)).toEqual([]);
  });

  it('keeps the measured hazards out of the table', () => {
    // The refusal is by omission, so nothing in the code says these names are
    // dangerous. This does. Each is a shape the blanket fold was measured to
    // corrupt, and each looks texty enough to be added by reflex.
    const NEVER = ['url', 'path', 'selector', 'xpath', 'pattern', 'query', 'content', 'title'];
    expect(NEVER.filter((n) => PROSE_NAMES.has(n))).toEqual([]);
  });

  it('gives every entry a stated reason', () => {
    expect(PROSE_ARGS.filter((a) => a.why.trim().length === 0)).toEqual([]);
  });
});

describe('eligibility', () => {
  it('returns args by identity for an ineligible tool', () => {
    // Not merely equal: an ineligible call must cost one name classification and
    // no allocation, which is what makes default-on affordable on every call.
    const args = { subject: `a ${EM} b` };
    expect(foldProseArgs(args, 'get_message')).toBe(args);
  });

  it('a foldable tool is never retried, and that is one predicate not two', () => {
    // `emitsProse` and `ToolMeta.nonIdempotent` are both `!isRead &&
    // hasEmitVerb`, because they are the same question: does this put an
    // artefact in front of a person. The coincidence has a consequence —
    // `mcp.ts`'s reconnect retry can never see a folded argument — and
    // `mcp.test.ts` explains an absent test by it. Pinned here so a divergence
    // fails rather than silently reopening that gap.
    //
    // **It holds for the NAME path only, and since #570 that is a real
    // restriction rather than a formality.** A server declaring
    // `readOnlyHint: false` with `idempotentHint: true` on a name carrying an
    // emit verb makes `nonIdempotent` false while `emitsProse` stays true, so
    // such a call really can be folded and then retried. It is harmless because
    // the retry re-sends `outbound` rather than `args` — the line `mcp.test.ts`
    // calls "deliberate, should the predicates ever diverge", which is now live
    // rather than hypothetical.
    //
    // **The fixture list is the whole test, and the first draft's was inert.**
    // This recomputes the expression inline, so it can only fail on a name where
    // the two halves DISAGREE — and `send_email` / `create_event` are true under
    // either conjunct while `get_message` / `write_file` / `focus_app` are false
    // under either, so dropping `!isRead` entirely passed all five. Measured.
    //
    // A discriminator exists because `EMIT_VERBS` is not a subset of
    // `WRITE_VERBS`: `email` emits without writing, and is the last one that
    // does — `publish`, `submit`, `invite` and `notify` were in this sentence
    // and became write verbs in #612, which changes nothing here but is why
    // `email` now carries the case alone. `get_email` is therefore a READ that
    // carries an emit verb — conjunction false, `hasEmitVerb` alone true — so
    // under that mutation it becomes foldable and `search_email({subject})` has
    // its SEARCH TERM rewritten. `search_email` is here as well because it is
    // the shape where the harm is legible rather than merely possible.
    for (const name of [
      'send_email',
      'create_event',
      'get_message',
      'write_file',
      'focus_app',
      'get_email',
      'search_email',
    ]) {
      expect(emitsProse(name), name).toBe(!isReadOnlyMCPToolName(name) && hasEmitVerb(name));
    }
  });

  it('refuses a read that happens to carry an emit verb', () => {
    // The conjunct the loop above exists to protect, stated as a fact about the
    // function rather than as an identity between two expressions — so it fails
    // even if somebody "simplifies" both sides of that comparison together.
    expect(emitsProse('get_email')).toBe(false);
    expect(emitsProse('search_email')).toBe(false);
    expect(foldProseArgs({ subject: `a ${EM} b` }, 'search_email')).toEqual({
      subject: `a ${EM} b`,
    });
  });

  it('takes the caller’s read verdict over the name when it has one', () => {
    // Since #570 `mcp.ts` can decide `isRead` from the server's own
    // `readOnlyHint`, and it hands that verdict down rather than letting this
    // module re-derive it. Without the hand-off, a server declaring a tool
    // read-only would still have its `subject` folded, which is the harm the
    // conjunct above exists to prevent with the annotation ignored.
    const args = { subject: `a ${EM} b` };
    expect(emitsProse('send_report')).toBe(true);
    expect(emitsProse('send_report', true)).toBe(false);
    expect(foldProseArgs(args, 'send_report', true)).toBe(args);
    // The inverse: a declared WRITE on a name that reads, which the name alone
    // would have exempted.
    expect(emitsProse('list_invitations')).toBe(false);
    expect(emitsProse('list_invitations', false)).toBe(false);
    // Omitting it is the status quo for every caller with no annotation.
    expect(emitsProse('send_message', undefined)).toBe(emitsProse('send_message'));
  });
});

describe('the value guard', () => {
  it.each([
    ['plain prose', `a ${EM} b`, true],
    ['empty', '', true],
    ['a JSON object', '{"a":1}', false],
    ['a JSON array', '[1,2]', false],
    ['a whole-value URL', 'https://ex.com/x', false],
    ['a URL mentioned inside prose', `see https://ex.com/x ${EM} it works`, true],
    ['brace-quoted prose that is not JSON', '{not json at all}', true],
    ['a quoted string, which is valid JSON', '"hello"', true],
    ['a bare number, which is valid JSON', '42', true],
  ])('%s', (_label, value, expected) => {
    expect(isProseValue(value as string)).toBe(expected);
  });
});

describe('the walk', () => {
  it('folds a declared name at any depth', () => {
    // Servers nest (`{message: {subject, body}}`). The key is the gate either
    // way, so depth widens coverage without widening what is folded.
    expect(foldProseArgs({ message: { subject: `a ${EM} b` } }, 'send_email')).toEqual({
      message: { subject: 'a - b' },
    });
  });

  it('does not inherit foldability into a nested non-prose key', () => {
    // `body: {html}` must not fold `html` just because `body` is declared.
    expect(foldProseArgs({ body: { html: `<p>a ${EM} b</p>` } }, 'send_email')).toEqual({
      body: { html: `<p>a ${EM} b</p>` },
    });
  });

  it('folds through an array under a declared name', () => {
    expect(foldProseArgs({ text: [`a ${EM} b`] }, 'send_message')).toEqual({ text: ['a - b'] });
  });

  it('matches the argument name case-insensitively', () => {
    expect(foldProseArgs({ Subject: `a ${EM} b` }, 'send_email')).toEqual({ Subject: 'a - b' });
  });

  it('passes a class instance through rather than rebuilding it as a bare object', () => {
    // The same prototype check `foldTypographyDeep` and `normalizeToolResult`
    // make, for the same reason.
    class Opaque {
      readonly subject = `a ${EM} b`;
    }
    const args = { payload: new Opaque() };
    const out = foldProseArgs(args, 'send_email') as { payload: unknown };
    expect(out.payload).toBeInstanceOf(Opaque);
  });

  it('leaves non-string values alone', () => {
    expect(foldProseArgs({ subject: 42, body: null }, 'send_email')).toEqual({
      subject: 42,
      body: null,
    });
  });
});
