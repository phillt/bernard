import { loadImage } from '../image.js';
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

/** Bounded in the schema too; this is the belt to that pair of braces. */
export const MAX_DISPATCH_ATTACHMENTS = 4;

export type ResolveResult =
  | { ok: true; attachments: DispatchAttachment[] | undefined }
  | { ok: false; error: string };

export function resolveAttachments(paths: string[] | undefined): ResolveResult {
  if (!paths || paths.length === 0) return { ok: true, attachments: undefined };
  if (paths.length > MAX_DISPATCH_ATTACHMENTS) {
    return {
      ok: false,
      error: `At most ${MAX_DISPATCH_ATTACHMENTS} attachments per dispatch (got ${paths.length}).`,
    };
  }
  const attachments: DispatchAttachment[] = [];
  for (const path of paths) {
    try {
      // `loadImage` resolves `~`, checks the extension and enforces
      // MAX_IMAGE_SIZE; its throw message already names the reason.
      const img = loadImage(path);
      attachments.push({
        kind: 'image',
        mimeType: img.mimeType,
        data: img.data,
        path: img.path,
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: true, attachments };
}

/** The shared schema description, so four tools cannot describe it differently. */
export const ATTACHMENTS_DESCRIPTION =
  'Absolute or ~-relative paths to image files this dispatch should be able to see ' +
  `(max ${MAX_DISPATCH_ATTACHMENTS}). The dispatched agent receives the images directly. ` +
  'Only use this when the work actually requires looking at the file.';
