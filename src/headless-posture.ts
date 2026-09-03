import type { ConfirmActionInput, ToolOptions } from './tools/types.js';
import type { ConfirmThreshold } from './risk.js';
import { shouldConfirm } from './risk.js';
import { thresholdForMode } from './policy/tool-mode.js';
import type { WriteScope } from './permissions/write-scope.js';
import type { PermissionRule } from './tool-permissions.js';

/**
 * The permission posture a run with no user present executes under, and the
 * `ToolOptions` that posture produces.
 *
 * **A leaf, deliberately.** It lived inside `src/headless.ts`, which imports
 * `MCPManager`, `RAGStore`, `framework/context` and the whole agent-definition
 * registry — so `src/apps/tool-dispatch.ts`, whose entire premise is that a
 * deterministic action does not pay for an agent runtime, was importing 161 ms
 * of module graph to call `resolvePosture`. Its real dependencies cost 3 ms.
 *
 * The other half of why it is shared: {@link headlessToolOptions}'s security
 * property is what it OMITS, and an omission cannot be type-checked. Two
 * hand-written copies of the same omissions is how one of them quietly grows a
 * `blockAction` and stops failing closed, with every test still green.
 */

/**
 * Resolved permission posture for one headless run.
 *
 * Extracted from `src/cron/runner.ts`'s `CronJobPermissionPosture` (#419) so
 * that cron is one caller of a general mechanism rather than the only place
 * Bernard knows how to run without a user present.
 */
export interface HeadlessPosture {
  /** Resolved tool gate mode — drives the block gate in `augmentTools`. */
  toolMode: 'read-only' | 'write';
  /** Resolved confirm mode label (for Agent Status snapshots). */
  confirmMode: 'off' | 'auto' | 'strict';
  /** Resolved confirm threshold — drives the confirm gate in `augmentTools`. */
  confirmThreshold: ConfirmThreshold;
  /** Resolved write scope — drives the write-scope gate. `null` = unrestricted. */
  writeScope: WriteScope | null;
  /**
   * Resolved permission rules — drive the deny gate (#420). `null` = none
   * apply, which is what every headless run did before apps existed.
   */
  toolPermissions: PermissionRule[] | null;
  /**
   * Headless confirm action callback: auto-approves or auto-denies based on
   * `confirmThreshold` without ever prompting the user.
   *
   * Note: `shell.ts` only invokes `confirmDangerous` when `confirmAction` is
   * ABSENT (see the `!options.confirmAction` guard). Since a headless run
   * always wires `confirmAction`, dangerous shell commands are governed by
   * this callback (and by the `confirmThreshold` gate in `augmentTools` that
   * decides whether to call it at all). With default/auto posture the
   * threshold is 'high' and dangerous commands (risk:'high') are auto-denied
   * via this callback. With `skipPermissions:true` the threshold is 'never' so
   * this callback is never called and dangerous commands are allowed — the
   * caller opted in to "no safeguards" explicitly.
   */
  confirmAction: (input: ConfirmActionInput) => Promise<boolean>;
}

/**
 * The posture a caller is asking for.
 *
 * `toolMode` and `confirmMode` are REQUIRED, deliberately: this module owns the
 * rules, not the defaults. Cron's default is `write` because its jobs opted in
 * to writes at creation time (a legacy fact about cron records), while a
 * script action's default is `read-only` because an external caller has opted
 * in to nothing. Defaulting here would quietly make one entry point's history
 * the other's security posture.
 */
export interface HeadlessPostureInput {
  toolMode: 'read-only' | 'write';
  confirmMode: 'off' | 'auto' | 'strict';
  /**
   * Where this run may write (#340), or `null` for no restriction.
   *
   * **Required, like the other two axes and for the same reason.** An optional
   * field would let a caller inherit "unrestricted" by omission — which is
   * exactly what happened: applet actions (`src/apps/dispatch.ts`) shipped
   * with no scope while being the *less* trusted origin. Stating `null` is a
   * decision; omitting a field is an accident.
   */
  writeScope: WriteScope | null;
  /**
   * Persisted permission rules this dispatch runs under (#420), or `null`.
   *
   * **Required, for the same reason as `writeScope`.** The rules an app runs
   * under are the app's own, granted by the user through `bernard app-grant`
   * — never `config.toolPermissions`, which holds the *user's* grants. An app
   * inheriting "always allow `shell rm *`" because a caller omitted a field is
   * precisely the confused-deputy widening #420 exists to prevent, so the
   * field cannot be omitted.
   *
   * Cron passes `null`: its jobs have never honoured profile grants, and that
   * stays true by being stated rather than by being the default.
   */
  toolPermissions: PermissionRule[] | null;
  skipPermissions?: boolean;
}

