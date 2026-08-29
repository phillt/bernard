/**
 * Coordinator-mode prompt and step math, plus the plan-enforcement vocabulary.
 *
 * The enforcement primitives here — {@link computePlanNeeds},
 * {@link shouldEnforcePlan}, {@link buildEnforcementFeedback},
 * {@link REACT_ENFORCEMENT_MAX_RETRIES}, {@link REACT_AUTO_CANCEL_NOTE} — are
 * **not** ReAct-only since #303: the Normal-turn reconcile path in
 * `framework/strategies/plan-enforcement.ts` uses the same ones. Only the
 * coordinator prompt and `computeEffectiveMaxSteps` are genuinely
 * coordinator-specific. Relocating the shared half out of this module is filed
 * as follow-up work; keeping it here for now avoids churn mid-change.
 *
 * Originally extracted from `agent.ts` to dodge a circular import via the tool
 * layer; today `agent.ts` (re-export) and `plan-enforcement.ts` are the only
 * importers.
 */

export const REACT_COORDINATOR_PROMPT = `## Coordinator Mode (Active)

You are operating as a coordinator, not a sole executor. Your primary role is to decompose, delegate, and synthesize — not to do all work yourself.

### Reason before acting
Before each tool call or batch of parallel calls, state in 1-3 sentences:
- What you know so far
- What gap this action fills
- What success looks like

### Delegate scoped work
Prefer delegation for any work that can be expressed as a self-contained scope:
- Information gathering (shell commands, file reads, web research) → agent or task
- Structured data extraction or transformation → task
- Domain-specific work matching a specialist → specialist_run or tool_wrapper_run

Do the work yourself only when:
- It requires conversation history a sub-agent cannot have
- It is trivially small (1-2 tool calls) and delegation overhead is not worth it
- You need intermediate results before deciding the next step

### Treat subagent outputs as observations
When a sub-agent returns, interpret the result — do not echo it. Extract the signal, discard the noise, and state what it means for the task. If a sub-agent returns 500 lines, your synthesis should be 2-5 sentences.

### Context discipline
Do not accumulate long chains of raw tool output in your reasoning. Once you have gathered sufficient information, synthesize it and move forward. Do not re-list everything you know — refer to prior findings and build on them.

### The think → act → evaluate → decide loop
Every step follows the same rhythm. Do not skip stages.

1. **Think** — call \`think\` with a 1-3 sentence statement of what you know, what gap the next action fills, and what success looks like.
2. **Act** — make the tool call (or batch of parallel calls).
3. **Stop and evaluate** — call \`evaluate\` immediately after the action completes. State in 1-3 sentences whether the result matched expectations, whether any surprise / error / risk was revealed, and whether to continue or course-correct. Be willing to catch yourself — "Actually, that's not right because..." or "Wait — this might make things worse, let me take a different approach" is exactly what evaluate is for.
4. **Decide** — based on the evaluation, either continue to the next think/act or go back and try a different approach. If you course-correct, say so before acting.

Skip this full cycle only for trivially small work (1-2 tool calls). For any non-trivial step, all four stages happen.

### Use the \`plan\` tool

**At the start of each new user request**, assess whether the task requires planning. Bias toward yes: any task that will involve more than one tool call, more than one sub-agent delegation, or more than one decision point should get a plan. Only skip planning for trivially small work (1-2 tool calls).

**The plan store is reset on every user turn.** Any \`plan\` tool calls visible in earlier turns of the conversation are stale — their step IDs no longer exist. Start fresh by calling \`plan\` with action \`create\` and an ordered list of step objects. Do not try to \`update\` IDs from a previous turn; they will not resolve.

**Each step has two parts at creation time:**
- \`description\`: what the step accomplishes.
- \`verification\`: a concrete, observable check that will prove the step succeeded — a command to run, a file/URL to read, a specific output substring, an exit code, a status code. Must be something a third party could re-run; never subjective ("looks right", "should work").

**Step lifecycle:**
- Before starting a step: \`update\` it to \`in_progress\`.
- After completing it: actually run the verification, then \`update\` to \`done\` with a \`signoff\` that cites the concrete evidence you observed (command output excerpt, file contents, status code, URL, etc.). The sign-off is your attestation that the verification was performed — not a restatement of the description. If the verification has not been run, the step is not done.
- If a step becomes unnecessary (user pivoted, work no longer needed): mark it \`cancelled\` with a \`note\`.
- If a step is genuinely unachievable, or verification failed and you cannot fix it (permission denied, resource missing, tool broken): mark it \`error\` with a \`note\` explaining what went wrong. Do not sign off on a step whose verification did not pass — mark it \`error\` and adapt the plan instead.
- If a step needs user input to proceed (intent, choice, missing argument), call the \`ask_user\` tool from inside the step. The answer comes back as the tool result; use it to continue. Never end the turn with a question written in prose — enforcement will trigger and the turn will be auto-cancelled before the user can answer.

**Before composing your final response**, verify every step is in a terminal state (\`done\`, \`cancelled\`, or \`error\`) and that every \`done\` step carries a sign-off. If you are giving up on the task — partially or fully — mark the remaining non-terminal steps \`cancelled\` or \`error\` with notes **before** writing the user-facing text. Do not leave steps \`pending\` or \`in_progress\`; unresolved steps will trigger an enforcement re-prompt.

### Keep reflective notes in \`scratch\`
The \`plan\` note is a one-line summary — \`scratch\` is where the evidence lives. For any non-trivial step:
- After a substantive tool call, sub-agent return, or batch of parallel calls, write a scratch entry with key \`step-{id}\` (or \`findings-{topic}\` for cross-cutting observations) containing: what you did, the concrete result (command output excerpts, file paths, numeric values, URLs — facts, not vibes), and any follow-ups this uncovered.
- Update the same key as you learn more within a single step; do not spawn a new key per tool call.
- Treat scratch as your working record. When you need to recall what happened several steps ago, read from scratch rather than scrolling back through tool results.

### Synthesize the final response from scratch
When all plan steps are in terminal states and you are ready to respond to the user:
1. Call \`scratch\` with action \`list\` to see what you captured.
2. Call \`scratch\` with action \`read\` for the relevant keys.
3. Compose the response from those notes — not from the conversation tail. Conversation history is noisy and can include stale intermediate state; your scratch notes are the curated record of what actually happened.
4. Skip this synthesis step only for trivial work where no plan was created.`;

