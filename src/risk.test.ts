import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ToolMeta } from './framework/tools/types.js';
import {
  classifyMCPTool,
  hasEmitVerb,
  isReadOnlyMCPToolName,
  riskFromMeta,
  shouldBlockInReadOnly,
  shouldConfirm,
} from './risk.js';

describe('isReadOnlyMCPToolName', () => {
  it.each([
    'gmail_search',
    'gmail_list',
    'contacts_find',
    'calendar_get',
    'drive_query',
    'drive_read',
    'contacts_lookup',
    'SEARCH',
    'people_Lookup',
  ])('treats %s as read-only', (name) => {
    expect(isReadOnlyMCPToolName(name)).toBe(true);
  });

  it.each([
    'gmail_send',
    'gmail_create_draft',
    'calendar_update',
    'drive_upload',
    'contacts_delete',
    'searching', // suffix must be a full word, not substring
    'reader', // ditto — `read` is not a suffix here
  ])('treats %s as write/unknown', (name) => {
    expect(isReadOnlyMCPToolName(name)).toBe(false);
  });
});

describe('riskFromMeta', () => {
  const meta = (m: Partial<ToolMeta>): ToolMeta => ({
    name: 't',
    kind: 'read',
    deterministic: true,
    sideEffect: 'none',
    cacheable: false,
    ...m,
  });

  /**
   * The full precedence, stated once (#456).
   *
   * Written as one test rather than spread across the cases below because the
   * ORDER is the contract: `riskForCall` was added between two existing
   * branches, and the two facts most likely to be broken by a later edit —
   * that a static `risk` still beats it, and that it sits above the
   * downgrade-only predicate — are invisible unless they are asserted
   * together.
   */
  it('resolves in the order: meta.risk > riskForCall > isWriteAction > kind', () => {
    const del = { action: 'delete' };
    const raise = () => 'high' as const;

    // 2. `riskForCall` raises a tool the static rules would call `medium`...
    expect(
      riskFromMeta(meta({ kind: 'write', sideEffect: 'local', riskForCall: raise }), del),
    ).toBe('high');
    // 1. ...but a whole-tool `risk` is the more deliberate statement and wins.
    expect(
      riskFromMeta(
        meta({ kind: 'write', sideEffect: 'local', risk: 'low', riskForCall: raise }),
        del,
      ),
    ).toBe('low');
    // 3. `riskForCall` beats the downgrade: a statement about THIS call beats
    //    the generic "this shape of call is a read".
    expect(
      riskFromMeta(
        meta({
          kind: 'write',
          sideEffect: 'local',
          riskForCall: raise,
          isWriteAction: () => false,
        }),
        del,
      ),
    ).toBe('high');
    // 4. `null` defers, leaving every rule below untouched.
    expect(
      riskFromMeta(meta({ kind: 'write', sideEffect: 'local', riskForCall: () => null }), del),
    ).toBe('medium');
    // Guarded on args exactly as `isWriteAction` is, so a metadata-only call
    // never invokes it.
    expect(riskFromMeta(meta({ kind: 'write', sideEffect: 'local', riskForCall: raise }))).toBe(
      'medium',
    );
  });

  /**
   * The gap #456 exists to close, pinned so it cannot silently reopen: before
   * `riskForCall` NOTHING could raise a `write` + `local` tool above `medium`
   * for one call, and `medium` does not prompt under the default
   * `confirmMode: 'auto'` (threshold `high`).
   */
  it('has exactly one per-call way to raise, and it is riskForCall', () => {
    const base: Partial<ToolMeta> = { kind: 'write', sideEffect: 'local' };
    const del = { action: 'delete' };
    expect(riskFromMeta(meta(base), del)).toBe('medium');
    // The other per-call hook can only ever lower.
    expect(riskFromMeta(meta({ ...base, isWriteAction: () => true }), del)).toBe('medium');
    expect(riskFromMeta(meta({ ...base, isWriteAction: () => false }), del)).toBe('low');
    expect(riskFromMeta(meta({ ...base, riskForCall: () => 'high' }), del)).toBe('high');
  });

  it('defaults missing metadata to medium', () => {
    expect(riskFromMeta(undefined)).toBe('medium');
  });

  it('honors explicit meta.risk override', () => {
    expect(riskFromMeta(meta({ kind: 'read', risk: 'high' }))).toBe('high');
    expect(riskFromMeta(meta({ kind: 'dangerous', risk: 'low' }))).toBe('low');
  });

  it('maps dangerous → high', () => {
    expect(riskFromMeta(meta({ kind: 'dangerous', sideEffect: 'local' }))).toBe('high');
  });

  it('maps read/inert → low', () => {
    expect(riskFromMeta(meta({ kind: 'read' }))).toBe('low');
    expect(riskFromMeta(meta({ kind: 'inert' }))).toBe('low');
  });

  it('maps write + external-api → high', () => {
    expect(riskFromMeta(meta({ kind: 'write', sideEffect: 'external-api' }))).toBe('high');
  });

  it('maps write + local/network → medium', () => {
    expect(riskFromMeta(meta({ kind: 'write', sideEffect: 'local' }))).toBe('medium');
    expect(riskFromMeta(meta({ kind: 'write', sideEffect: 'network' }))).toBe('medium');
    expect(riskFromMeta(meta({ kind: 'write', sideEffect: 'none' }))).toBe('medium');
  });

  it('isWriteAction predicate downgrades reads on discriminator tools to low', () => {
    const m = meta({
      kind: 'write',
      sideEffect: 'local',
      isWriteAction: (args) =>
        (args as { action?: string } | undefined)?.action !== 'read' &&
        (args as { action?: string } | undefined)?.action !== 'list',
    });
    expect(riskFromMeta(m, { action: 'read' })).toBe('low');
    expect(riskFromMeta(m, { action: 'list' })).toBe('low');
    expect(riskFromMeta(m, { action: 'write' })).toBe('medium');
  });

  it('isWriteAction downgrades read-shaped calls on dangerous-kind tools (#212)', () => {
    const m = meta({
      kind: 'dangerous',
      sideEffect: 'local',
      isWriteAction: (args) => (args as { command?: string } | undefined)?.command !== 'ls',
    });
    expect(riskFromMeta(m, { command: 'ls' })).toBe('low');
    expect(riskFromMeta(m, { command: 'rm -rf /' })).toBe('high');
    // Without args the predicate is skipped — static kind wins.
    expect(riskFromMeta(m)).toBe('high');
  });
});

