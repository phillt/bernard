import type { PolicyDecision, SubPolicy } from './types.js';

type ToolMode = NonNullable<PolicyDecision['toolMode']>;

/**
 * Default tool-mode: writes allowed, with the existing per-command
 * confirmation prompts intact (see `BERNARD_TMP_PREFIX` safelist in
 * `src/tools/shell.ts`). Issue #144 will narrow to `'read-only'` for
 * questions and other low-risk asks based on `userInput` and tool
 * metadata from #176.
 */
export const toolModePolicy: SubPolicy<ToolMode> = () => ({
  mode: 'write',
  requireConfirmForWrite: true,
  reason: 'config-default',
});
