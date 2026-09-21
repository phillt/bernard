import { ICON_SIZES, isIconName } from '../host/icons.js';
import { actionsOf, controlsOf, type AppletDesign, type Control } from './design-model.js';

/**
 * What can be decided about a design by arithmetic, before any model reads it.
 *
 * The rule this follows is the proposal's own: do not ask an LLM whether a
 * contrast ratio passes — calculate it; do not ask whether a hit target is
 * large enough — measure it; do not ask whether a spacing token is approved —
 * lint it. Ask an agent only the questions that are genuinely judgement, like
 * whether a destructive action is too prominent relative to the primary task.
 *
 * Bernard already works this way elsewhere and this extends it rather than
 * introducing it: `page-validate.ts` is regex over the page, `color.ts` is
 * WCAG arithmetic, and `tokens.test.ts` pins nineteen contrast pairs plus the
 * selector record in both directions.
 *
 * ## refuse vs warn is CERTAINTY, not severity
 *
 * Copied deliberately from `page-validate.ts`, which states it as the rule a
 * future check gets classified by. A control naming an action that does not
 * exist is decidable with certainty from the model. Whether the design has
 * "too many" controls is not, so the rendering check warns.
 *
 * ## These run BEFORE the critic, and that ordering is the point
 *
 * Everything here is free and certain. A critic that spends its judgement
 * re-deriving whether an icon name exists has less left for the question only
 * it can answer — which is the failure `applet-reviewer` shows today, where
 * most of its checklist is a restatement of rules `page-validate` already
 * enforces in code.
 */

export interface DesignIssue {
  level: 'refuse' | 'warn';
  message: string;
}

/** A control's name for a human, for an error message. */
function nameOf(control: Control, index: number): string {
  return control.label ?? control.actionId ?? control.icon ?? `control ${index + 1}`;
}

/**
 * Checks one assembled design.
 *
 * Every rule is skipped rather than failed when the stage it depends on is
 * absent: planning is fail-open at every hop, so a design missing its
 * interaction stage must not be reported as a broken design.
 */
export function checkDesign(design: AppletDesign): DesignIssue[] {
  const issues: DesignIssue[] = [];
  const refuse = (message: string): void => void issues.push({ level: 'refuse', message });
  const warn = (message: string): void => void issues.push({ level: 'warn', message });

  const actions = actionsOf(design);
  const controls = controlsOf(design);
  const byId = new Map(actions.map((a) => [a.id, a]));

  /**
   * The rule the whole model exists for.
   *
   * Measured on a real applet: the architect scoped five views out by name
   * and the UX planner planned all five. The scope was passed down verbatim
   * and ignored, because prose cannot refuse. This is prose refusing.
   *
   * Only checked when the architect actually declared an action set —
   * otherwise every design built before this shipped would read as broken.
   */
  if (actions.length > 0) {
    for (const [i, control] of controls.entries()) {
      if (control.actionId === null || control.actionId === undefined) continue;
      if (byId.has(control.actionId)) continue;
      refuse(
        `"${nameOf(control, i)}" calls action "${control.actionId}", which the scope does not ` +
          `declare. Declared: ${actions.map((a) => a.id).join(', ') || '(none)'}. Either the ` +
          'control is out of scope, or the scope needs widening deliberately.',
      );
    }

    // The other direction: an action nothing can reach is dead weight in the
    // manifest, and it fails as an applet that quietly cannot do what it says.
    const reached = new Set(controls.map((c) => c.actionId).filter(Boolean));
    for (const action of actions) {
      if (!reached.has(action.id)) {
        warn(`Action "${action.id}" has no control, so nothing on the page can reach it.`);
      }
    }
  }

  for (const [i, control] of controls.entries()) {
    const action = control.actionId ? byId.get(control.actionId) : undefined;
    const name = nameOf(control, i);

    /**
     * Destructive work is confirmed and looks destructive.
     *
     * Decidable from the model, and currently decided nowhere: on the applet
     * that prompted this, `Remove` sat in a flat control list beside `Open`
     * with nothing marking it, and the `danger` class was added ad hoc by the
     * page writer rather than chosen upstream.
     *
     * Keyed on `intent: 'destroy'` OR `risk: 'high'` — an irreversible
     * high-risk action is destructive whatever its verb, and a send is the
     * case that makes the second clause necessary.
     */
    if (action && (action.intent === 'destroy' || action.risk === 'high')) {
      if (control.confirm !== true) {
        refuse(
          `"${name}" is ${action.intent === 'destroy' ? 'destructive' : 'high risk'} and must ` +
            'ask before it acts. Set `confirm: true`.',
        );
      }
      if (control.variant !== 'danger') {
        refuse(
          `"${name}" is ${action.intent === 'destroy' ? 'destructive' : 'high risk'} and must ` +
            'not look like the harmless controls. Use `variant: "danger"` (`button.danger`).',
        );
      }
    }

    /**
     * An icon-only control is announced.
     *
     * Unenforced until now, and `src/host/icons.ts` says so in as many words:
     * "the planners are told to demand it there". A prompt instruction is not
     * an enforcement, and the failure is total rather than cosmetic — a
     * control with no text and no label is not reachable by a screen reader
     * at all.
     */
    if (control.icon && !control.label && !control.iconTitle) {
      refuse(
        `"${name}" is icon-only, so it needs \`iconTitle\` — without one it is unusable to a ` +
          'screen reader and shows no tooltip.',
      );
    }

    /**
     * Icon names and sizes exist.
     *
     * A name the set does not have renders as NOTHING — `bernard.icon`
     * returns '' and the hydrator skips the node — so this fails invisibly,
     * with no error and no gap in the layout to notice. Refused here, where
     * the name is a literal in a plan, rather than warned as it is in
     * `page-validate`, where the name may be built at runtime.
     */
    if (control.icon && !isIconName(control.icon)) {
      refuse(
        `"${name}" uses icon "${control.icon}", which does not exist and would render as ` +
          'nothing. See the `applet-styling` document for the set.',
      );
    }
    if (control.iconSize && !(control.iconSize in ICON_SIZES)) {
      refuse(
        `"${name}" uses icon size "${control.iconSize}". The sizes are ` +
          `${Object.keys(ICON_SIZES).join(', ')}.`,
      );
    }
  }

  /**
   * The rendering choice agrees with the control count.
   *
   * `UI_RUNTIME_RULE` is already written as a countable test — "a LIST that
   * changes, or has more than about four controls" — so the half of it that
   * is a count can simply be counted. A warning rather than a refusal because
   * the other half is not countable: a page with three controls and a
   * changing list is correctly `runtime`, and this cannot see the list.
   */
  if (design.ux?.rendering === 'plain' && controls.length > 4) {
    warn(
      `The plan says \`rendering: "plain"\` with ${controls.length} controls. The rule is more ` +
        'than about four controls, or a list that changes — check this is deliberate.',
    );
  }

  return issues;
}

/** Renders issues for a model, or '' when there are none. */
export function renderDesignIssues(issues: DesignIssue[]): string {
  if (issues.length === 0) return '';
  const refusals = issues.filter((i) => i.level === 'refuse');
  const warnings = issues.filter((i) => i.level === 'warn');
  const lines: string[] = [];
  if (refusals.length > 0) {
    lines.push('### Fix before building', '');
    for (const i of refusals) lines.push(`- ${i.message}`);
    lines.push('');
  }
  if (warnings.length > 0) {
    lines.push('### Worth checking', '');
    for (const i of warnings) lines.push(`- ${i.message}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