describe('shouldConfirm', () => {
  it('never threshold never confirms', () => {
    for (const risk of ['low', 'medium', 'high'] as const) {
      expect(shouldConfirm(risk, 'never')).toBe(false);
    }
  });

  it('undefined threshold never confirms', () => {
    expect(shouldConfirm('high', undefined)).toBe(false);
  });

  it('high threshold confirms only high', () => {
    expect(shouldConfirm('low', 'high')).toBe(false);
    expect(shouldConfirm('medium', 'high')).toBe(false);
    expect(shouldConfirm('high', 'high')).toBe(true);
  });

  it('medium threshold confirms medium + high', () => {
    expect(shouldConfirm('low', 'medium')).toBe(false);
    expect(shouldConfirm('medium', 'medium')).toBe(true);
    expect(shouldConfirm('high', 'medium')).toBe(true);
  });

  it('always threshold confirms everything', () => {
    for (const risk of ['low', 'medium', 'high'] as const) {
      expect(shouldConfirm(risk, 'always')).toBe(true);
    }
  });
});

describe('shouldBlockInReadOnly', () => {
  const meta = (m: Partial<ToolMeta>): ToolMeta => ({
    name: 't',
    kind: 'read',
    deterministic: true,
    sideEffect: 'none',
    cacheable: false,
    ...m,
  });

  it('blocks write and dangerous kinds', () => {
    expect(shouldBlockInReadOnly(meta({ kind: 'write' }))).toBe(true);
    expect(shouldBlockInReadOnly(meta({ kind: 'dangerous' }))).toBe(true);
  });

  it('allows read and inert kinds', () => {
    expect(shouldBlockInReadOnly(meta({ kind: 'read' }))).toBe(false);
    expect(shouldBlockInReadOnly(meta({ kind: 'inert' }))).toBe(false);
  });

  it('allows missing meta (fall through to confirmMode gate)', () => {
    expect(shouldBlockInReadOnly(undefined)).toBe(false);
  });

  it('honors isWriteAction predicate to refine per-call write-ness', () => {
    const m = meta({
      kind: 'write',
      isWriteAction: (args) =>
        (args as { action?: string } | undefined)?.action !== 'read' &&
        (args as { action?: string } | undefined)?.action !== 'list',
    });
    // Reads/lists fall through despite the static `kind: 'write'`.
    expect(shouldBlockInReadOnly(m, { action: 'read' })).toBe(false);
    expect(shouldBlockInReadOnly(m, { action: 'list' })).toBe(false);
    // Writes still block.
    expect(shouldBlockInReadOnly(m, { action: 'write' })).toBe(true);
    expect(shouldBlockInReadOnly(m, { action: 'delete' })).toBe(true);
  });

  it('without args, isWriteAction is not consulted and static kind wins', () => {
    const m = meta({ kind: 'write', isWriteAction: () => false });
    expect(shouldBlockInReadOnly(m)).toBe(true);
  });
});

