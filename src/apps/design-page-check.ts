import { controlsOf, type AppletDesign } from './design-model.js';
import type { PageIssue } from './page-validate.js';

/**
 * Does the page agree with the design it was built from?
 *
 * `applet-reviewer` is told to check exactly this and report `planMismatches`,
 * and on the first real run it read the design, had every fact it needed, and
 * missed the one contradiction that was there: the plan marked `mark_bought`
 * **secondary** and the page wrote `class="primary"` on it — inside a card
 * template, so it rendered one filled button per item. That is the failure the
 * whole design model was rebuilt to catch, arriving through the one gap the
 * model was supposed to close.
 *
 * So the countable half moves out of judgement. This is the same division
 * `design-checks.ts` makes: ask an agent whether a destructive action is too
 * prominent relative to the primary task, and COUNT how many controls claim to
 * be primary.
 *
 * ## Everything here warns, and that is the certainty rule rather than caution
 *
 * A page is markup with templates in it, so none of these is decidable with
 * certainty. A control rendered by a `.map()` appears once in the source and
 * many times on screen; a variant can be applied by a conditional expression
 * this cannot read; a page can legitimately carry a control the design never
 * planned. What IS reliable is the direction: the page claiming MORE emphasis
 * than the plan allowed, or dropping something the plan named.
 */

/** Occurrences of a class name in a `class="..."` attribute. */
function classCount(html: string, name: string): number {
  const re = new RegExp(`class=["'][^"']*\\b${name}\\b[^"']*["']`, 'gi');
  return [...html.matchAll(re)].length;
}

export function checkPageAgainstDesign(html: string, design: AppletDesign): PageIssue[] {
  const controls = controlsOf(design);
  if (controls.length === 0) return [];
  const issues: PageIssue[] = [];
  const warn = (message: string): void => void issues.push({ level: 'warn', message });

  /**
   * More primaries than the plan allowed.
   *
   * The direction matters: FEWER is fine, because a control can be primary by
   * position rather than by class and because a template renders one source
   * button many times. More is the one that cannot be explained away — every
   * extra `class="primary"` is a claim the plan did not make.
   */
  const planned = controls.filter((c) => c.variant === 'primary').length;
  const written = classCount(html, 'primary');
  if (written > planned) {
    warn(
      `The page marks ${written} control(s) \`primary\` where the design planned ${planned}. ` +
        'Every primary past the first stops the word meaning anything — check which ones the ' +
        'plan said were secondary, and leave those as a bare `button`.',
    );
  }

  /**
   * A destructive control that lost its danger styling.
   *
   * `design-checks` already refuses a plan whose destructive control is not
   * `danger`, so reaching here means the PLAN was right and the page did not
   * follow it — which is invisible, because a destructive button that looks
   * ordinary works perfectly until somebody presses it by mistake.
   */
  const dangerPlanned = controls.filter((c) => c.variant === 'danger').length;
  if (dangerPlanned > 0 && classCount(html, 'danger') === 0) {
    warn(
      `The design marks ${dangerPlanned} control(s) as destructive, and the page uses no ` +
        '`danger` class. A destructive control that looks like the harmless ones is how ' +
        'somebody clears their data by accident.',
    );
  }

  /**
   * Icons the plan chose and the page did not render.
   *
   * Named individually, because "some icons are missing" is not actionable and
   * the remedy is per control. Both spellings are scanned — the attribute a
   * plain page writes and the component a runtime page uses.
   */
  const rendered = new Set<string>();
  for (const m of html.matchAll(/data-icon=["']([a-z0-9-]+)["']/g)) rendered.add(m[1]);
  for (const m of html.matchAll(/bernard\.[Ii]con[^>]*?\bname=["']([a-z0-9-]+)["']/g)) {
    rendered.add(m[1]);
  }
  for (const m of html.matchAll(/bernard\.icon\(\s*["']([a-z0-9-]+)["']/g)) rendered.add(m[1]);
  const missing = [
    ...new Set(
      controls
        .map((c) => c.icon)
        .filter((icon): icon is string => Boolean(icon) && !rendered.has(icon as string)),
    ),
  ];
  if (missing.length > 0) {
    warn(
      `The design chose icons the page does not render: ${missing.join(', ')}. ` +
        'An icon decided upstream and dropped downstream leaves the control it was meant to ' +
        'mark looking like every other one.',
    );
  }

  return issues;
}
