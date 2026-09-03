import type { RiskLevel } from '../risk.js';
import type { PermissionRule } from '../tool-permissions.js';
import type { WriteScope } from '../permissions/write-scope.js';
import type { BreadthOption } from '../permissions/breadth.js';

/**
 * Input passed to the unified pre-execution confirmation callback (issue #144).
 *
 * The augment layer assembles this from each intercepted tool call:
 * `toolName` and `args` come straight from the call, `risk` is derived from
 * the tool's `ToolMeta` via `riskFromMeta`, and `reason` is a short
 * human-readable description for the prompt UI.
 */
export interface ConfirmActionInput {
  /** Registry name of the tool about to run. */
  toolName: string;
  /** Raw arguments object the model passed (after any wrapper/shim rewriting). */
  args: unknown;
  /** Risk tier resolved from tool metadata. */
  risk: RiskLevel;
  /** One-line human description rendered to the user; e.g. the shell command. */
  reason: string;
  /**
   * Profile-grant key for this call (#212): `shell:<primary>` for simple
   * shell commands, the tool name otherwise, or `null` when no stable key
   * exists (complex shell lines). `null` ⇒ the dialog hides the
   * "Always allow for this profile" option.
   */
  permissionKey?: string | null;
  /**
   * Breadth ladder (#261) for the scope axis: ordered narrow→broad scope
   * options the user picks with ←/→. Absent/empty ⇒ no profile-scope grant is
   * offered (complex/dangerous shell), so the dialog omits the profile row.
   */
  breadthOptions?: BreadthOption[];
}

/** A single question for the `askUser` callback. */
export interface AskUserQuestion {
  question: string;
  choices?: string[];
  /** When true and `choices` is present, the implementation appends an escape-hatch row that falls back to free-form input. */
  allowOther: boolean;
  /** Optional label for the escape-hatch row; defaults to a generic "Other" wording. */
  otherLabel?: string;
  /**
   * When true and `choices` is present, the menu runs in multi-select mode
   * ("select all that apply"): the user toggles checkboxes and commits the
   * whole set at once. That question's answer comes back as a `string[]`.
   */
  multiSelect?: boolean;
}

/**
 * Result of an `askUser` batch interaction. `answers`/`answered` are aligned by
 * index with the input questions; a multi-select question contributes a
 * `string[]` at its slot, every other question a plain `string`.
 */
export type AskUserBatchResult =
  | { answers: (string | string[])[] }
  | { cancelled: true; answered: (string | string[])[] };

/**
 * Input passed to the read-only block callback (issue #179). Assembled by the
 * augment layer when `toolMode === 'read-only'` and the call's meta classifies
 * it as a write/dangerous tool.
 */
export interface BlockActionInput {
  /** Registry name of the write tool that the read-only gate is blocking. */
  toolName: string;
  /** Raw arguments object the model passed. */
  args: unknown;
  /** One-line human description rendered to the user. */
  reason: string;
  /** Profile-grant key for this call (#212) — see {@link ConfirmActionInput.permissionKey}. */
  permissionKey?: string | null;
  /** Breadth ladder (#261) — see {@link ConfirmActionInput.breadthOptions}. */
  breadthOptions?: BreadthOption[];
}

/**
 * User decision returned from the block callback:
 *  - `allow-once`              — let this single call through; future calls re-prompt.
 *  - `allow-tool-for-session`  — add this tool name to the session allowlist; same-tool calls bypass the block gate.
 *  - `allow-tool-for-profile`  — persist an `allow` grant under the call's permission key in the active profile (#212). The UI layer owns the persistence; the gate just proceeds.
 *  - `deny`                    — cancel the call.
 */
export type BlockOutcome =
  | 'allow-once'
  | 'allow-tool-for-session'
  | 'allow-tool-for-profile'
  | 'deny';

