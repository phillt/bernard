import { z } from 'zod';
import { readValidatedImage, validateImagePath, type ValidatedImagePath } from '../image.js';
import type { DispatchAttachment } from '../framework/agents/user-message.js';

/**
 * Turns the file paths a model named into bytes a dispatch can carry (#427).
 *
 * **The tool layer loads, never the framework.** A model calling `subagent` /
 * `task` / `specialist_run` / `tool_wrapper_run` passes JSON and cannot inline
 * bytes, so the only channel is a path string — and resolving it belongs here,
 * where reaching the filesystem is ordinary, rather than in
 * `framework/agents/user-message.ts`, which is a leaf on `CoreMessage` alone.
 *
 * A bad path is a model mistake: request-shaped, fixable, and reported through
 * each tool's own failure contract rather than thrown.
 */

const MAX_DISPATCH_ATTACHMENTS = 4;

export type ResolveResult =
  /** `read()` performs the I/O — call it only once the dispatch will happen. */
  { ok: true; read: () => DispatchAttachment[] } | { ok: false; error: string };

/**
 * Validates the paths a model named, WITHOUT reading them.
 *
 * Two-phase deliberately. Validation is a `statSync` and an extension check —
 * microseconds — and it is what makes a bad path cost nothing, so it happens
 * up front. The read is up to 4 × 10 MB of **synchronous** I/O (measured at
 * 17.3 ms warm), which blocks the Ink render loop and every concurrent
 * dispatch; it must not be paid by a call that is then refused for a saturated
 * pool, a disabled specialist or an unknown provider. So the caller holds a
 * thunk and invokes it once the work is committed.
 */
export function resolveAttachments(paths: string[] | undefined): ResolveResult {
  if (!paths || paths.length === 0) return { ok: true, read: () => [] };
  if (paths.length > MAX_DISPATCH_ATTACHMENTS) {
    return {
      ok: false,
      error: `At most ${MAX_DISPATCH_ATTACHMENTS} attachments per dispatch (got ${paths.length}).`,
    };
  }
  const validated: ValidatedImagePath[] = [];
  for (const p of paths) {
    try {
      validated.push(validateImagePath(p));
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return {
    ok: true,
    read: () =>
      validated.map((v) => {
        const img = readValidatedImage(v);
        return { mimeType: img.mimeType, data: img.data };
      }),
  };
}

/**
 * The whole argument, declared once.
 *
 * Four tools take it, and four copies of a zod field is four chances for the
 * description to drift. The cap is enforced in {@link resolveAttachments}
 * rather than with a `.max()` here: one place, and its message names the count
 * it actually got.
 */
export const attachmentsArg = z
  .array(z.string())
  .optional()
  .describe(
    'Absolute or ~-relative paths to image files this dispatch should be able to see ' +
      `(max ${MAX_DISPATCH_ATTACHMENTS}). The dispatched agent receives the images directly. ` +
      'Only use this when the work actually requires looking at the file.',
  );
