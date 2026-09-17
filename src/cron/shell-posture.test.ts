import { describe, it, expect } from 'vitest';
import { isReadOnlyShellInvocation, readOnlyShellSummary } from '../tool-permissions.js';
import { riskFromMeta } from '../risk.js';
import { cronDefinition } from '../framework/agents/cron.js';
import type { ToolMeta } from '../framework/tools/types.js';

/**
 * What a cron job's `shell` can actually run, and what its prompt claims (#447).
 *
 * A real job needed `gh issue create` and was refused ten times across 45
 * minutes and 934,805 tokens, every run reporting success. The prompt it was
 * running under said *"Dangerous commands (rm -rf, sudo, etc.) are
 * automatically denied … stick to safe, read-oriented commands"* — which is
 * not the rule. The rule is an allowlist of about thirty simple invocations,
 * and `echo hello` is not one of them.
 *
 * These pin the shape of the real rule, because it is the opposite of what a
 * reader of the old sentence would guess, and pin that the prompt states it
 * rather than paraphrasing it.
 */

/** `shell`'s own meta, as `createShellTool` attaches it. */
const SHELL: ToolMeta = {
  name: 'shell',
  kind: 'dangerous',
  deterministic: false,
  sideEffect: 'local',
  isWriteAction: (args) => !isReadOnlyShellInvocation((args as { command: string }).command),
};

const riskOf = (command: string) => riskFromMeta(SHELL, { command });

/**
 * The daemon prompt as a running job sees it.
 *
 * `systemPrompt` reads `ctx.toolOptions.writeScope` and `ctx.config.maxSteps`
 * — both derived rather than written out, per #333 — so the minimum honest
 * context supplies those two. `{}` throws.
 */
function renderPrompt(): string {
  const ctx = { toolOptions: {}, config: { maxSteps: 25 } };
  return cronDefinition.systemPrompt?.(ctx as never, {} as never, {} as never) ?? '';
}

describe('what cron shell actually allows', () => {
  it('denies echo, which is the case that makes the shape visible', () => {
    // Not an oversight: `echo $TOKEN` is env exfiltration, not inspection, and
    // `tool-permissions.ts` says so at the allowlist. But it is the command a
    // model reaches for to test whether the tool works at all — the real job
    // ran `echo hello`, `echo test` and `echo ok` across four separate runs
    // trying to work out whether something transient was happening.
    expect(riskOf('echo hello')).toBe('high');
    expect(riskOf('ls -la /tmp')).toBe('low');
  });

  it('denies a compound line even when every command in it is allowed', () => {
    // The trap the prompt now names, and the one nobody would infer: `pwd`,
    // `which` and `head` are each on the list, and composing them is what
    // makes the line high risk — `COMPLEX_RE` rejects the `&&`, the `|` and
    // the `2>&1` before the allowlist is ever consulted.
    expect(riskOf('pwd')).toBe('low');
    expect(riskOf('which gh')).toBe('low');
    expect(riskOf('pwd && which gh')).toBe('high');
    expect(riskOf('ls -la | head -20')).toBe('high');
    expect(riskOf('gh auth status 2>&1')).toBe('high');
  });

  it('denies the tools a job would actually want', () => {
    for (const cmd of ['gh issue create --repo a/b', 'curl https://x', 'npm publish']) {
      expect(riskOf(cmd), cmd).toBe('high');
    }
  });

  it('states the live allowlist in the daemon prompt, rather than describing it', () => {
    // The prompt had drifted into being false. Derived from
    // `READONLY_COMMANDS` now, the `APPLET_STYLED_SELECTORS` treatment: a
    // prompt that lists an artefact is a second copy of it, and copies do not
    // fail, they diverge. This fails the day a command is added to the set and
    // the prompt is not regenerated.
    const prompt = renderPrompt();
    expect(prompt).toContain(readOnlyShellSummary());
    // And the two things a reader of the old sentence would have got wrong.
    expect(prompt, 'names the compound trap').toMatch(/pipe|&&/);
    expect(prompt, 'names echo as denied').toMatch(/echo/);
    // The old claim, which sent the model looking for a dangerous-pattern list
    // that does not exist.
    expect(prompt).not.toMatch(/rm -rf, sudo/);
  });

  it('tells the model a permission verdict is not a command to fix', () => {
    // The prompt also says "NEVER retry the exact same command … you must
    // change something", which is right for a CLI error and is what drove ten
    // runs of varying flags against a fixed verdict.
    const prompt = renderPrompt();
    expect(prompt).toMatch(/permission (verdict|denial)/i);
  });
});

