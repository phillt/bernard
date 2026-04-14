import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { CoreMessage } from 'ai';

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

/**
 * Loads and validates an image file from disk.
 * @throws {Error} If the file does not exist, is a directory, exceeds 10 MB, or has an unsupported extension.
 */
export function loadImage(filePath: string): ImageAttachment {
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

  const data = fs.readFileSync(resolved);

  return { path: resolved, mimeType, data };
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
 * Heuristic check for whether the given provider/model combination supports image input.
 *
 * - Anthropic: all models are treated as vision-capable (all current models are Claude 3+).
 * - OpenAI: gpt-4o, gpt-4.1, gpt-4-turbo, gpt-5, o3, and o4 families are treated as vision-capable.
 * - xAI: models containing `vision` in the name, plus grok-4 family, are treated as vision-capable.
 * - Unknown providers: optimistically allowed (the API will reject if unsupported).
 */
export function isVisionCapableModel(provider: string, model: string): boolean {
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
 * Returns a new history array where `ImagePart` entries in user messages are replaced
 * with a `[Image attached]` text placeholder. Does not mutate the original.
 * Used before persisting history to disk to avoid writing base64 data.
 */
export function stripImagesFromHistory(history: CoreMessage[]): CoreMessage[] {
  const hasImages = history.some(
    (msg) =>
      msg.role === 'user' &&
      Array.isArray(msg.content) &&
      msg.content.some(
        (p) => typeof p === 'object' && p !== null && 'type' in p && p.type === 'image',
      ),
  );
  if (!hasImages) return history;

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
