import { dispatchToolWrapper } from './tool-wrapper-run.js';
import { createAppletTool } from './applet.js';
import { AppRegistry } from '../apps/registry.js';
import { isDispatchCancellation } from '../error-taxonomy.js';
import { debugLog } from '../logger.js';
import type { AgentContext } from '../framework/context.js';

/**
 * Routing the design pass, so a built applet is a styled applet.
 *
 * `applet-styler` is a bundled specialist written to be exactly a wrapper for
 * the `applet` tool — `kind: 'tool-wrapper'`, `targetTools: ['applet',
 * 'file_read_lines']`, a full styling brief, and a `goodExample` that calls
 * `applet update {id, page}`. Until this module it had **no referrer**: the
 * only mentions in the tree were the seeding list, a prose comment in
 * `page-template.ts`, and its own drift test. So the common path ended at
 * `defaultAppletPage`, which is deliberately plain by its own docstring, and
 * the browser opened that.
 *
 * ## Why this module exists at all, rather than a line in `applet.ts`
 *
 * `dispatchToolWrapper` needs a live {@link AgentContext}, and the `applet`
 * tool has none: `createTools` is documented as a pure function of its
 * arguments — "no ctx, no policy, no per-turn state" — because the main
 * agent's tool block must stay byte-identical for the prompt cache. A captured
 * ctx is worse than none: `Agent.processInput` re-points `this.ctx` every turn,
 * so a tool closing over one forwards a `policyDecision` that is permanently
 * `undefined` (#332).
 *
 * So the ctx-taking half lives here and is built per turn in
 * `framework/agents/main.ts`, beside `createSubAgentTool(ctx)` and its
 * siblings — the existing idiom for a tool that needs live state. `applet.ts`
 * receives a plain callback and never imports `AgentContext`, which keeps that
 * layering intact and lets both sides be tested without the other.
 *
 * ## The split is also the recursion guard, for free
 *
 * The styler writes by calling `applet update`, and it really does get an
 * `applet` tool: `dispatchToolWrapper` builds its registry at `surface:
 * 'full'`, and `buildChildTools` keeps `applet` because `targetTools` names it.
 * But that registry comes from **`createTools`, which is ctx-free** — so the
 * `applet` instance the styler holds has no styler of its own and cannot
 * re-enter this dispatch. Only the instance `main.ts` builds can style.
 *
 * That is structurally the same argument `wrap-with-specialist.ts` already
 * makes for the shim ("routing is only applied on the main agent … to avoid
 * recursion"), and it means no re-entrancy flag, no depth counter and no new
 * state. It is load-bearing rather than incidental, so `applet-styling.test.ts`
 * asserts it against the registry `createTools` actually returns: moving the
 * override into `createTools` must fail a test rather than hang a session.
 */

/** What the styling pass did, as the caller has to render it either way. */
export type StyleOutcome = { styled: true; summary: string } | { styled: false; reason: string };

/** The applet a styling pass is being asked to work on. */
export interface StyleTarget {
  id: string;
  name: string;
  description: string;
  actions: string[];
  /**
   * The applet's intent, already rendered (#463).
   *
   * The research behind the brief is explicit that UI should be derived from
   * real behaviour and context rather than generic chrome — its own example is
   * that someone working with wet hands needs large controls. A styler given
   * only a name and three action names cannot make that call; one told where
   * and when the applet is used can. Pre-rendered rather than the raw record so
   * this module keeps no opinion about the brief's shape.
   */
  intent?: string;
}

/**
 * Restyles one applet's page. Never throws, and never reports a failure as a
 * success — a caller folds the outcome into its own result.
 */
export type AppletStyler = (target: StyleTarget, signal?: AbortSignal) => Promise<StyleOutcome>;

/** The specialist this routes to. Bundled, so it is always present. */
export const STYLER_SPECIALIST_ID = 'applet-styler';

/**
 * The brief handed to the styler.
 *
 * Names `applet update {id, page}` explicitly because that is the call its own
 * `goodExample` makes — the brief agrees with what the record already teaches
 * rather than competing with it. The action names are listed because the page
 * has to wire a control to each one, and `bernard.invoke('X')` with an
 * undeclared `X` is a refusal at the write path.
 *
 * Deliberately carries ONLY the per-applet facts. The page contract, the token
 * vocabulary and the `result` shape all live in the specialist's own
 * systemPrompt; restating them here would be a second copy that drifts — and
 * the first draft's "it currently has the default scaffold page" was already
 * false on the `style` path, which restyles a page that may be styled already.
 */