/**
 * A grant comes from the person, never the process (#447).
 *
 * `cli.ts` already states this for write paths — *"exposing that to the model
 * would let an agent widen its own write scope, which is the escalation the
 * whole gate exists to prevent"* — and it applies identically to the tool
 * grants added here.
 *
 * Today that holds only by OMISSION: the fields are absent from the `cron`
 * tool's schema, and `CronStore.createJob`/`updateJob` accept them from any
 * caller. Adding one line to the schema would open it with no test failing,
 * which is exactly the shape `meta-coverage.test.ts` exists to refuse for
 * `directInvocable`.
 */
describe('a cron job cannot grant itself anything', () => {
  it('keeps every posture field out of the agent-facing schema', async () => {
    const { createCronTool } = await import('../tools/cron.js');
    // `createCronTool` returns a registry keyed by tool name, not a bare tool.
    const registry = createCronTool() as unknown as Record<
      string,
      { parameters: { shape: Record<string, unknown> } }
    >;
    const fields = Object.keys(registry.cron.parameters.shape);
    for (const forbidden of [
      'toolPermissions',
      'confirmMode',
      'toolMode',
      'skipPermissions',
      'writePaths',
    ]) {
      expect(fields, `${forbidden} must stay user-only`).not.toContain(forbidden);
    }
    // Guard the guard: a shape read that returned nothing would pass the loop
    // above for every field forever.
    expect(fields).toContain('action');
    expect(fields).toContain('prompt');
  });
});

/**
 * The wiring, which is the half that fails silently (#447).
 *
 * `run.ts` builds `augmentTools`' options by ENUMERATING fields rather than
 * spreading them, and its own comment names the hazard for `writeScope`: "a
 * scope set on `toolOptions` and not passed on is a scope that silently never
 * applies". Every field added since inherits it. Three mutations survived the
 * behavioural tests above for exactly that reason — the flag was set, the
 * message was right, and nothing checked that either one travelled.
 */
describe('the unattended posture actually reaches the gate', () => {
  it('marks a headless options bag unattended and wires the denial sink', async () => {
    const { headlessToolOptions, resolvePosture } = await import('../headless-posture.js');
    const seen: unknown[] = [];
    const opts = headlessToolOptions(
      resolvePosture({
        toolMode: 'write',
        confirmMode: 'auto',
        writeScope: null,
        toolPermissions: null,
      }),
      30_000,
      (d) => seen.push(d),
    );
    expect(opts.unattended, 'without this every refusal blames a user').toBe(true);
    opts.onDenied?.({ tool: 'shell', permissionKey: 'shell:gh', risk: 'high' });
    expect(seen).toHaveLength(1);
  });

  it('forwards both to augmentTools from the runner', async () => {
    // A source scan, and named as the weak assertion it is. `run.ts` builds
    // that options object inside `runDefinition`, so reaching it needs a whole
    // dispatch; what this catches is the one-line omission, which is the
    // mutation that survived everything else and is the documented failure
    // mode of an enumerated bag.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../framework/agents/run.ts', import.meta.url).pathname, 'utf-8'),
    );
    const call = src.slice(src.indexOf('augmentTools(rawTools, {'));
    const bag = call.slice(0, call.indexOf('\n  });'));
    expect(bag).toContain('unattended: ctx.toolOptions.unattended');
    expect(bag).toContain('onDenied: ctx.toolOptions.onDenied');
  });

  it('gives a job its own grants, and still withholds the profile’s', async () => {
    const { resolveCronJobPosture } = await import('./runner.js');
    const rule = { effect: 'allow' as const, tool: 'shell', specifier: 'gh *', _v: 2 as const };
    const granted = resolveCronJobPosture({
      id: 'j1',
      name: 'n',
      schedule: '* * * * *',
      prompt: 'p',
      enabled: true,
      createdAt: '',
      toolPermissions: [rule],
    } as never);
    expect(granted.toolPermissions).toEqual([rule]);

    // `null`, not `[]` — that is what keeps `getToolPermissions` omitted
    // entirely for an ungranted job, so no rules are read at all.
    const plain = resolveCronJobPosture({
      id: 'j2',
      name: 'n',
      schedule: '* * * * *',
      prompt: 'p',
      enabled: true,
      createdAt: '',
    } as never);
    expect(plain.toolPermissions).toBeNull();
  });
});
