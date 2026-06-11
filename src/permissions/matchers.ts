/**
 * Pure specifier matchers for the deterministic permission engine (#261).
 *
 * Each matcher answers "does this rule's `specifier` cover this concrete tool
 * call?" for one family of tools. They are intentionally side-effect-free and
 * unit-tested in isolation (`matchers.test.ts`). The shell matcher operates on
 * a single already-split simple command (compound splitting + AST safety live
 * in `shell-ast.ts`).
 */

import * as path from 'node:path';
import * as os from 'node:os';

/** Stable, key-sorted JSON of an args object — used as the exact-args specifier. */
export function stableArgsString(args: unknown): string {
  const seen = new WeakSet<object>();
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return null;
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(norm);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = norm((v as Record<string, unknown>)[k]);
    }
    return out;
  };
  return JSON.stringify(norm(args));
}

/**
 * Shell specifier match for a single simple command (`program arg arg …`).
 *
 * Grammar (the subset the breadth ladder emits, plus hand-written rules):
 * - `git`        → matches only the bare command `git` (no args)
 * - `git *`      → matches `git` and `git <anything>` (trailing `*` = any/zero
 *                  further tokens), with a word boundary so `git *` ≠ `github`
 * - `git status` → matches exactly `git status`
 * - a `*` token in a non-final position matches exactly one token
 */
export function matchShellSpecifier(specifier: string, command: string): boolean {
  const specToks = specifier.trim().split(/\s+/).filter(Boolean);
  const cmdToks = command.trim().split(/\s+/).filter(Boolean);
  if (specToks.length === 0) return false;

  const trailingStar = specToks[specToks.length - 1] === '*';
  const fixed = trailingStar ? specToks.slice(0, -1) : specToks;

  if (trailingStar) {
    // Prefix match: every fixed token must equal the command token at the same
    // position; the command may carry zero or more extra trailing tokens.
    if (cmdToks.length < fixed.length) return false;
  } else if (cmdToks.length !== fixed.length) {
    return false;
  }
  for (let i = 0; i < fixed.length; i++) {
    if (fixed[i] === '*') continue; // single-token wildcard
    if (fixed[i] !== cmdToks[i]) return false;
  }
  return true;
}

/**
 * Converts a gitignore-ish glob to an anchored RegExp. `**​/` = zero or more
 * directory segments, `**` = anything, `*` = one segment (no slash).
 */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

/** Resolves a path specifier's anchor into an absolute glob pattern. */
function resolvePathAnchor(specifier: string): string {
  if (specifier.startsWith('//')) return specifier.slice(1); // //abs → /abs
  if (specifier.startsWith('~/')) return path.join(os.homedir(), specifier.slice(2));
  if (specifier.startsWith('/')) return specifier; // already absolute (ladder emits these)
  if (specifier.startsWith('./')) return path.join(process.cwd(), specifier.slice(2));
  return path.join('**', specifier); // unanchored → match at any depth
}

/**
 * gitignore-style path match. The breadth ladder emits absolute patterns
 * (exact file, then `<dir>/**`), which take the fast `/`-anchored path.
 */
export function matchPathSpecifier(specifier: string, filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') return false;
  const abs = path.resolve(filePath);
  return globToRegExp(resolvePathAnchor(specifier)).test(abs);
}

/**
 * Web specifier match. A `domain:` specifier matches the host and its
 * subdomains; anything else is treated as an exact-URL specifier.
 */
export function matchDomainSpecifier(specifier: string, url: string): boolean {
  if (!specifier.startsWith('domain:')) return specifier === url;
  const domain = specifier.slice('domain:'.length).toLowerCase();
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === domain || host.endsWith('.' + domain);
}

/** MCP/other-tool match: `*` = any args, else exact (stable) args JSON. */
export function matchMCPSpecifier(specifier: string, args: unknown): boolean {
  if (specifier === '*') return true;
  return stableArgsString(args) === specifier;
}
