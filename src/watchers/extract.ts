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
 *
 * ## `maxChars` bounds the WORK and never moves a byte
 *
 * Opt-in, and the invariant is the whole contract:
 *
 * ```
 * stableStringify(v, {maxChars: N}).slice(0, N) === stableStringify(v).slice(0, N)
 * ```
 *
 * It exists for `matches`, which serialised the entire value and then kept
 * 4 KB of it — measured at 61 ms for a 12 MB payload. That is the anti-pattern
 * `renderObservation` was already fixed for, but its fix is NOT reusable here:
 * `boundedStringify` walks with `JSON.stringify`'s replacer and so does not
 * SORT KEYS, which is the one thing this function exists to do. Concretely, for
 * `{zebra:'MATCHME', alpha:'a'.repeat(5000), …}` the first 4,000 characters
 * contain `MATCHME` under `boundedStringify` and do not under this — so
 * swapping it in flips a live `matches` watcher, in either direction, while
 * looking like an optimisation.
 *
 * Bounding here instead keeps the bytes and drops only the work: emission stops
 * once the budget is spent, and both the array and object loops BREAK rather
 * than walking the tail and joining megabytes of separators. Every token the
 * walk emits is charged — string leaves, numbers, booleans, the `null` literal
 * and object KEYS — because a budget that counts only strings does not bound a
 * document that has none. Structural punctuation (braces, commas, colons) is
 * not, so the budget stays a slight under-estimate and the real output runs a
 * little past it, which is the safe direction since the caller slices anyway.
 *
 * Deliberately not applied to `digestOf`: a digest over a prefix is a different
 * digest, and every stored snapshot would be invalidated by turning it on.
 */