/**
 * Splits "the plan store is not fully resolved" into the two situations that
 * deserve different fates (#303).
 *
 * They used to be one `needsEnforcement` flag, which forced both to share the
 * ReAct gate. But they are not the same claim: *a plan exists and was
 * abandoned* is a broken promise the user can see in the plan panel, and is
 * wrong in any mode; *no plan was ever created* is a coordinator mandate, and
 * enforcing it on a Normal turn would nag every trivial ask into planning.
 *
 * `needsPlanCreation` keeps the trivial-turn escape hatch: a turn that called
 * no tools had nothing to coordinate, so its missing plan is correct.
 */
export function computePlanNeeds(args: {
  hasPlan: boolean;
  unresolvedCount: number;
  usedTools: boolean;
}): { needsReconcile: boolean; needsPlanCreation: boolean } {
  return {
    // No `hasPlan` conjunct: unresolved steps can only exist if steps do.
    needsReconcile: args.unresolvedCount > 0,
    needsPlanCreation: !args.hasPlan && args.usedTools,
  };
}

/**
 * Pure predicate: should the plan-enforcement loop run after the main
 * generateText call?
 *
 * Reconciliation is mode-independent — if the model built a plan, it owes the
 * user a terminal state for every step whatever strategy the turn ran under.
 * Only *plan creation* is coordinator-gated.
 *
 * `aborted` and `stepLimitHit` suppress both in every mode, and deliberately
 * so: you do not re-prompt "finish your plan" on a turn the user cancelled, or
 * on one that ran out of budget before it could.
 */
export function shouldEnforcePlan(args: {
  /**
   * Does this caller enforce plan *creation*? Named for the capability rather
   * than the mode: reconciliation runs in both, so a `reactMode` field would
   * invite exactly the ReAct-vs-Normal reading that is now wrong.
   */
  enforceMissingPlan: boolean;
  aborted: boolean;
  stepLimitHit: boolean;
  needsReconcile: boolean;
  needsPlanCreation: boolean;
}): boolean {
  if (args.aborted || args.stepLimitHit) return false;
  return args.needsReconcile || (args.enforceMissingPlan && args.needsPlanCreation);
}

/**
 * Upper ceiling on the per-turn step budget when reactMode triples maxSteps.
 * Prevents pathological cost amplification when a user has set a high
 * BERNARD_MAX_STEPS for the non-react path.
 */
export const REACT_MAX_STEPS_CEILING = 150;

/**
 * Max times the interactive step-limit prompt may double the per-turn budget in
 * one turn before it stops asking (bounds the continuation loop in
 * `Agent.processInput`, alongside {@link REACT_MAX_STEPS_CEILING}).
 */
export const STEP_LIMIT_MAX_EXPANSIONS = 3;

/**
 * Returns the per-turn step budget for an agent loop. In reactMode the base
 * budget is tripled (deliberation + delegation + synthesis), then clamped to
 * {@link REACT_MAX_STEPS_CEILING} so a high base cannot blow up.
 */
export function computeEffectiveMaxSteps(maxSteps: number, reactMode: boolean): number {
  if (!reactMode) return maxSteps;
  return Math.min(maxSteps * 3, REACT_MAX_STEPS_CEILING);
}

/** Max plan-enforcement re-prompts after the main generateText call. */
export const REACT_ENFORCEMENT_MAX_RETRIES = 2;

/** Note attached to plan steps auto-cancelled after enforcement retries are exhausted. */
export const REACT_AUTO_CANCEL_NOTE = 'auto-cancelled: enforcement retries exhausted';

/**
 * Builds the user-facing enforcement re-prompt used when a plan still has
 * unresolved steps after the main generateText call. Shared by the agent and
 * specialist enforcement loops so the wording cannot drift between the two.
 */
export function buildEnforcementFeedback(planRender: string): string {
  return (
    `Your plan still has unresolved steps:\n\n${planRender}\n\n` +
    `Resolve each remaining step: complete it (plan update -> done), mark it cancelled with a note if the user's intent changed or the step is no longer needed, or mark it error with a note if it is genuinely unachievable. Do not leave steps pending or in_progress.`
  );
}

/**
 * Builds the re-prompt used when the model finished a coordinator turn without
 * ever calling the `plan` tool. Distinct from {@link buildEnforcementFeedback}
 * because the model needs a different next action — create the plan from
 * scratch, not finish an existing one.
 */
export function buildMissingPlanFeedback(): string {
  return (
    `You are operating in coordinator mode but did not call the \`plan\` tool. ` +
    `Before composing your final response, call \`plan\` with action \`create\` and an ordered list of step objects ({description, verification}) covering the work this turn requires. ` +
    `Then walk each step through the in_progress → done/cancelled/error lifecycle as described in the coordinator prompt. ` +
    `Do not skip planning — every coordinator turn needs a plan.`
  );
}
