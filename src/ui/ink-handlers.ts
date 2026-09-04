/**
 * @module ui/ink-handlers
 *
 * Bridge between the Ink `<App>` overlay-request closures and the
 * pre-mount `ToolOptions` callbacks built in `src/index.ts`. The mount
 * sequence is:
 *   1. `src/index.ts` builds `toolOptions` whose `confirmDangerous`,
 *      `confirmAction`, `blockAction`, and `askUser` slots read from
 *      `getInkHandlers()` at call time.
 *   2. `assembleContext({ toolOptions, … })` → `new Agent(ctx)` runs.
 *   3. `render(<App agent … />)` mounts. App's effect calls
 *      `setInkHandlers({...})` so the toolOptions callbacks resolve.
 *   4. On unmount, App calls `setInkHandlers(null)` and subsequent
 *      tool calls fail closed (deny / cancelled).
 *
 * Nothing the agent can do before mount runs through these callbacks —
 * the agent only acts on user submit, which can only fire from a
 * mounted `<Prompt>`. The null guards exist for tests and shutdown.
 */
import type { WizardResult, WizardSpec } from './overlays/wizard-types.js';
import type {
  MenuEntry,
  MenuItem,
  MenuOptions,
  ValuePromptOptions,
  ValueResult,
} from './menu-types.js';
import type {
  AskUserBatchResult,
  AskUserQuestion,
  BlockActionInput,
  BlockOutcome,
  ConfirmActionInput,
  PermissionConsentRequest,
} from '../tools/types.js';
import type { PendingPermission } from '../apps/permission-consent.js';

export type MenuResult = { cancelled: true } | { cancelled: false; index: number; item: MenuItem };

export interface InkHandlers {
  /**
   * `signal` is optional and TRAILING so the many call sites without one are
   * unaffected. It must be declared here, not only on App's own closure: the
   * registered shim is typed by this interface, and while it took two
   * parameters a signal passed through `getInkHandlers()` was silently dropped
   * one frame short of the overlay (#266).
   */
  requestMenu: (
    entries: MenuEntry[],
    options?: MenuOptions,
    signal?: AbortSignal,
  ) => Promise<MenuResult>;
  requestConfirm: (input: ConfirmActionInput, signal?: AbortSignal) => Promise<boolean>;
  requestBlock: (input: BlockActionInput, signal?: AbortSignal) => Promise<BlockOutcome>;
  requestTextInput: (options: ValuePromptOptions, signal?: AbortSignal) => Promise<ValueResult>;
  requestAskUser: (
    questions: AskUserQuestion[],
    signal?: AbortSignal,
  ) => Promise<AskUserBatchResult>;
  requestConfirmDangerous: (command: string, signal?: AbortSignal) => Promise<boolean>;
  /**
   * Ask the user to allow what an applet declared it needs (#467, #468).
   *
   * Declared on the interface for the reason the trailing `signal` above is:
   * the registered shim is typed by this interface, so a method missing here
   * is silently dropped one frame short of the overlay. Its ABSENCE at the
   * `src/index.ts` end is the fail-closed path — no handler means no consent,
   * which means no grant.
   */
  requestPermissionConsent?: (
    request: PermissionConsentRequest,
    signal?: AbortSignal,
  ) => Promise<PendingPermission[]>;
}

let registered: InkHandlers | null = null;

export function setInkHandlers(h: InkHandlers | null): void {
  registered = h;
}

export function getInkHandlers(): InkHandlers | null {
  return registered;
}
