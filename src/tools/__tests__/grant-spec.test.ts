import { describe, it, expect, beforeAll } from 'vitest';
import { grantSpecFor, parseGrantSpec, permissionKeyFor } from '../../tool-permissions.js';
import { resolveGrant } from '../../permissions/engine.js';
import { initShellParser } from '../../permissions/shell-ast.js';
import type { PermissionRule } from '../../tool-permissions.js';

/**
 * A remedy has to be a command that works (#447 follow-up).
 *
 * The unattended refusal tells a model what to report so the user can grant the
 * call. It printed the permission KEY, and a key is an identity rather than a
 * grant — so three of the four shapes it can take produced a `cron-grant` line
 * that the user would type, see accepted, and still be denied by. That is worse
 * than saying nothing: it spends the one intervention and sends them back into
 * the loop that burned 934,805 tokens.
 *
 * Every case here drives the minted specifier through `parseGrantSpecifier`'s
 * split and the REAL `resolveGrant`, because the defect class is "reads
 * correctly, resolves to `ask`" — which no assertion on the message string can
 * see. Asserting the text would have passed against every one of them.
 */

/**
 * The REAL parser both CLIs use, not a local restatement of it.
 *
 * It was a hand-copied one here, which is the same duplication the production
 * code carried: `cron/cli.ts` had its own copy that dropped the validation.
 * Driving the shared function is what makes this a round-trip test —
 * `grantSpecFor` mints, `parseGrantSpec` reads back, `resolveGrant` decides.
 */
function parseGrantSpecifier(raw: string): PermissionRule {
  const rule = parseGrantSpec(raw, 'allow');
  if (rule === null) throw new Error(`refused: ${raw}`);
  return rule;
}

const CRON_META = { actionScoped: true };

/** What the user would actually get after typing the remedy we printed. */
function grantsAfterTyping(spec: string, toolName: string, args: unknown): boolean {
  return resolveGrant(toolName, args, [parseGrantSpecifier(spec)], false) === 'allow';
}

beforeAll(async () => {
  // `resolveGrant` reports every compound line as a parse-error without it,
  // which would make the compound cases below pass for the wrong reason.
  await initShellParser();
});

describe('the grant a refusal names actually grants', () => {
  it('covers a shell command WITH ARGUMENTS, which the key did not', () => {
    // The whole population. `matchShellSpecifier` treats a specifier with no
    // trailing `*` as an exact token match, so the key `shell:gh` covers a bare
    // `gh` and nothing anyone runs.
    const args = { command: 'gh issue create --title x --body y' };
    const spec = grantSpecFor('shell', args);
    expect(spec).toBe('shell:gh *');
    expect(grantsAfterTyping(spec!, 'shell', args)).toBe(true);

    // And the key it replaced does not, which is the defect stated as a test.
    expect(grantsAfterTyping(permissionKeyFor('shell', args)!, 'shell', args)).toBe(false);
  });

  it('still covers the bare command, so the trailing star costs nothing', () => {
    // A prefix match with zero extra tokens — so the wider form strictly
    // dominates the key rather than trading one case for another.
    expect(grantsAfterTyping('shell:gh *', 'shell', { command: 'gh' })).toBe(true);
  });

  it('does not widen past the command it names', () => {
    // The point of a scoped grant. `gh *` must not reach `rm`.
    expect(grantsAfterTyping('shell:gh *', 'shell', { command: 'rm -rf /' })).toBe(false);
  });

  it('spells an action grant the way the engine reads it', () => {
    // `ruleMatchesNonShell` requires the SPECIFIER itself to read
    // `action:delete`; through the first-colon split that means the grant is
    // `cron:action:delete`. The key `cron:delete` lands in the MCP arg-match
    // fallback and never matches.
    const args = { action: 'delete', id: 'j1' };
    expect(grantSpecFor('cron', args, CRON_META)).toBe('cron:action:delete');
    expect(grantsAfterTyping('cron:action:delete', 'cron', args)).toBe(true);
    expect(grantsAfterTyping(permissionKeyFor('cron', args, CRON_META)!, 'cron', args)).toBe(false);

    // Guard the guard: the grant must still be scoped to the one action, or
    // "allow delete" would quietly authorise everything else on the tool.
    expect(grantsAfterTyping('cron:action:delete', 'cron', { action: 'list' })).toBe(false);
  });

  it('keys a plain tool by name, which already worked', () => {
    const args = { url: 'https://example.com' };
    expect(grantSpecFor('web_read', args)).toBe('web_read');
    expect(grantsAfterTyping('web_read', 'web_read', args)).toBe(true);
  });
});