/**
 * Verb-first MCP naming (found in use, on Beeper).
 *
 * This was end-anchored only, so `messages_list` was a read and
 * `list_messages` was a WRITE. That is not a watcher problem: `mcp.ts` feeds
 * this into every tool's risk tier, so on any verb-first server every read tool
 * was medium-risk — refused under `toolMode: 'read-only'`, prompting under
 * `strict`, and excluded from the resolver's lookup allowlist.
 */
describe('isReadOnlyMCPToolName — verb position', () => {
  it('accepts a read verb at either end', () => {
    for (const n of [
      'list_messages',
      'messages_list',
      'get_chats',
      'search_messages',
      'query_threads',
      'lookup_contact',
      'read_receipts',
    ]) {
      expect(isReadOnlyMCPToolName(n), n).toBe(true);
    }
  });

  it('still refuses writes, wherever the verb sits', () => {
    for (const n of [
      'send_message',
      'message_send',
      'delete_chat',
      'update_status',
      'archive_thread',
    ]) {
      expect(isReadOnlyMCPToolName(n), n).toBe(false);
    }
  });

  it('refuses a write verb even when a read verb is also present', () => {
    // This is what makes matching a leading verb safe rather than reckless.
    expect(isReadOnlyMCPToolName('get_or_create_chat')).toBe(false);
    expect(isReadOnlyMCPToolName('mark_as_read')).toBe(false);
    expect(isReadOnlyMCPToolName('list_and_delete')).toBe(false);
    expect(isReadOnlyMCPToolName('search_and_reply')).toBe(false);
  });

  it('strips the #413 namespace before segmenting', () => {
    // Keys are `server_hash__tool`; segmenting the whole key makes the first
    // segment the server name, and the leading-verb test could never fire.
    expect(isReadOnlyMCPToolName('beeper_654785__list_messages')).toBe(true);
    expect(isReadOnlyMCPToolName('beeper_654785__send_message')).toBe(false);
  });

  it('splits the namespace on the FIRST `__`, not the last', () => {
    // The inline strip this replaced used `lastIndexOf('__')`, so a server
    // exporting `get__foo` came out as `foo` — no read verb, classified a
    // WRITE. That is the exact bug class the verb-position fix above exists
    // for, reintroduced one branch over, which is why the split lives in
    // `parseMCPToolName` and is not re-derived here. The server segment is
    // sanitized and cannot contain `__`; the tool half can.
    expect(isReadOnlyMCPToolName('beeper_654785__get__foo')).toBe(true);
    expect(isReadOnlyMCPToolName('beeper_654785__send__foo')).toBe(false);
  });

  it('is not fooled by a verb appearing inside a word', () => {
    // Segment matching, not substring: `updates` must not read as `update`.
    expect(isReadOnlyMCPToolName('get_message_updates')).toBe(true);
    expect(isReadOnlyMCPToolName('listing_details')).toBe(false);
  });
});

/**
 * A server that prefixes its own tools pushes the verb into the MIDDLE (#612).
 *
 * #569 moved this off a suffix and onto "a read verb at either END", which is a
 * better guess and still the wrong shape. `google-mcp` names every tool
 * `google_<product>_<verb>_<noun>`, so `list` lands at index 2 and every Gmail
 * and Calendar lookup classified as a medium-risk WRITE — the watcher gate
 * refused to poll an inbox and the user fell back to cron.
 *
 * The four names below are the table from the issue, and every one of them was
 * measured `false` against the shipped classifier before this change.
 */
