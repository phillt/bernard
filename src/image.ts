import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { CoreMessage } from 'ai';
import { findModelMetaByName, getModelMeta } from './providers/catalog.js';

/** Describes a loaded image ready to be attached to a user message. */
export interface ImageAttachment {
  /** Resolved absolute path (for display/logging). */
  path: string;
  /** MIME type, e.g. `'image/png'`. */
  mimeType: string;
  /** Raw image bytes — the AI SDK accepts `Buffer` as `DataContent`. */
  data: Buffer;
}

/** Map of lowercase file extensions to MIME types supported by vision models. */
export const SUPPORTED_EXTENSIONS = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);

/** Maximum file size for image uploads (10 MB). */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/**
 * Flat token estimate per image for pre-flight compression/truncation checks.
 * Actual token costs vary by model and resolution, but 1000 is a safe overestimate.
 */
export const IMAGE_TOKEN_ESTIMATE = 1000;

/**
 * Regex matching tokens that look like file paths ending in a supported image extension.
 * Handles absolute paths, relative paths, `~` home-dir expansion, and quoted paths.
 */
const IMAGE_PATH_RE =
  /(?:"([^"]+\.(?:png|jpe?g|gif|webp))"|'([^']+\.(?:png|jpe?g|gif|webp))'|((?:[~.]?\/|\.\.\/)?[\w.\-\/]+\.(?:png|jpe?g|gif|webp)))/gi;

/** Returns the MIME type for a file path based on its extension, or `null` if unsupported. */
export function detectMimeType(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS.get(ext) ?? null;
}

/**
 * Expands `~` at the start of a path to the user's home directory.
 */
function expandHome(filePath: string): string {
  if (filePath === '~') {
    return os.homedir();
  }
  if (filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

/** A path that passed every check except being read. */
export interface ValidatedImagePath {
  path: string;
  mimeType: string;
}

/**
 * Validates an image path without reading it.
 *
 * Split from {@link loadImage} because the two halves cost wildly different
 * amounts: the checks are a `statSync` and an extension lookup — microseconds
 * — while the read is up to 10 MB of **synchronous** I/O, which in this
 * process blocks the Ink render loop and every concurrent dispatch. A caller
 * that may still refuse the work (a saturated agent pool, a disabled
 * specialist, an unknown provider) wants the cheap half up front and the
 * expensive half only once the work is actually going to happen.
 *
 * @throws {Error} If the file does not exist, is a directory, exceeds 10 MB,
 *   or has an unsupported extension.
 */
export function validateImagePath(filePath: string): ValidatedImagePath {
  const resolved = path.resolve(expandHome(filePath));

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`Image file not found: ${resolved}`);
  }

  if (stat.isDirectory()) {
    throw new Error(`Path is a directory, not an image file: ${resolved}`);
  }

  if (stat.size > MAX_IMAGE_SIZE) {
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
    throw new Error(`Image file too large (${sizeMB} MB, max 10 MB): ${resolved}`);
  }

  const mimeType = detectMimeType(resolved);
  if (!mimeType) {
    const ext = path.extname(resolved);
    throw new Error(
      `Unsupported image format "${ext}". Supported: ${[...SUPPORTED_EXTENSIONS.keys()].join(', ')}`,
    );
  }

  return { path: resolved, mimeType };
}

/** Reads a path {@link validateImagePath} already approved. */
export function readValidatedImage(validated: ValidatedImagePath): ImageAttachment {
  return { ...validated, data: fs.readFileSync(validated.path) };
}

/**
 * Loads and validates an image file from disk.
 * @throws {Error} If the file does not exist, is a directory, exceeds 10 MB, or has an unsupported extension.
 */
export function loadImage(filePath: string): ImageAttachment {
  return readValidatedImage(validateImagePath(filePath));
}

/**
 * Like `loadImage`, but returns `null` instead of throwing.
 * Used for inline detection where a non-existent or invalid file should be silently skipped.
 */
export function tryLoadImage(filePath: string): ImageAttachment | null {
  try {
    return loadImage(filePath);
  } catch {
    return null;
  }
}

/**
 * Scans user text for tokens that look like file paths ending in supported image extensions.
 * Returns the extracted path strings (with `~` expansion applied).
 */
export function extractImagePaths(text: string): string[] {
  const paths: string[] = [];
  let match: RegExpExecArray | null;
  IMAGE_PATH_RE.lastIndex = 0;
  while ((match = IMAGE_PATH_RE.exec(text)) !== null) {
    // Groups: 1 = double-quoted, 2 = single-quoted, 3 = unquoted
    const raw = match[1] ?? match[2] ?? match[3];
    if (raw) {
      paths.push(expandHome(raw));
    }
  }
  return paths;
}

