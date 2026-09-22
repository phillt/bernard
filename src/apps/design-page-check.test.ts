import { describe, it, expect } from 'vitest';
import { checkPageAgainstDesign } from './design-page-check.js';
import type { AppletDesign } from './design-model.js';

/**
 * The contradiction that got through on the first real run.
 *
 * `applet-reviewer` is told to compare the page against the plan and report
 * `planMismatches`. It read the design, had every fact it needed, and missed
 * the one that was there: the plan marked `mark_bought` **secondary** and the
 * page wrote `class="primary"` on it — inside a card template, so it rendered
 * one filled button per item. Judgement missed a countable thing, so the
 * countable half moves out of judgement.
 */
const design = (over: Partial<AppletDesign> = {}): AppletDesign => ({
  interaction: {
    controls: [
      { actionId: 'list', component: 'button', label: 'Needed', variant: 'primary', icon: 'list' },
      {
        actionId: 'bought',
        component: 'button',
        label: 'Bought',
        variant: 'secondary',
        icon: 'check',
      },
      {
        actionId: 'remove',
        component: 'button',
        label: 'Remove',
        variant: 'danger',
        icon: 'trash-2',
      },
    ],
  },
  ...over,
});

const messages = (html: string, d = design()) =>
  checkPageAgainstDesign(html, d).map((i) => i.message);

/** Every icon the fixture plans, so an icon assertion does not fire by accident. */
const ICONS =
  '<span data-icon="list"></span><span data-icon="check"></span><span data-icon="trash-2"></span>';

describe('the page against its plan', () => {
  it('says nothing when the page follows it', () => {
    const html = `${ICONS}<button class="primary">Needed</button><button>Bought</button><button class="danger">Remove</button>`;
    expect(messages(html)).toEqual([]);
  });

  it('catches a page claiming more primaries than the plan allowed', () => {
    const html = `${ICONS}<button class="primary">Needed</button><button class="primary">Bought</button><button class="danger">Remove</button>`;
    expect(messages(html).join(' ')).toContain('2 control(s) `primary` where the design planned 1');
  });

  it('accepts FEWER primaries than planned', () => {
    // The direction is the whole rule: a control can be primary by position,
    // and a template renders one source button many times, so less is
    // explainable and more is not.
    const html = `${ICONS}<button>Needed</button><button>Bought</button><button class="danger">Remove</button>`;
    expect(messages(html).join(' ')).not.toContain('primary');
  });

  it('matches the class among others, not only on its own', () => {
    const html = `${ICONS}<button class="wide primary">A</button><button class="primary tall">B</button><button class="danger">R</button>`;
    expect(messages(html).join(' ')).toContain('primary');
  });

  it('catches a destructive control that lost its danger styling', () => {
    // `design-checks` already refuses a PLAN whose destructive control is not
    // danger, so reaching here means the plan was right and the page was not
    // — which is invisible until somebody presses it.
    const html = `${ICONS}<button class="primary">Needed</button><button>Bought</button><button>Remove</button>`;
    expect(messages(html).join(' ')).toContain('destructive');
  });

  it('names each icon the plan chose and the page dropped', () => {
    const html =
      '<button class="primary">Needed</button><button>Bought</button><button class="danger">Remove</button>';
    const out = messages(html).join(' ');
    expect(out).toContain('list');
    expect(out).toContain('check');
    expect(out).toContain('trash-2');
  });

  it('reads the component spelling a runtime page uses', () => {
    // The page that prompted this is Preact, where `data-icon` does not
    // survive a render and `bernard.Icon` is the only working spelling.
    const html =
      '<${bernard.Icon} name="list" /><${bernard.Icon} name="check" /><${bernard.Icon} name="trash-2" />' +
      '<button class="primary">A</button><button>B</button><button class="danger">R</button>';
    expect(messages(html)).toEqual([]);
  });

  it('checks nothing when no design was planned', () => {
    // Fail-open: an applet built without a plan is not a broken applet.
    expect(checkPageAgainstDesign('<button class="primary">x</button>', {})).toEqual([]);
  });

  it('warns rather than refuses, because none of it is certain', () => {
    const html = `${ICONS}<button class="primary">A</button><button class="primary">B</button>`;
    expect(checkPageAgainstDesign(html, design()).every((i) => i.level === 'warn')).toBe(true);
  });
});