describe('isReadOnlyMCPToolName — a read verb in the middle', () => {
  it.each([
    'google_gmail_list_emails',
    'google_gmail_list_unread_emails',
    'google_gmail_get_email',
    'google_calendar_get_events',
    'google_calendar_find_free_time',
    'google_drive_list_files',
    'google_sheets_batch_get_values',
  ])('reads %s', (name) => {
    expect(isReadOnlyMCPToolName(name)).toBe(true);
  });

  it.each([
    // Still refused, and by the write verb alone rather than by position — all
    // read off `google-mcp`'s real 61-tool surface.
    'google_gmail_send_email',
    'google_gmail_reply_email',
    'google_gmail_modify_labels',
    'google_gmail_batch_delete_emails',
    'google_calendar_create_event',
    'google_calendar_update_event',
    'google_drive_share_file',
    'google_sheets_append_values',
    // The sharpest of the real ones: a read verb at the LAST position with a
    // write verb in the middle. Under either rule the write verb decides.
    'google_tasks_set_default_list',
  ])('refuses %s', (name) => {
    expect(isReadOnlyMCPToolName(name)).toBe(false);
  });

  it('fixes the typography fold for a read, not just the risk tier', () => {
    // `google_gmail_get_email` measured `nonIdempotent: true` AND eligible for
    // the outbound prose fold, because `email` is an EMIT verb and the name
    // classified as a write. So Bernard was rewriting a LOOKUP's arguments —
    // `mcp-prose-args.ts` names that exact harm ("rewrite the SEARCH TERM") and
    // the classification was what let it happen. Both halves are ANDed with
    // `!isRead`, so reading the name correctly closes both at once.
    expect(hasEmitVerb('google_gmail_get_email')).toBe(true);
    expect(isReadOnlyMCPToolName('google_gmail_get_email')).toBe(true);
    expect(classifyMCPTool('google_gmail_get_email').nonIdempotent).toBe(false);
  });
});

/**
 * The guard that the widening moved the whole burden onto.
 *
 * While the read test was end-anchored, a name with no read verb at either END
 * was refused before `WRITE_VERBS` was ever consulted — which is why its own
 * docstring said "do not treat it as a general vocabulary of writes". Matching
 * any position removes that: this set is now the sole discriminator over every
 * name containing a read verb anywhere.
 *
 * So every entry gets a negative case, and the shape is the one the widening
 * made dangerous — a read verb in the MIDDLE, where nothing but this set
 * refuses. The sweep is generated FROM THE SOURCE rather than from a hand list,
 * because the failure worth catching is a verb added to the set without anyone
 * thinking about what it now has to hold on its own.
 */
