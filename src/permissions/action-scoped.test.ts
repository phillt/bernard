import { describe, it, expect } from 'vitest';
import { permissionKeyFor, actionOf } from '../tool-permissions.js';
import { breadthOptionsFor } from './breadth.js';

/**
 * #322: `ACTION_SCOPED_TOOLS` was a name Set in `tool-permissions.ts` restating
 * what each tool's own meta already declared — and the two could disagree, with
 * nothing to notice. The discriminator now lives on `ToolMeta.actionScoped`.
 *
 * This file covers the GENERALIZATION — what the three readers do with and
 * without a declaration. That the real cron tools declare it, and that their
 * per-action keys behave, is covered against the actual tools in
 * `src/tools/cron-consolidation.test.ts`; no cron scaffolding is needed here
 * because every reader takes the meta structurally.
 */
const SCOPED = { actionScoped: true };

describe('actionOf — the single reader of the discriminator', () => {
  it('returns null without a declaration, whatever the args carry', () => {
    expect(actionOf({ action: 'delete' })).toBeNull();
    expect(actionOf({ action: 'delete' }, null)).toBeNull();
    expect(actionOf({ action: 'delete' }, { actionScoped: false })).toBeNull();
  });

  it('reads `action` when declared', () => {
    expect(actionOf({ action: 'delete' }, SCOPED)).toBe('delete');
  });

  it('rejects a missing, empty, or non-string action', () => {
    expect(actionOf({}, SCOPED)).toBeNull();
    expect(actionOf({ action: '' }, SCOPED)).toBeNull();
    expect(actionOf({ action: 42 }, SCOPED)).toBeNull();
    expect(actionOf(undefined, SCOPED)).toBeNull();
  });
});

describe('permissionKeyFor', () => {
  it('keys per action when declared, so a list grant cannot authorise a delete', () => {
    expect(permissionKeyFor('t', { action: 'list' }, SCOPED)).toBe('t:list');
    expect(permissionKeyFor('t', { action: 'delete', id: 'x' }, SCOPED)).toBe('t:delete');
  });

  it('fails closed when the action is unreadable', () => {
    // No stable key → no "always allow" offered; the user is asked rather than
    // handed an over-broad option.
    expect(permissionKeyFor('t', {}, SCOPED)).toBeNull();
    expect(permissionKeyFor('t', { action: 42 }, SCOPED)).toBeNull();
  });

  it('keys by name for a tool that declares no discriminator', () => {
    // The deliberate exclusion of `routine` / `specialist` / `lineup_edit`
    // (users hold stored rules keyed on the bare name) is now expressed by
    // those tools simply not declaring the field.
    expect(permissionKeyFor('routine', { action: 'delete' })).toBe('routine');
    expect(permissionKeyFor('web_read', { url: 'https://x' })).toBe('web_read');
  });

  it('shell still keys per primary command — its meta declares no discriminator', () => {
    expect(permissionKeyFor('shell', { command: 'ls -la' })).toBe('shell:ls');
    expect(permissionKeyFor('shell', { command: 'a | b' })).toBeNull();
  });
});

describe('breadthOptionsFor', () => {
  it('offers this-action / any-action when declared, rather than exact args', () => {
    const opts = breadthOptionsFor('t', { action: 'delete', id: 'x' }, SCOPED);
    expect(opts.map((o) => o.specifier)).toEqual(['action:delete', '*']);
  });

  it('mints a specifier the rule engine can actually match', () => {
    // `permissions/engine.ts` matches `action:<value>` against `args.action`.
    // A specifier minted from any other field would persist a grant that can
    // never match — which is why `actionScoped` is a flag, not a field name.
    const [thisAction] = breadthOptionsFor('t', { action: 'delete' }, SCOPED);
    expect(thisAction.specifier).toBe(`action:${actionOf({ action: 'delete' }, SCOPED)}`);
  });

  it('falls back to the exact-args ladder when no action is readable', () => {
    expect(breadthOptionsFor('t', {}, SCOPED).map((o) => o.label)).toEqual([
      'these arguments',
      'any arguments',
    ]);
  });

  it('a tool with no declared discriminator keeps the exact-args ladder', () => {
    expect(breadthOptionsFor('srv__tool', { action: 'delete' }).map((o) => o.label)).toEqual([
      'these arguments',
      'any arguments',
    ]);
  });
});