describe('a call no grant can reach says so instead of inventing one', () => {
  // The population that produced the loop: `gh issue list | jq` and
  // `cd /repo && npm test` both have no key, and the message rendered that as
  // `--allow this tool` — two bare words that word-split into grants for two
  // tools that do not exist.
  const COMPOUND = [
    'gh issue list --state open | jq -r ".[].title" > /tmp/out.txt',
    'cd /repo && npm test',
    'pwd && which gh | head -20',
  ];

  it.each(COMPOUND)('mints no per-call specifier for %s', (command) => {
    expect(grantSpecFor('shell', { command })).toBeNull();
  });

  it('is null because no specifier could have matched, not because we gave up', () => {
    // Load-bearing: it justifies naming the whole tool as the only lever. If a
    // scoped grant DID reach a compound line, the message would be steering the
    // user to something broader than they need.
    const args = { command: 'cd /repo && npm test' };
    expect(grantsAfterTyping('shell:npm *', 'shell', args)).toBe(false);
    expect(grantsAfterTyping('shell:cd *', 'shell', args)).toBe(false);
  });

  it('names a whole-tool grant that really does reach it', () => {
    // What the null branch of the message tells the user to run. A lever that
    // does not work is the thing this whole file exists to stop shipping.
    for (const command of COMPOUND) {
      expect(grantsAfterTyping('shell', 'shell', { command }), command).toBe(true);
    }
  });

  it('mints nothing for an action tool whose call carries no action', () => {
    expect(grantSpecFor('cron', {}, CRON_META)).toBeNull();
    expect(grantSpecFor('shell', { command: 42 })).toBeNull();
  });
});

/**
 * And the wiring, which is the half that fails silently.
 *
 * Every assertion above passed while the message still printed the key — the
 * spec was minted correctly and thrown away one line later. That is the same
 * enumerated-bag hazard `shell-posture.test.ts` records for `run.ts`: the value
 * is right, and nothing checks that it travelled. So this drives the REAL
 * confirm gate and reads the text a model would actually receive.
 */
describe('the refusal a model receives carries the working remedy', () => {
  async function refusalFor(command: string): Promise<string> {
    const { augmentTools } = await import('../augment.js');
    const { attachMeta } = await import('../../framework/tools/adapter.js');
    const { isReadOnlyShellInvocation } = await import('../../tool-permissions.js');
    const { resolvePosture, headlessToolOptions } = await import('../../headless-posture.js');

    const tool = attachMeta(
      {
        description: 'sh',
        parameters: {} as never,
        execute: async () => ({ output: 'ran', is_error: false }),
      } as never,
      {
        name: 'shell',
        kind: 'dangerous',
        deterministic: false,
        sideEffect: 'local',
        isWriteAction: (a: unknown) =>
          !isReadOnlyShellInvocation((a as { command: string }).command),
      },
    );
    const posture = resolvePosture({
      toolMode: 'write',
      confirmMode: 'auto',
      writeScope: null,
      toolPermissions: null,
    });
    const store = {
      get: () => undefined,
      getAll: () => [],
      list: () => [],
      recordSuccess() {},
      recordBadExample() {},
      patchLastBadWithFix() {},
    };
    const tools = augmentTools({ shell: tool } as never, {
      profileStore: store as never,
      toolMode: posture.toolMode,
      confirmThreshold: posture.confirmThreshold,
      ...headlessToolOptions(posture, 30_000),
    });
    const r = await (
      tools.shell as { execute: (a: unknown, o: unknown) => Promise<unknown> }
    ).execute({ command }, {});
    return String((r as { output: unknown }).output);
  }

  it('prints the specifier that grants, for a simple command', async () => {
    const text = await refusalFor('gh issue create --title x --body y');
    expect(text).toContain("--allow 'shell:gh *'");
    // Quoted, or the shell word-splits it into `shell:gh` and a glob of the cwd.
    expect(text).not.toMatch(/--allow shell:gh \*/);
    // The form that resolves to `ask` must not be what we hand the user.
    expect(text).not.toMatch(/--allow '?shell:gh'?[^ *]/);
  });

  it('refuses to invent a per-call grant for a compound command', async () => {
    const text = await refusalFor('gh issue list --state open | jq -r ".[]" > /tmp/o');
    // The exact string the old message produced, which word-split into two
    // grants for tools that do not exist.
    expect(text).not.toContain('this tool');
    // It names the lever that does reach it, marked as the broader thing it is.
    expect(text).toContain('--allow shell');
    expect(text).toMatch(/broader/);
    // And says why a scoped grant is not on offer, so the model reports the
    // shape of the problem rather than guessing at a specifier.
    expect(text).toMatch(/pipe|redirect|&&/);
  });

  it('still says the verdict will not change, in both branches', async () => {
    for (const cmd of ['gh issue create --title x', 'cd /repo && npm test']) {
      expect(await refusalFor(cmd), cmd).toMatch(/will be the same for every call/);
    }
  });
});

