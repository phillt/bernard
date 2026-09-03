import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { useTempHome } from '../__tests__/temp-home.js';
import { mapToolArgs } from './tool-dispatch.js';
import { directInvocableRefusal, unrepresentableParams } from './direct-tool.js';
import type { ToolDispatch } from './manifest.js';

const dispatch = (args: Record<string, string | number | boolean>): ToolDispatch => ({
  kind: 'tool',
  tool: 'file_write',
  args,
});

describe('mapToolArgs', () => {
  it('reads `$.<name>` from the call args and passes literals through', async () => {
    expect(mapToolArgs(dispatch({ path: '$.dest', content: 'fixed' }), { dest: '/tmp/x' })).toEqual(
      {
        path: '/tmp/x',
        content: 'fixed',
      },
    );
  });

  // An absent optional arg drops the parameter rather than passing `undefined`,
  // so the tool sees the same shape a model would have produced.
  it('omits a parameter whose referenced arg was not supplied', async () => {
    expect(mapToolArgs(dispatch({ path: '$.dest' }), {})).toEqual({});
  });

  // The caller's object never reaches the tool; only named parameters do.
  it('never passes an undeclared caller field through', async () => {
    expect(
      mapToolArgs(dispatch({ path: '$.dest' }), { dest: '/tmp/x', extra: 'smuggled' }),
    ).toEqual({ path: '/tmp/x' });
  });
});

describe('direct-invocation eligibility (#445)', () => {
  async function registry() {
    const { createTools } = await import('../tools/index.js');
    const { MemoryStore } = await import('../memory.js');
    return (await createTools(
      { shellTimeout: 1000, confirmDangerous: async () => false },
      new MemoryStore(),
    )) as unknown as Record<string, unknown>;
  }

  it('admits a marked tool', async () => {
    const r = await registry();
    expect(directInvocableRefusal('file_write', r.file_write)).toBeNull();
    expect(directInvocableRefusal('web_search', r.web_search)).toBeNull();
  });

  // The one that matters: a free-form command line reachable from a web page
  // is arbitrary host code execution.
  it('refuses shell, and says why', async () => {
    const r = await registry();
    const refusal = directInvocableRefusal('shell', r.shell);
    expect(refusal).toContain('shell');
    expect(refusal).toContain('cannot be called directly');
  });

  it('refuses an unmarked tool and a tool that is not there', async () => {
    const r = await registry();
    expect(directInvocableRefusal('cite', r.cite)).not.toBeNull();
    expect(directInvocableRefusal('nope', undefined)).toContain('does not exist');
  });

  // `ArgSpec` produces scalars only, so a nested array is not something a
  // declared arg can become — which is why `file_edit_lines` is excluded.
  it('sees which parameters a manifest cannot express', async () => {
    const r = await registry();
    expect(unrepresentableParams(r.file_write)).toEqual([]);
    expect(unrepresentableParams(r.file_edit_lines).length).toBeGreaterThan(0);
  });
});

describe('dispatchToolAction', () => {
  useTempHome('bernard-tooldispatch');

  async function load() {
    vi.resetModules();
    const paths = await import('../paths.js');
    const mod = await import('./tool-dispatch.js');
    return { ...mod, runWorkspace: paths.runWorkspace };
  }

  function invocation(args: Record<string, string | number | boolean>) {
    return {
      appId: 'demo',
      actionName: 'go',
      frozenArgs: args,
      action: { toolMode: 'write', confirmMode: 'off', args: {}, toolAllowlist: [] },
    } as never;
  }

  // The acceptance criterion of #445, stated as a filesystem fact.
  it('runs a real tool with no model in the loop', async () => {
    const m = await load();
    const workspace = m.runWorkspace('apps', 'demo');
    const target = path.join(workspace, 'note.txt');
    const res = await m.dispatchToolAction({
      invocation: invocation({ dest: target, body: 'hello' }),
      dispatch: { kind: 'tool', tool: 'file_write', args: { path: '$.dest', content: '$.body' } },
      timeoutMs: null,
    });
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(target, 'utf-8')).toBe('hello');
  });

  // Skipping the model must not mean skipping the gates: the registry goes
  // through `augmentTools`, so the write-scope gate fires exactly as it does
  // for an agent action.
  it('is still bound by the write-scope gate', async () => {
    const m = await load();
    const outside = path.join(process.env.BERNARD_HOME as string, 'outside.txt');
    const res = await m.dispatchToolAction({
      invocation: invocation({ dest: outside, body: 'pwned' }),
      dispatch: { kind: 'tool', tool: 'file_write', args: { path: '$.dest', content: '$.body' } },
      timeoutMs: null,
    });
    expect(fs.existsSync(outside)).toBe(false);
    // And it reports as a FAILURE. Both gate refusals are non-throwing — the
    // augment layer returns an `Error: `-prefixed string — so without a shape
    // check a denial would come back as `ok: true` with the refusal as the
    // result, and the caller would read it as success (#363).
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain('refused');
  });

  it('reports a permission-rule denial as a failure, not a success', async () => {
    const m = await load();
    const { saveAppGrants } = await import('./app-grants.js');
    saveAppGrants('demo', [{ effect: 'deny', tool: 'file_write', _v: 2 }]);
    const target = path.join(m.runWorkspace('apps', 'demo'), 'blocked.txt');
    const res = await m.dispatchToolAction({
      invocation: invocation({ dest: target, body: 'x' }),
      dispatch: { kind: 'tool', tool: 'file_write', args: { path: '$.dest', content: '$.body' } },
      timeoutMs: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain('permission rule');
    expect(fs.existsSync(target)).toBe(false);
  });

  /**
   * The fail-closed property, on this second headless path.
   *
   * `augmentTools` auto-denies a write under `read-only` precisely because
   * `blockAction` is ABSENT — an omission, which nothing type-checks. Both
   * paths now build their options through `headlessToolOptions`, and this is
   * what would notice if one of them grew the field back.
   */
  it('a read-only action cannot write, with nobody to ask', async () => {
    const m = await load();
    const target = path.join(m.runWorkspace('apps', 'demo'), 'nope.txt');
    const inv = invocation({ dest: target, body: 'x' }) as unknown as {
      action: { toolMode: string };
    };
    inv.action.toolMode = 'read-only';
    const res = await m.dispatchToolAction({
      invocation: inv as never,
      dispatch: { kind: 'tool', tool: 'file_write', args: { path: '$.dest', content: '$.body' } },
      timeoutMs: null,
    });
    expect(res.ok).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('refuses an ineligible tool as a request failure, not a run failure', async () => {
    const m = await load();
    const res = await m.dispatchToolAction({
      invocation: invocation({}),
      dispatch: { kind: 'tool', tool: 'shell', args: { command: 'echo hi' } },
      timeoutMs: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('invalid');
  });

  // Nothing else validates these: inside an agent loop the AI SDK parses the
  // call against `parameters` before `execute`; a direct call skips that.
  it('validates the mapped arguments against the tool schema', async () => {
    const m = await load();
    const res = await m.dispatchToolAction({
      invocation: invocation({}),
      // `path` and `content` are both required and neither is supplied.
      dispatch: { kind: 'tool', tool: 'file_write', args: {} },
      timeoutMs: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe('invalid');
      expect(res.message).toContain('not valid');
    }
  });
});
