import * as fs from 'node:fs';
import * as path from 'node:path';
import { isContainedIn, resolveForComparison } from '../permissions/write-scope.js';

/**
 * Serving an applet's own files (#421).
 *
 * The containment problem here is identical to the one #340 already solved for
 * writes — "is this resolved path inside that directory?" — so this reuses
 * `isContainedIn` and `resolveForComparison` rather than growing a second path
 * check that could disagree with the first. Both traps those functions were
 * written for apply verbatim: a symlink out of the asset directory, and the
 * `/safe-dir` vs `/safe-dir-evil` prefix match a bare `startsWith` accepts.
 *
 * The bytes served are agent-generated, which is the premise of the feature.
 * That makes traversal containment mandatory rather than defensive: the
 * directory is exactly as trustworthy as the model that wrote into it.
 */

/** A file resolved for serving. */
export type AssetResult =
  | { ok: true; absPath: string; contentType: string; size: number }
  | { ok: false; status: 404 };

/**
 * Deliberately a short allowlist, not a lookup table of every known type.
 *
 * An unknown extension is served as `application/octet-stream`, which browsers
 * download rather than execute. Combined with `X-Content-Type-Options:
 * nosniff`, that means a file the applet author did not anticipate cannot be
 * coerced into running as script.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function contentTypeFor(absPath: string): string {
  return CONTENT_TYPES[path.extname(absPath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Resolves a request path to a file inside `rootDir`, or refuses.
 *
 * Refusals are all `404`, never `403`: distinguishing "outside the root" from
 * "not there" tells a prober which paths exist.
 */
export function resolveAsset(rootDir: string, urlPath: string): AssetResult {
  // Strip the query/fragment and decode before any containment reasoning —
  // `%2e%2e%2f` is `../`, and a check that runs on the raw string is a check
  // that can be walked straight past.
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return { ok: false, status: 404 }; // malformed percent-encoding
  }

  // A NUL truncates the path for some syscalls while surviving string checks.
  if (decoded.includes('\0')) return { ok: false, status: 404 };

  const rel = decoded === '/' || decoded === '' ? 'index.html' : decoded.replace(/^\/+/, '');
  const candidate = path.join(rootDir, rel);

  const root = resolveForComparison(rootDir);
  const resolved = resolveForComparison(candidate);
  if (!isContainedIn(root, resolved)) return { ok: false, status: 404 };

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { ok: false, status: 404 };
  }

  // A directory request serves its index; anything that is not a regular file
  // — a fifo, a socket, a device — is not servable and reading it could block.
  if (stat.isDirectory()) {
    const index = path.join(resolved, 'index.html');
    try {
      const indexStat = fs.statSync(index);
      if (!indexStat.isFile()) return { ok: false, status: 404 };
      return {
        ok: true,
        absPath: index,
        contentType: contentTypeFor(index),
        size: indexStat.size,
      };
    } catch {
      return { ok: false, status: 404 };
    }
  }
  if (!stat.isFile()) return { ok: false, status: 404 };

  return { ok: true, absPath: resolved, contentType: contentTypeFor(resolved), size: stat.size };
}