/**
 * The block gate is the applet and script path, and it had the defect #447
 * fixed one gate over.
 *
 * `headlessToolOptions` omits `blockAction`, and `apps/manifest.ts` defaults an
 * action to `read-only` — so for `bernard script` and every applet button the
 * BLOCK gate, not the confirm gate, is what refuses. It was handing back
 * `READ_ONLY_DENIED_MESSAGE` ("Ask the user to allow this tool"), to nobody,
 * and never firing `onDenied` — so `RunHeadlessResult.denied` came back empty
 * and the run reported a clean success. That is the 934,805-token shape with
 * none of #447's machinery firing, on the two least-trusted callers.
 */
describe('an unattended read-only refusal names a grant, not a user', () => {
  async function blockedRefusal(): Promise<{ text: string; denied: unknown[] }> {
    const { augmentTools } = await import('../augment.js');
    const { attachMeta } = await import('../../framework/tools/adapter.js');
    const { resolvePosture, headlessToolOptions } = await import('../../headless-posture.js');

    const tool = attachMeta(
      {
        description: 'w',
        parameters: {} as never,
        execute: async () => ({ ok: true }),
      } as never,
      { name: 'file_write', kind: 'write', deterministic: false, sideEffect: 'local' },
    );
    // Exactly what an applet action resolves to: read-only, nobody to ask.
    const posture = resolvePosture({
      toolMode: 'read-only',
      confirmMode: 'auto',
      writeScope: null,
      toolPermissions: null,
    });
    const denied: unknown[] = [];
    const store = {
      get: () => undefined,
      getAll: () => [],
      list: () => [],
      recordSuccess() {},
      recordBadExample() {},
      patchLastBadWithFix() {},
    };
    const tools = augmentTools({ file_write: tool } as never, {
      profileStore: store as never,
      toolMode: posture.toolMode,
      confirmThreshold: posture.confirmThreshold,
      ...headlessToolOptions(posture, 30_000, (d) => denied.push(d)),
    });
    const r = await (
      tools.file_write as { execute: (a: unknown, o: unknown) => Promise<unknown> }
    ).execute({ path: '/tmp/x', content: 'y' }, {});
    return { text: String((r as { output: unknown }).output), denied };
  }

  it('does not tell a nonexistent user to allow the tool', async () => {
    const { text } = await blockedRefusal();
    expect(text).not.toMatch(/Ask the user/);
    expect(text).toMatch(/No one is present to approve it/);
    // The half that stops the retry loop: the verdict is fixed for the run.
    expect(text).toMatch(/will be the same for every call in this run/);
  });

  it('names the grant that would actually fix it', async () => {
    const { text } = await blockedRefusal();
    expect(text).toContain("--allow 'file_write'");
  });

  it('reports the denial, so the run can be marked denied', async () => {
    // Without this `RunHeadlessResult.denied` is empty and the caller reports
    // a clean success — which is what made the original loop invisible.
    const { denied } = await blockedRefusal();
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ tool: 'file_write', permissionKey: 'file_write' });
  });
});

describe('a grant argument that addresses nothing is refused, not stored', () => {
  // The half `cron/cli.ts`'s copy had dropped. Each of these used to mint a
  // rule — `{tool: ''}` or `{tool: 'gh'}` with the specifier silently gone —
  // and persist it on the one path with no operator watching, so the grant
  // read as accepted and matched nothing forever.
  it.each([':foo', 'gh:', '', '   ', ':'])('refuses %o', (spec) => {
    expect(parseGrantSpec(spec, 'allow')).toBeNull();
  });

  it('still accepts the two real shapes', () => {
    expect(parseGrantSpec('shell', 'allow')).toEqual({ effect: 'allow', tool: 'shell', _v: 2 });
    expect(parseGrantSpec('shell:gh *', 'allow')).toEqual({
      effect: 'allow',
      tool: 'shell',
      specifier: 'gh *',
      _v: 2,
    });
  });

  it('round-trips what grantSpecFor mints, for every shape it can mint', () => {
    // The pair's actual contract: anything the refusal prints must parse back.
    for (const spec of ['shell:gh *', 'cron:action:delete', 'web_read', 'shell']) {
      expect(parseGrantSpec(spec, 'allow'), spec).not.toBeNull();
    }
  });
});