export function buildStyleBrief(target: StyleTarget): string {
  const actions =
    target.actions.length > 0
      ? target.actions.map((a) => `\`${a}\``).join(', ')
      : 'none — the page has no buttons to wire';
  return [
    `Style the applet "${target.name}" (id \`${target.id}\`).`,
    '',
    `What it is for: ${target.description}`,
    `Actions it declares: ${actions}`,
    ...(target.intent ? ['', 'What is known about how it will be used:', target.intent] : []),
    '',
    'Read the current page first',
    `(\`applet\` with \`{"action":"read","id":"${target.id}"}\`), then write the styled`,
    `page with \`applet\` and \`{"action":"update","id":"${target.id}","page":"<the full HTML>",` +
      `"note":"<one line on what you changed>"}\`. The note is required and lands in the`,
    "applet's design brief, which the next editor reads.",
    '',
    'Keep every declared action reachable from a control.',
  ].join('\n');
}

/**
 * Builds the styling callback for one turn's context.
 *
 * `skipCorrectionEnqueue` is not optional here. `applet-styler` is
 * `kind: 'tool-wrapper'` whose `targetTools[0]` is `applet`, which is exactly
 * the shape `dispatchToolWrapper` enqueues a correction candidate for — and
 * `permissionsFor` grants bundled records `canAppendExamples: true`, so the
 * queue really can reach and teach a shipped specialist. A styling pass that
 * failed because the pool was full is not a call-shape mistake, and the
 * correction agent has nothing to learn from it. This is the field's first
 * production caller; before it, nothing set it.
 */
export function makeAppletStyler(ctx: AgentContext): AppletStyler {
  return async (target, signal) => {
    try {
      const wrapped = await dispatchToolWrapper(
        {
          specialistId: STYLER_SPECIALIST_ID,
          input: buildStyleBrief(target),
          runLabel: `[style] ${target.name}`,
          skipCorrectionEnqueue: true,
          // Per CALL, not per construction: the tool is built once a turn but
          // the signal belongs to the invocation. Without it an Esc during
          // `applet create` leaves a full sub-agent run — seconds of wall time
          // and a paid completion — running to completion with its output
          // discarded.
          ...(signal ? { abortSignal: signal } : {}),
        },
        ctx,
      );
      if (wrapped.status === 'ok') {
        // Empty is a legitimate summary — both render sites already test it
        // for truthiness, so an absent field bought a second shape and no
        // information.
        return {
          styled: true,
          summary: typeof wrapped.result === 'string' ? wrapped.result.trim() : '',
        };
      }
      // `error` is the taxonomy-ish code (`pool_exhausted`, `no_api_key`,
      // `not_found`, `runtime_error`); `result` is the human message. The code
      // is what a reader acts on, so it leads.
      return { styled: false, reason: wrapped.error ?? String(wrapped.result ?? 'unknown') };
    } catch (err) {
      // A cancelled turn is not a styling failure and must not be reported as
      // one — but it must not take the create down either, since the applet is
      // already written. The caller renders "not styled" and moves on.
      const reason = isDispatchCancellation(err)
        ? 'cancelled'
        : err instanceof Error
          ? err.message
          : String(err);
      debugLog('applet:style:error', { appId: target.id, reason });
      return { styled: false, reason };
    }
  };
}

/**
 * The `applet` tool with the design pass wired in — what `main.ts` builds.
 *
 * `seed: false` because `createTools` already constructed a seeding registry
 * this same turn, so re-seeding would be filesystem work for a result already
 * on disk. Schema and description are untouched, so the tool block stays
 * byte-identical and the prompt cache is unaffected.
 */
export function createAppletToolWithStyling(ctx: AgentContext) {
  return createAppletTool(
    new AppRegistry({ seed: false }),
    ctx.toolOptions.requestPermissionConsent,
    makeAppletStyler(ctx),
  );
}
