/**
 * @module watchers/extract
 *
 * Pulling the value a watcher actually cares about out of whatever a probe
 * returned, and reducing it to something comparable. A pure leaf: no imports.
 *
 * The path spelling is `$.a.b[0]`, reusing the `$.` prefix `apps/manifest.ts`
 * already defines (`ARG_REF_PREFIX`) rather than inventing a second syntax for
 * the same idea — a user or a model who has seen one should not have to learn
 * the other. The constant is restated rather than imported, because importing it
 * would give this leaf an edge to the manifest schema module and its zod graph;
 * a test pins the two together, the treatment `docs-store.ts`'s `MAX_DOC_CHARS`
 * already gets.
 *
 * Deliberately NOT JSONPath: no filters, no wildcards, no recursive descent, no
 * expressions. A watcher path names one place in one document. Everything richer
 * is a language, and a language evaluated over untrusted server output is a
 * surface this does not need.
 */

/** Mirrors `ARG_REF_PREFIX` in `apps/manifest.ts`; pinned by a test. */
export const PATH_PREFIX = '$.';

/** A path segment: a key, or an array index. */
type Segment = { key: string } | { index: number };

/**
 * Parses `$.a.b[0].c` into segments, or `null` if it is not a well-formed path.
 *
 * `null` rather than a throw, and rather than treating a bad path as a literal:
 * a path that silently means something else is how a watcher ends up watching
 * nothing and reporting success forever.
 */
export function parsePath(path: string): Segment[] | null {
  if (!path.startsWith(PATH_PREFIX)) return null;
  const rest = path.slice(PATH_PREFIX.length);
  if (rest === '') return null;

  const segments: Segment[] = [];
  // Split on `.` first, then peel `[n]` suffixes, so `a[0][1].b` works.
  for (const raw of rest.split('.')) {
    if (raw === '') return null;
    const head = raw.match(/^[^[\]]+/)?.[0];
    if (!head) return null;
    segments.push({ key: head });
    let tail = raw.slice(head.length);
    while (tail.length > 0) {
      const m = tail.match(/^\[(\d+)\]/);
      if (!m) return null;
      segments.push({ index: Number(m[1]) });
      tail = tail.slice(m[0].length);
    }
  }
  return segments;
}

/**
 * Reads `path` out of `value`, or `undefined` if it is not there.
 *
 * Refuses to traverse into a prototype: MCP output is untrusted and reaches us
 * through `JSON.parse`, which makes `__proto__` a genuine own property — the
 * same reasoning `mcp-result-shaper.ts` records for its own walk. Benign today,
 * which is exactly why it is refused rather than relied upon.
 */
export function extractPath(value: unknown, path: string): unknown {
  const segments = parsePath(path);
  if (!segments) return undefined;
  let cur: unknown = value;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if ('index' in seg) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg.index];
      continue;
    }
    if (seg.key === '__proto__' || seg.key === 'constructor' || seg.key === 'prototype') {
      return undefined;
    }
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg.key];
  }
  return cur;
}

/**
 * A stable string for any value, so two structurally equal results digest equal.
 *
 * `collapseWhitespace` folds every STRING LEAF, not the output. That ordering is
 * the whole of it: collapsing afterwards is too late, because `JSON.stringify`
 * has already turned a real newline into the two characters `\` and `n`, which
 * are not whitespace and survive untouched. Folding leaves also reaches strings
 * nested inside an object, which is where a tool result's prose actually lives —
 * collapsing only a top-level string would leave every re-wrapped message body
 * reading as a change.
 *
 * `JSON.stringify` is not enough on its own: object key order follows insertion
 * order, and a server is free to serialise the same record differently on two
 * calls. Without sorting, a watcher fires on a key reordering and reports that
 * John replied when nothing happened — a false wake, which costs a turn and
 * teaches the user to ignore it.
 *
 * Cycles cannot occur on a `JSON.parse` result, but a `file`/`http` probe builds
 * its own object, so the seen-set stays.
 */