/**
 * Removes image-path tokens from user text. Used to sanitize input before handing it to
 * the reference resolver so attachment paths aren't mistaken for unresolved entities.
 */
export function stripImagePaths(text: string): string {
  const re = new RegExp(IMAGE_PATH_RE.source, 'gi');
  return text.replace(re, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Heuristic check for whether the given provider/model combination supports image input.
 *
 * Consults the model catalog first (`tags` includes `vision` or `file-input`).
 * Falls back to name-based pattern matching when the model isn't in the
 * catalog (custom providers, brand-new releases the catalog hasn't refreshed).
 *
 * - Anthropic: all models are treated as vision-capable (all current models are Claude 3+).
 * - OpenAI: gpt-4o, gpt-4.1, gpt-4-turbo, gpt-5, o3, and o4 families are treated as vision-capable.
 * - xAI: models containing `vision` in the name, plus grok-4 family, are treated as vision-capable.
 * - Unknown providers: optimistically allowed (the API will reject if unsupported).
 */
export function isVisionCapableModel(provider: string, model: string): boolean {
  // Provider-scoped FIRST. `findModelMetaByName` searches every built-in
  // provider and returns the first hit, so a custom-provider model whose name
  // collides with a catalog entry — an Ollama or internal-proxy `llava`, say —
  // would inherit a stranger's capability tags. The name-only lookup stays as
  // a fallback, because a custom provider is not in `BUILTIN_PROVIDERS` and
  // `getModelMeta` returns null for it by design.
  const meta = getModelMeta(provider, model) ?? findModelMetaByName(model);
  if (meta) {
    return meta.tags.includes('vision') || meta.tags.includes('file-input');
  }
  switch (provider) {
    case 'anthropic':
      return true;

    case 'openai': {
      const m = model.toLowerCase();
      if (m.startsWith('gpt-4o') || m.startsWith('gpt-4.1') || m.startsWith('gpt-4-turbo'))
        return true;
      if (m.startsWith('gpt-5')) return true;
      if (m.startsWith('o3') || m.startsWith('o4')) return true;
      return false;
    }

    case 'xai': {
      const m = model.toLowerCase();
      if (m.includes('vision')) return true;
      if (m.startsWith('grok-4')) return true;
      return false;
    }

    default:
      // Unknown provider — optimistically allow (the API will reject if unsupported)
      return true;
  }
}

/**
 * Estimates the token count contribution of a single content part.
 * For image parts, returns the flat IMAGE_TOKEN_ESTIMATE instead of serializing the binary data.
 */
export function estimateContentPartTokens(part: unknown): number {
  if (typeof part !== 'object' || part === null || !('type' in part)) {
    return Math.ceil(JSON.stringify(part).length / 3.6);
  }
  const typed = part as { type: string; text?: string };
  if (typed.type === 'image' || typed.type === 'file') {
    return IMAGE_TOKEN_ESTIMATE;
  }
  if (typed.type === 'text' && typeof typed.text === 'string') {
    return Math.ceil(typed.text.length / 3.6);
  }
  return Math.ceil(JSON.stringify(part).length / 3.6);
}

/**
 * True when any user message carries an image part.
 *
 * One predicate, two consumers: {@link stripImagesFromHistory} and the
 * dispatch vision gate (#427). They were briefly separate and had already
 * disagreed — the gate matched any NON-TEXT part while the sanitizer replaced
 * only `image` ones, so a part kind only one of them knew about would trip the
 * gate and then survive the sanitize, reaching a model that cannot read it.
 * Sharing the predicate makes that disagreement unrepresentable.
 */
export function hasImagePart(messages: CoreMessage[]): boolean {
  return messages.some(
    (msg) =>
      msg.role === 'user' &&
      Array.isArray(msg.content) &&
      msg.content.some(
        (p) => typeof p === 'object' && p !== null && 'type' in p && p.type === 'image',
      ),
  );
}

/**
 * Returns a new history array where `ImagePart` entries in user messages are replaced
 * with a `[Image attached]` text placeholder. Does not mutate the original.
 * Used before persisting history to disk to avoid writing base64 data.
 */
export function stripImagesFromHistory(history: CoreMessage[]): CoreMessage[] {
  if (!hasImagePart(history)) return history;

  return history.map((msg) => {
    if (msg.role !== 'user' || typeof msg.content === 'string' || !Array.isArray(msg.content)) {
      return msg;
    }

    let changed = false;
    const newContent = msg.content.map((part) => {
      if (typeof part === 'object' && part !== null && 'type' in part && part.type === 'image') {
        changed = true;
        return { type: 'text' as const, text: '[Image attached]' };
      }
      return part;
    });

    return changed ? { ...msg, content: newContent } : msg;
  });
}
