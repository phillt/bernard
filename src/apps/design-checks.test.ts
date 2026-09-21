import { describe, it, expect } from 'vitest';
import { checkDesign, renderDesignIssues } from './design-checks.js';
import type { AppletDesign, ActionSemantics, Control } from './design-model.js';

const action = (over: Partial<ActionSemantics> = {}): ActionSemantics => ({
  id: 'save',
  intent: 'create',
  importance: 'primary',
  frequency: 'high',
  risk: 'low',
  reversible: true,
  ...over,
});

const control = (over: Partial<Control> = {}): Control => ({
  actionId: 'save',
  component: 'button',
  label: 'Save',
  ...over,
});

const design = (over: Partial<AppletDesign> = {}): AppletDesign => ({
  architect: { singleJob: 'log a reading', actions: [action()] },
  interaction: { controls: [control()] },
  ...over,
});

const refusals = (d: AppletDesign): string[] =>
  checkDesign(d)
    .filter((i) => i.level === 'refuse')
    .map((i) => i.message);
const warnings = (d: AppletDesign): string[] =>
  checkDesign(d)
    .filter((i) => i.level === 'warn')
    .map((i) => i.message);

describe('the scope actually binds', () => {
  /**
   * The failure this whole model exists for, as a test.
   *
   * Measured on the real `ai-systems-feed` applet: `applet-architect` put
   * "multiple views (new/read/stored/bookmarked/history)" in `outOfScope`
   * with the reason "five states turns it into a full reader app", and
   * `applet-ux-planner` planned all five anyway. The scope was passed down
   * verbatim — `buildPlannerBrief` splices the architect's body in unchanged
   * precisely so it cannot be paraphrased away — and was ignored, because
   * prose cannot refuse.
   */
  it('refuses a control for work the scope never declared', () => {
    const out = refusals(
      design({
        architect: { singleJob: 'show the latest articles', actions: [action({ id: 'fetch' })] },
        interaction: {
          controls: [
            control({ actionId: 'fetch', label: 'Refresh' }),
            control({ actionId: 'mark-read', label: 'Mark read' }),
          ],
        },
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('mark-read');
    expect(out[0]).toContain('does not declare');
    // Names what IS declared, so the remedy is visible rather than guessed at.
    expect(out[0]).toContain('fetch');
  });

  it('allows a control that drives local state rather than an action', () => {
    // A view switch or a filter is a real control with no action behind it.
    // Making that unrepresentable would push a planner into inventing a fake
    // action to describe it, which is worse than allowing the null.
    expect(refusals(design({ interaction: { controls: [control({ actionId: null })] } }))).toEqual(
      [],
    );
  });

  it('warns about a declared action nothing can reach', () => {
    const out = warnings(
      design({
        architect: { singleJob: 'x', actions: [action({ id: 'save' }), action({ id: 'export' })] },
      }),
    );
    expect(out.some((m) => m.includes('export'))).toBe(true);
  });

  it('checks nothing across stages when the architect declared no actions', () => {
    // Back-compat, and it is load-bearing: every design planned before this
    // shipped has no `actions`, and reading those as broken would make the
    // first run after an upgrade refuse everything.
    expect(
      checkDesign({
        architect: { singleJob: 'x' },
        interaction: { controls: [control({ actionId: 'whatever' })] },
      }),
    ).toEqual([]);
  });
});

describe('destructive work is confirmed and looks destructive', () => {
  const destructive = (over: Partial<Control> = {}): AppletDesign => ({
    architect: {
      singleJob: 'x',
      actions: [action({ id: 'delete', intent: 'destroy', reversible: false })],
    },
    interaction: {
      controls: [
        control({ actionId: 'delete', label: 'Delete', confirm: true, variant: 'danger', ...over }),
      ],
    },
  });

  it('accepts one that confirms and is styled danger', () => {
    expect(refusals(destructive())).toEqual([]);
  });

  it('refuses one that does not ask first', () => {
    expect(refusals(destructive({ confirm: false })).join(' ')).toContain('ask before it acts');
  });

  it('refuses one that looks like the harmless controls', () => {
    // On the applet that prompted this, `danger` was added by the page writer
    // rather than decided upstream — so nothing would have noticed its absence.
    expect(refusals(destructive({ variant: 'secondary' })).join(' ')).toContain('danger');
  });

  it('applies to a high-risk action that is not a delete', () => {
    // A send is the case that makes the second clause necessary: its verb is
    // `execute`, it is irreversible, and somebody receives the result.
    const out = refusals({
      architect: {
        singleJob: 'x',
        actions: [action({ id: 'send', intent: 'execute', risk: 'high', reversible: false })],
      },
      interaction: { controls: [control({ actionId: 'send', label: 'Send' })] },
    });
    expect(out).toHaveLength(2);
    expect(out.join(' ')).toContain('high risk');
  });

  it('leaves an ordinary action alone', () => {
    // The guard that stops this becoming "every button must confirm", which
    // is the failure mode of a rule like this.
    expect(refusals(design())).toEqual([]);
  });
});

describe('icons are a consequence, and are checked like one', () => {
  it('refuses an icon-only control with nothing to announce', () => {
    // `src/host/icons.ts` says only that "the planners are told to demand it
    // there" — a prompt instruction, enforced by nothing until now. The
    // failure is total rather than cosmetic: no text and no label means the
    // control is not reachable by a screen reader at all.
    const out = refusals(
      design({ interaction: { controls: [control({ label: undefined, icon: 'trash-2' })] } }),
    );
    expect(out.join(' ')).toContain('iconTitle');
  });

  it('accepts an icon-only control that carries a title', () => {
    expect(
      refusals(
        design({
          interaction: {
            controls: [control({ label: undefined, icon: 'trash-2', iconTitle: 'Delete reading' })],
          },
        }),
      ),
    ).toEqual([]);
  });

  it('accepts an icon beside a label with no title', () => {
    // The common case, and the one where a title would make a screen reader
    // announce the thing twice.
    expect(refusals(design({ interaction: { controls: [control({ icon: 'save' })] } }))).toEqual(
      [],
    );
  });

  it('refuses an icon name the set does not have', () => {
    // Renders as NOTHING — `bernard.icon` returns '' and the hydrator skips
    // the node — so this fails with no error and no gap to notice. Refused
    // here rather than warned as in `page-validate`, because a plan's icon
    // name is a literal and cannot have been built at runtime.
    const out = refusals(design({ interaction: { controls: [control({ icon: 'dustbin' })] } }));
    expect(out.join(' ')).toContain('dustbin');
    expect(out.join(' ')).toContain('render as nothing');
  });

  it('refuses a size outside the named scale', () => {
    const out = refusals(
      design({
        interaction: { controls: [control({ icon: 'save', iconSize: '18px' as never })] },
      }),
    );
    expect(out.join(' ')).toContain('sm, md, lg');
  });
});

describe('the rendering choice is counted, not asserted', () => {
  it('warns when plain is claimed with more than four controls', () => {
    const many = Array.from({ length: 5 }, (_, i) => control({ actionId: null, label: `c${i}` }));
    const out = warnings({ ux: { rendering: 'plain' }, interaction: { controls: many } });
    expect(out.join(' ')).toContain('5 controls');
  });

  it('warns rather than refuses, because the other half of the rule is not countable', () => {
    // `UI_RUNTIME_RULE` is "a LIST that changes, OR more than about four
    // controls". Three controls plus a changing list is correctly `runtime`,
    // and nothing here can see the list.
    const many = Array.from({ length: 6 }, (_, i) => control({ actionId: null, label: `c${i}` }));
    expect(refusals({ ux: { rendering: 'plain' }, interaction: { controls: many } })).toEqual([]);
  });

  it('says nothing when the plan already chose the runtime', () => {
    const many = Array.from({ length: 9 }, (_, i) => control({ actionId: null, label: `c${i}` }));
    expect(warnings({ ux: { rendering: 'runtime' }, interaction: { controls: many } })).toEqual([]);
  });
});

describe('fail-open', () => {
  it('checks an empty design without complaint', () => {
    // Planning is fail-open at every hop, so a design missing every stage is
    // a truthful record of a run that fell over — not a broken design.
    expect(checkDesign({})).toEqual([]);
  });

  it('falls back to the UX planner controls when interaction did not run', () => {
    // What can be checked, is. An icon typo is still a typo when the stage
    // that would have refined it never ran.
    const out = refusals({
      architect: { singleJob: 'x', actions: [action()] },
      ux: { controls: [{ actionId: 'save', label: 'Save', icon: 'nope' }] },
    });
    expect(out.join(' ')).toContain('nope');
  });
});

describe('renderDesignIssues', () => {
  it('is empty for a clean design, so a caller can test the string', () => {
    expect(renderDesignIssues([])).toBe('');
  });

  it('separates what blocks from what is worth a look', () => {
    const text = renderDesignIssues([
      { level: 'warn', message: 'w' },
      { level: 'refuse', message: 'r' },
    ]);
    // Refusals first regardless of input order: the reader acts on those.
    expect(text.indexOf('Fix before building')).toBeLessThan(text.indexOf('Worth checking'));
    expect(text).toContain('- r');
    expect(text).toContain('- w');
  });
});