export function stableStringify(
  value: unknown,
  opts: { collapseWhitespace?: boolean } = {},
): string {
  const seen = new WeakSet<object>();
  const text = (v: string): string =>
    JSON.stringify(opts.collapseWhitespace ? normalizeForDigest(v) : v);
  const walk = (v: unknown): string => {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    const t = typeof v;
    if (t === 'number' || t === 'boolean') return String(v);
    if (t === 'string') return text(v as string);
    if (t !== 'object') return text(String(v));
    const obj = v as object;
    if (seen.has(obj)) return '"[circular]"';
    seen.add(obj);
    try {
      if (Array.isArray(obj)) return `[${obj.map(walk).join(',')}]`;
      const keys = Object.keys(obj as Record<string, unknown>).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${walk((obj as Record<string, unknown>)[k])}`).join(',')}}`;
    } finally {
      seen.delete(obj);
    }
  };
  return walk(value);
}

/**
 * Collapses whitespace before digesting.
 *
 * Web pages and tool output rewrap and re-indent without changing meaning, and
 * an un-normalised digest turns every one of those into a wake. This is the same
 * point the HTTP caching literature makes about weak validators: insignificant
 * whitespace should not cause validator churn.
 */
export function normalizeForDigest(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Every id at `idPath` within `value`, for an `appeared` predicate, optionally
 * narrowed by `where`.
 *
 * Takes the ARRAY the path names and reads each element's id, so
 * `$.messages[].id` is expressed as `idPath: '$.messages'` plus a trailing key —
 * see `idsAt`. Returns `null` when the path does not name a list, which the
 * caller must treat as "cannot evaluate" rather than "nothing is there": an
 * empty set would make every existing item look new on the next poll.
 */
export function idsAt(
  value: unknown,
  idPath: string,
  where?: { path: string; equals: string | number | boolean },
): string[] | null {
  // `$.messages.id` → list at `$.messages`, id key `id`.
  const lastDot = idPath.lastIndexOf('.');
  if (lastDot <= PATH_PREFIX.length - 1) return null;
  const listPath = idPath.slice(0, lastDot);
  const idKey = idPath.slice(lastDot + 1);
  if (!idKey) return null;
  const list = extractPath(value, listPath);
  if (!Array.isArray(list)) return null;
  const ids: string[] = [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    // The filter runs BEFORE the id is taken, and the same call is used to
    // capture the baseline — so the two sets always describe the same
    // population. Filtering only at compare time would make every excluded item
    // look new on every poll, forever.
    if (where !== undefined) {
      const field = (item as Record<string, unknown>)[where.path];
      if (field !== where.equals) continue;
    }
    const raw = (item as Record<string, unknown>)[idKey];
    if (typeof raw === 'string' || typeof raw === 'number') ids.push(String(raw));
  }
  return ids;
}

/**
 * Paths that WOULD work as an `idPath`, given a sample of what the target
 * returns.
 *
 * Exists because the failure it prevents is silent and total: a watcher whose
 * `idPath` names no list polls cleanly forever and can never fire. Beeper
 * returns `{items:[{id,…}]}` and the tool's own example said `$.messages.id`, so
 * a reasonable guess of `$.id` produced three watchers that looked healthy for
 * an hour and were structurally dead.
 *
 * Naming the real alternatives turns that into a self-correcting error. Scans
 * the root and one level down — deeper is a path a person would not have
 * guessed wrong in the first place.
 */
export function suggestIdPaths(value: unknown): string[] {
  const out: string[] = [];
  const idKeysOf = (arr: unknown[]): string[] => {
    const first = arr.find((x) => x !== null && typeof x === 'object');
    if (!first) return [];
    return Object.keys(first as Record<string, unknown>).filter((k) =>
      /^(id|_id|uuid|key)$/i.test(k),
    );
  };
  const visit = (node: unknown, prefix: string, depth: number): void => {
    if (depth > 1 || node === null || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (Array.isArray(child)) {
        for (const idKey of idKeysOf(child)) out.push(`${prefix}.${key}.${idKey}`);
      } else {
        visit(child, `${prefix}.${key}`, depth + 1);
      }
    }
  };
  visit(value, PATH_PREFIX.slice(0, -1), 0);
  return out.slice(0, 5);
}