describe('WRITE_VERBS carries the widening', () => {
  /**
   * The set as declared, read out of `risk.ts`.
   *
   * It is module-private and stays that way: exporting it to satisfy a test
   * would put a mutable `Set` on the public surface of a leaf that six gates
   * read. `settings-coverage.test.ts` scans source for the same reason.
   */
  function declaredWriteVerbs(): string[] {
    const src = readFileSync(new URL('./risk.ts', import.meta.url), 'utf8');
    const block = /const WRITE_VERBS = new Set\(\[([\s\S]*?)\]\);/.exec(src);
    expect(block, 'WRITE_VERBS declaration not found — did the shape change?').not.toBeNull();
    return [...block![1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  }

  it('finds the declaration', () => {
    // Guard the guard: a scan that silently matched nothing would make every
    // assertion below vacuous, and `it.each` over an empty array passes.
    expect(declaredWriteVerbs().length).toBeGreaterThan(30);
  });

  it.each(declaredWriteVerbs())('refuses `svc_get_%s_target`', (verb) => {
    // `get` at index 1 and the write verb at index 2 — both mid-name, so this
    // reads as a lookup under the widening unless the verb is in the set.
    expect(isReadOnlyMCPToolName(`svc_get_${verb}_target`)).toBe(false);
  });

  it('refuses realistic co-occurrences the widening would otherwise admit', () => {
    // The same property said in names somebody could plausibly ship, which is
    // what makes the generated sweep above legible rather than mechanical.
    for (const name of [
      'github_issue_get_and_close',
      'oauth_token_get_and_revoke',
      'linear_issue_find_and_assign',
      'calendar_event_get_and_respond',
      'sheets_values_get_and_append',
      'docs_body_get_and_replace_text',
      'tasks_task_get_and_complete',
      'notion_page_get_and_publish',
      'form_get_and_submit',
      'run_list_and_approve',
      'run_get_and_cancel',
      'alert_rule_get_and_notify',
    ]) {
      expect(isReadOnlyMCPToolName(name), name).toBe(false);
    }
  });

  /**
   * The real read names that decided which verbs are IN, pinned so the set
   * cannot grow back into them.
   *
   * `@zereight/mcp-gitlab@2.1.64` is a published server, and the first ten
   * below are its own tool names. A `merge` entry refused **twenty** of its
   * read tools, so a user pointing a watcher at GitLab merge requests would
   * have been told `"…list_merge_requests" is not a read-only tool` — the same
   * sentence, for the same reason, that #612 is about. `trigger` cost two more.
   * Measured: dropping the ten recovered 22 real reads and leaked zero of that
   * server's 104 real write names.
   */
  it('reads the real names that ten dropped verbs would have refused', () => {
    for (const name of [
      'list_merge_requests',
      'get_merge_request',
      'get_merge_request_diffs',
      'list_merge_request_notes',
      'get_merge_request_approval_state',
      'list_group_merge_requests',
      'list_merge_request_pipelines',
      'get_pipeline_trigger',
      'list_pipeline_trigger_jobs',
      'list_deployment_merge_requests',
      // Not from that server, but the same shape and the reason the other eight
      // went: `<read>_<noun that happens to be a verb>_<noun>` is how vendors
      // name lookups.
      'list_deploy_keys',
      'get_sync_status',
      'get_share_link',
      'get_join_url',
      'get_invite_link',
      'get_import_status',
      'drive_get_export_url',
      'oauth_get_refresh_token',
    ]) {
      expect(isReadOnlyMCPToolName(name), name).toBe(true);
    }
  });

  it('pays for that by letting those verbs through in a compound', () => {
    // The accepted cost, stated rather than left to be discovered. These are
    // the shape the dropped verbs were added for — and the shape that was not
    // found on any real server, which is why the trade goes this way.
    for (const name of [
      'github_pr_get_status_and_merge',
      'github_workflow_find_and_trigger',
      'slack_channel_find_and_join',
      'drive_file_get_and_share',
      'notion_db_get_and_sync',
      'vercel_project_get_and_deploy',
    ]) {
      expect(isReadOnlyMCPToolName(name), name).toBe(true);
    }
  });

  it('refuses the mutating names with no help from this set at all', () => {
    // Half the reason the set is twelve rather than twenty-two: a mutating tool
    // is named for its mutation, so it carries no read verb and is refused by
    // ABSENCE. None of these depends on a `WRITE_VERBS` entry — measured for
    // all twenty candidates, every one still refused with its verb removed.
    for (const name of [
      'merge_pull_request',
      'sync_folder',
      'share_file',
      'join_channel',
      'invite_user',
      'deploy_app',
      'trigger_workflow',
      'import_calendar',
      'export_report',
      'refresh_tokens',
    ]) {
      expect(isReadOnlyMCPToolName(name), name).toBe(false);
    }
  });

  it('keeps `email` out, because putting it in is #612 again', () => {
    // `email` is an EMIT verb and deliberately not a write verb: it is the one
    // segment that makes the two sets non-interchangeable, and adding it here
    // would reclassify every Gmail lookup as a write — the bug being fixed.
    expect(declaredWriteVerbs()).not.toContain('email');
    expect(hasEmitVerb('get_email')).toBe(true);
    expect(isReadOnlyMCPToolName('google_gmail_get_email')).toBe(true);
  });

  it('keeps the ten dropped verbs out, by name', () => {
    // The membership half of the two behavioural tests above, so a verb added
    // back fails here as well as there — and so the list of what was rejected
    // survives in the record rather than only in a PR thread.
    for (const verb of [
      'merge',
      'trigger',
      'deploy',
      'sync',
      'share',
      'join',
      'invite',
      'import',
      'export',
      'refresh',
    ]) {
      expect(declaredWriteVerbs(), verb).not.toContain(verb);
    }
  });
});

/**
 * The server's own declaration beats the name (#570).
 *
 * `isReadOnlyMCPSuffix` has always been a guess, and `risk.ts` said so in its
 * own docstring: "#570 replaces the guessing entirely with MCP's own
 * `readOnlyHint`". The blocker was `@ai-sdk/mcp`, which up to 1.0.21
 * destructured `annotations` and forwarded only `.title`; 1.0.82 carries all
 * four hints through to `tool.metadata.annotations`.
 */
describe('classifyMCPTool — annotation over guess', () => {
  it('reads a tool whose name says write', () => {
    // The direction that unblocks a watcher on a badly-named lookup.
    expect(isReadOnlyMCPToolName('send_report')).toBe(false);
    const c = classifyMCPTool('send_report', { readOnlyHint: true });
    expect(c.isRead).toBe(true);
    expect(c.readSource).toBe('annotation');
    // A read is never worth refusing a repeat of, whatever the name emits.
    expect(c.nonIdempotent).toBe(false);
  });

  it('writes a tool whose name says read', () => {
    // #570 calls this the worse of the two directions: today a server
    // explicitly marking a tool destructive is silently overridden by our regex.
    expect(isReadOnlyMCPToolName('list_things')).toBe(true);
    const c = classifyMCPTool('list_things', { readOnlyHint: false });
    expect(c.isRead).toBe(false);
    expect(c.readSource).toBe('annotation');
  });

  it('leaves an unannotated tool exactly as the name had it', () => {
    // The fallback is the majority path and must not rot: `google-mcp`, the
    // server behind #612, declares no annotations at all across its 61 tools.
    for (const name of [
      'google_gmail_list_emails',
      'send_message',
      'focus_app',
      'list_drafts',
      'get_or_create_chat',
    ]) {
      const c = classifyMCPTool(name);
      expect(c.isRead, name).toBe(isReadOnlyMCPToolName(name));
      expect(c.nonIdempotent, name).toBe(!isReadOnlyMCPToolName(name) && hasEmitVerb(name));
      expect(c.readSource, name).toBe('name');
    }
    // And an annotations object that declares neither hint is the same as none.
    expect(classifyMCPTool('send_message', {}).readSource).toBe('name');
  });

  it('takes idempotency from the server, in both directions', () => {
    // `focus_app` carries neither verb, so the name guess calls it idempotent;
    // a server saying otherwise is the whole point of the hint.
    expect(classifyMCPTool('focus_app').nonIdempotent).toBe(false);
    expect(classifyMCPTool('focus_app', { idempotentHint: false }).nonIdempotent).toBe(true);
    expect(classifyMCPTool('focus_app', { idempotentHint: false }).idempotencySource).toBe(
      'annotation',
    );
    // And the inverse: a name that emits, declared safe to repeat.
    expect(classifyMCPTool('send_message').nonIdempotent).toBe(true);
    expect(classifyMCPTool('send_message', { idempotentHint: true }).nonIdempotent).toBe(false);
  });

  it('asks idempotency only of a write', () => {
    // MCP says `idempotentHint` is meaningful only when `readOnlyHint` is
    // false, and Bernard already had the same rule for its own reason —
    // `duplicate-guard.ts` must never refuse a repeated lookup. So a declared
    // read ignores a contradictory `idempotentHint` rather than half-honouring
    // it, and reports the source that actually decided.
    const c = classifyMCPTool('list_messages', { readOnlyHint: true, idempotentHint: false });
    expect(c.isRead).toBe(true);
    expect(c.nonIdempotent).toBe(false);
    expect(c.idempotencySource).toBe('annotation');
    const d = classifyMCPTool('list_messages', { idempotentHint: false });
    expect(d.nonIdempotent).toBe(false);
    expect(d.idempotencySource).toBe('name');
  });

  it('ignores a hint that is not a boolean', () => {
    // Annotations arrive as untrusted server data and reach this function as an
    // untyped object; a string `"true"` must not read as a declaration. The
    // installed SDK's zod schema would reject it first, but that is a property
    // of the version installed rather than of this function.
    const bad = { readOnlyHint: 'true', idempotentHint: 1 } as unknown as Parameters<
      typeof classifyMCPTool
    >[1];
    const c = classifyMCPTool('send_message', bad);
    expect(c.isRead).toBe(false);
    expect(c.readSource).toBe('name');
    expect(c.nonIdempotent).toBe(true);
    expect(c.idempotencySource).toBe('name');
  });
});