export function stableStringify(
  value: unknown,
  opts: { collapseWhitespace?: boolean; maxChars?: number } = {},
): string {
  // `?? Infinity` rather than an `undefined` branch at each of the three sites
  // that would otherwise need one: `Infinity - emitted` is `Infinity`,
  // `slice(0, Infinity)` returns the whole string, and `emitted >= Infinity` is
  // never true — so the unbounded path is byte-identical and no loop ever
  // breaks.
  const budget = opts.maxChars ?? Infinity;
  let emitted = 0;
  const spent = (): boolean => emitted >= budget;
  /**
   * Emits a leaf, clipped to what is left of the budget.
   *
   * Two clips, and which one is legal depends on `collapseWhitespace`.
   *
   * Without it, the RAW string is clipped first, so a megabyte leaf never
   * reaches `JSON.stringify` — measured 2.91 ms → 0.008 ms for a 990 KB leaf at
   * the probe ceiling. `+ 1` of headroom because escaping only ever lengthens
   * and the opening quote already supplies a character of slack; the prefix
   * invariant was fuzzed over 2.5 M cases (quotes, backslashes, control
   * characters, astral pairs, lone surrogates) with zero mismatches.
   *
   * WITH it the raw clip is illegal and the whole leaf must be normalised
   * first, because `collapseWhitespace` SHRINKS: collapsing `"a\n\n\nb"`
   * yields `"a b"` while collapsing its prefix `"a\n"` yields `"a "`, so a
   * prefix of the input can produce fewer than `room` output characters and the
   * invariant genuinely fails. That costs nothing in practice — the only
   * budgeted caller (`matches`) never asks for collapsing, and the only
   * collapsing caller (`digestOf`) is deliberately unbudgeted.
   */
  const emitLeaf = (raw: string): string => {
    const room = budget - emitted;
    const src = !opts.collapseWhitespace && raw.length > room + 1 ? raw.slice(0, room + 1) : raw;
    const full = JSON.stringify(opts.collapseWhitespace ? collapseWhitespace(src) : src);
    const out = full.slice(0, room);
    emitted += out.length;
    return out;
  };
  /**
   * Charges an already-final token to the budget and returns it unclipped.
   *
   * EVERY token the walk emits has to be charged, not just the string leaves —
   * a budget that counts only strings does not bound a document that has none.
   * Measured before this: 40,000 rows of `{id, ts, ok}` (1.55 MB, numeric and
   * boolean leaves only) never once tripped `spent()`, so neither loop ever
   * broke and `{maxChars: 4000}` produced the full 1,548,900 characters in 51 ms
   * — byte-identical to the unbounded walk, and slower for the bookkeeping.
   * That is precisely the shape `MATCH_INPUT_MAX` exists for.
   *
   * Unclipped because these are bounded by construction — a number is at most
   * ~300 characters and the literals are fixed — so there is nothing to cut and
   * the prefix stays exact. Charging MORE can only make the budget tighter,
   * which the invariant already tolerates: it is a documented under-estimate,
   * and the real output is allowed to run past it.
   */
  const charge = (token: string): string => {
    emitted += token.length;
    return token;
  };
  const seen = new WeakSet<object>();
  const walk = (v: unknown): string => {
    // Only reachable for `maxChars: 0` and from the root: every recursive call
    // is guarded by the `break`s below, and those are what actually bound the
    // walk. Do NOT delete them on the strength of this line.
    if (spent()) return '';
    if (v === null) return charge('null');
    if (v === undefined) return charge('undefined');
    const t = typeof v;
    if (t === 'number' || t === 'boolean') return charge(String(v));
    if (t === 'string') return emitLeaf(v as string);
    if (t !== 'object') return emitLeaf(String(v));
    const obj = v as object;
    if (seen.has(obj)) return charge('"[circular]"');
    seen.add(obj);
    try {
      if (Array.isArray(obj)) {
        const parts: string[] = [];
        for (const item of obj) {
          if (spent()) break;
          parts.push(walk(item));
        }
        return `[${parts.join(',')}]`;
      }
      const keys = Object.keys(obj as Record<string, unknown>).sort();
      const parts: string[] = [];
      for (const k of keys) {
        if (spent()) break;
        // The KEY is charged too. `{a:1,b:2,…}` with forty thousand keys and no
        // string values is the same unbounded shape as the numeric one above,
        // reached through the other half of the pair.
        parts.push(`${charge(JSON.stringify(k))}:${walk((obj as Record<string, unknown>)[k])}`);
      }
      return `{${parts.join(',')}}`;
    } finally {
      seen.delete(obj);
    }
  };
  return walk(value);
}

/**
 * Every run of whitespace becomes one space, and the ends are trimmed.
 *
 * Named for the OPERATION rather than for either caller, because the watcher
 * package has two and their reasons differ. `digestOf` needs it so that a page
 * which rewraps or re-indents without changing meaning does not read as changed
 * — the point the HTTP caching literature makes about weak validators, that
 * insignificant whitespace should not cause validator churn. `wake.ts`'s
 * `summariseObservation` needs it so a newline cannot smuggle an extra row into
 * a bordered panel.
 *
 * One rule rather than two copies: they describe the SAME bytes — the digest
 * decides whether a `changed` predicate fires, the excerpt decides what the
 * panel then says about it — so a change to one that missed the other would make
 * the panel describe a string the digest never saw.
 */
export function collapseWhitespace(text: string): string {
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
 * The one wording for "this `idPath` names no list", used at creation and at
 * poll time both.
 *
 * Written twice before this, byte-identical, in `probe.ts` and `poller.ts` — and
 * only the creation-time copy named working alternatives, so the failure that
 * actually strands a live watcher was the one told nothing. Sharing it makes the
 * suggestions unconditional rather than a property of which call site noticed.
 */
export function idPathRefusal(idPath: string, sample: unknown): string {
  const suggestions = suggestIdPaths(sample);
  return (
    `idPath "${idPath}" does not name a list of items in the result.` +
    (suggestions.length
      ? ` Try one of: ${suggestions.join(', ')}.`
      : ' The result contains no array of objects with an id field.')
  );
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