/** Options shared by all tool implementations. */
export interface ToolOptions {
  /** Maximum time in milliseconds a shell command may run before being killed. */
  shellTimeout: number;
  /**
   * Callback that prompts the user for confirmation before executing a dangerous command.
   * The optional `signal` lets callers abort the prompt (e.g. when the user presses Esc).
   */
  confirmDangerous: (command: string, signal?: AbortSignal) => Promise<boolean>;
  /**
   * Unified pre-execution confirmation callback (issue #144). Invoked by the
   * augment layer before each tool call when `policyDecision.toolMode.confirmThreshold`
   * indicates the call's risk crosses the threshold.
   *
   * Returns `true` to proceed; `false` to cancel (the tool's `execute` is
   * never called and the augment layer returns a cancelled-shape result).
   * When omitted, no gating happens — every call proceeds. Cron passes a
   * fixed `(input) => input.risk !== 'high'` so headless runs auto-deny
   * high-risk actions and silently pass through the rest.
   */
  confirmAction?: (input: ConfirmActionInput, signal?: AbortSignal) => Promise<boolean>;
  /**
   * Read-only mode block callback (issue #179). Invoked by the augment layer
   * before each write/dangerous tool call when `policyDecision.toolMode.mode`
   * is `'read-only'`. The callback returns the user's enable decision; on
   * `'deny'` the underlying tool is never invoked (cancelled-shape result is
   * returned to the model with a denial message that distinguishes it from a
   * confirmation-prompt cancel).
   *
   * When omitted but `toolMode === 'read-only'`, write calls fail closed
   * (auto-denied) — secure default for headless callers that forgot to wire
   * the prompt. Cron explicitly passes `toolMode: 'write'` to opt out.
   */
  blockAction?: (input: BlockActionInput, signal?: AbortSignal) => Promise<BlockOutcome>;
  /**
   * Per-REPL-session allowlist of tool names that the user has chosen to
   * unlock via "Enable for this tool, this session" at the block-gate menu
   * (issue #179). Lives on `ToolOptions` (not inside the `augmentTools`
   * closure) so the allowlist survives across turns and is shared with
   * sub-agents and tool-wrapper specialists — otherwise the user gets
   * re-prompted on every new turn or nested call, defeating the "session"
   * label on the menu. Cleared on REPL restart (process exit).
   */
  sessionToolAllowlist?: Set<string>;
  /**
   * Callback that asks the user one or more questions in sequence. The
   * implementation owns any progress UI (e.g. a tab strip for batches of
   * 2+). On mid-batch cancellation, returns whatever was answered so far.
   * Omitted in non-interactive environments (cron daemon).
   */
  askUser?: (questions: AskUserQuestion[], signal?: AbortSignal) => Promise<AskUserBatchResult>;
  /**
   * Live reader for the active profile's persisted tool grants (#212).
   * Consulted by both augment gates before prompting: `allow` proceeds,
   * `deny` refuses, absent falls through to the prompt. A function (not a
   * snapshot) so mid-session grants and profile switches take effect
   * immediately. Omitted by cron — headless runs never honor profile grants.
   */
  getToolPermissions?: () => PermissionRule[] | undefined;
  /**
   * This dispatch's write scope (#340). When present, a path-bearing write
   * tool may only write inside the workspace or an explicit grant; when
   * absent there is no restriction.
   *
   * Absent is the interactive default on purpose — scoping writes the user is
   * watching themselves make would be obstruction, not safety. It is the
   * *unattended* writers that need a `where`.
   *
   * A plain value, not a reader. `getToolPermissions` is a thunk because the
   * REPL mutates `config.toolPermissions` mid-session; nothing mutates a
   * scope mid-run, and a thunk would advertise a mutability nothing
   * implements.
   */
  writeScope?: WriteScope;
}

/** Outcome of a shell tool invocation. */
export interface ShellResult {
  /** Combined stdout/stderr output of the command. */
  output: string;
  /** `true` when the command exited with a non-zero status or timed out. */
  is_error: boolean;
}