/**
 * Derives a headless permission posture from a requested `toolMode`,
 * `confirmMode`, and the `skipPermissions` escape hatch.
 *
 * `skipPermissions === true` collapses both axes to write + off — all gates
 * dissolved, including dangerous-shell denial, because the caller explicitly
 * opted in to "no safeguards".
 *
 * Otherwise the two axes are intentionally orthogonal: `confirmMode:'off'`
 * (threshold `'never'`) does NOT bypass the `toolMode:'read-only'` block gate.
 * The block gate is driven by `toolMode`; the confirm gate is driven by
 * `confirmThreshold`. Both are wired independently into `augmentTools` via
 * `ctx.policyDecision.toolMode`.
 *
 * Uses the canonical `thresholdForMode` from `src/policy/tool-mode.ts` so the
 * `confirmMode → ConfirmThreshold` mapping stays in one place.
 */
export function resolvePosture(input: HeadlessPostureInput): HeadlessPosture {
  const toolMode: 'read-only' | 'write' = input.skipPermissions ? 'write' : input.toolMode;

  const confirmMode: 'off' | 'auto' | 'strict' = input.skipPermissions ? 'off' : input.confirmMode;

  // `skipPermissions` dissolves ALL gates, this one included. Leaving the
  // write scope in place would make a job the user explicitly marked
  // unrestricted still refuse `file_write` outside its workspace — while
  // `shell` in that same job stayed wide open, because shell DOES dissolve.
  // The net effect would be pushing the model toward the less safe tool.
  const writeScope: WriteScope | null = input.skipPermissions ? null : input.writeScope;

  // Dissolved by `skipPermissions` like every other gate — a run marked
  // unrestricted that still refused a denied tool would be the same
  // steer-toward-the-ungated-tool asymmetry the write scope had.
  const toolPermissions: PermissionRule[] | null = input.skipPermissions
    ? null
    : input.toolPermissions;

  const confirmThreshold: ConfirmThreshold = thresholdForMode(confirmMode);

  // Headless decision: approve unless the risk crosses the resolved threshold.
  // Reuses `shouldConfirm` (the canonical gate in augmentTools) so the
  // confirmMode → risk → allow/deny logic stays in one place.
  const confirmAction = async (i: ConfirmActionInput): Promise<boolean> =>
    !shouldConfirm(i.risk, confirmThreshold);

  return { toolMode, confirmMode, confirmThreshold, confirmAction, writeScope, toolPermissions };
}

/**
 * The `ToolOptions` a headless run hands to `augmentTools`.
 *
 * **The omissions are the mechanism, not an oversight.** `augmentTools`
 * auto-denies a write under `toolMode: 'read-only'` when `blockAction` is
 * absent, so leaving it out is what makes an unattended run fail closed;
 * `askUser` is absent because there is nobody to ask, and
 * `sessionToolAllowlist` because there is no session to unlock a tool for.
 * That is why this is one function rather than a literal each caller writes:
 * a copy that grows one of these fields opens a gate silently.
 *
 * `getToolPermissions` is supplied only when the posture carries rules (#420),
 * and as a live reader rather than a captured array, matching the REPL — so an
 * edit to a grant applies to the next dispatch with no restart. `null` — cron
 * — omits it, and `augmentTools` then reads no rules at all.
 */
export function headlessToolOptions(posture: HeadlessPosture, shellTimeout: number): ToolOptions {
  return {
    shellTimeout,
    // Unreachable, but required by ToolOptions — see
    // HeadlessPosture.confirmAction for why wiring confirmAction retires it.
    confirmDangerous: async () => false,
    confirmAction: posture.confirmAction,
    ...(posture.writeScope ? { writeScope: posture.writeScope } : {}),
    ...(posture.toolPermissions ? { getToolPermissions: () => posture.toolPermissions ?? [] } : {}),
  };
}
