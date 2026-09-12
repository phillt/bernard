/**
 * @module watchers/types
 *
 * What a watcher IS. A pure leaf with no imports at all, so the store, the
 * probe, the poller and the UI can each depend on the shape without any of them
 * acquiring the others' graph.
 *
 * A watcher is a one-shot event monitor bound to a session: it polls a target,
 * compares the result against a snapshot taken when it was created, and when the
 * comparison says something happened it wakes the session that made it and ends.
 *
 * ## Level-triggered, which is the design and not an implementation detail
 *
 * A watcher reads CURRENT state and compares it against a stored snapshot. It
 * never consumes an event stream. That is the Kubernetes controller pattern, and
 * it buys the property that makes an unreliable poll clock acceptable: a watcher
 * that misses eleven consecutive polls still fires correctly on the twelfth,
 * because the snapshot — not the gap — is what it compares against. It is also
 * why this subsystem does not touch the cron scheduler and is unaffected by
 * cron's silent dropping of fires during OS sleep (#400).
 *
 * The honest limit: this cannot see a genuinely TRANSIENT event — something that
 * appears and is gone again between two polls. The answer there is a durable log
 * at the source (Gmail's `historyId` is one) reached through a `mcp` target,
 * never a faster poll.
 */

/**
 * Where a watcher looks.
 *
 * A closed union, deliberately, and the same argument `apps/manifest.ts` makes
 * for its arg types: an open target language is an open injection surface, and
 * a watcher is frequently authored by a model.
 */
export type WatchTarget =
  /**
   * Call a read-only tool and look at what comes back. The general case, and
   * the one that covers mail, messages and anything else an MCP server exposes.
   *
   * `tool` is a registry key (namespaced, `server_hash__tool` since #413).
   * Restricted to read-classified tools at creation — see `probe.ts`.
   */
  | { kind: 'mcp'; tool: string; args: Record<string, string | number | boolean>; extract?: string }
  /** Fetch a URL. Conditional request first, body digest second. */
  | { kind: 'http'; url: string }
  /** Watch one path's mtime and size. */
  | { kind: 'file'; path: string }
  /**
   * Fire at a wall-clock instant. This is the whole of #201: a sleep is a
   * watcher whose target is a clock, which is how every durable-execution
   * runtime models it (Inngest's `sleepUntil` beside `waitForEvent`, Temporal's
   * timers beside signals).
   */
  | { kind: 'time'; at: string };

/** What counts as "something happened". Closed, for `WatchTarget`'s reason. */
export type WatchPredicate =
  /** The extracted value's digest differs from the snapshot. */
  | { kind: 'changed' }
  /**
   * An id is present that was not in the baseline set.
   *
   * The one that expresses *"tell me when John replies"* correctly. `changed`
   * would also fire when an item is REMOVED, and `exists` would fire instantly
   * against a mailbox that already has a matching message.
   *
   * `where` narrows WHICH items count, and it is what makes watching a
   * conversation you also speak in possible at all. Beeper's `list_messages`
   * returns your own sent messages (`isSender: true`), so without it a watcher
   * on a chat fires on Bernard's own reply, which prompts another reply — an
   * observed loop, six re-arms deep. `where: {path:'isSender', equals:false}`
   * says "only things I did not send".
   *
   * Applied identically when the baseline is captured and when it is compared,
   * or the two sets would not correspond and every filtered item would read as
   * new forever.
   */
  | {
      kind: 'appeared';
      idPath: string;
      where?: { path: string; equals: string | number | boolean };
    }
  /** The extracted text matches. */
  | { kind: 'matches'; pattern: string };

export type WatchStatus = 'active' | 'fired' | 'cancelled' | 'expired' | 'failed';

/** The persisted record. */
export interface Watcher {
  schemaVersion: 1;
  id: string;
  /** Short human label, for `/watchers` and the wake panel. */
  name: string;
  createdAt: string;
  /** The session that created it and is responsible for polling it. */
  ownerSessionId: string;
  /** The owning session's pid, so an orphan can be recognised and adopted. */
  ownerPid: number;
  status: WatchStatus;
  target: WatchTarget;
  predicate: WatchPredicate;
  /**
   * What to do when it fires. Authored by the session at creation time and
   * carried verbatim into the woken turn's INSTRUCTION channel.
   *
   * This field is the whole trust story. Everything the watcher OBSERVES is
   * untrusted and travels in the data channel; nothing observed ever reaches
   * here. See `wake.ts`.
   */
  instructions: string;
  /**
   * Whether this watcher re-arms itself instead of ending on the first fire.
   *
   * A conversation needs this. One-shot means the agent must create a fresh
   * watcher after every wake, which costs a turn each time and — the part that
   * actually loses messages — leaves a GAP: anything arriving between the fire
   * and the re-create is already present when the new baseline is captured, so
   * it is never reported. Observed in use; replies landed in that window.
   *
   * A repeating watcher advances its baseline to the ids seen in the same poll
   * that fired, so the window does not exist.
   */
  repeating?: boolean;
  /** How many times it has fired. Only meaningful when {@link repeating}. */
  fireCount?: number;
  /**
   * Ceiling on fires before a repeating watcher stops on its own.
   *
   * A repeating watcher is the one shape here that can run away — each fire
   * starts a turn, and a chat that is actively moving can fire every interval.
   * `expiresAt` bounds it in time; this bounds it in work.
   */
  maxFires?: number;
  /** Digest of the extracted value when the watcher was created, or after a poll. */
  snapshot?: string;
  /** Baseline id set for an `appeared` predicate. */
  baselineIds?: string[];
  /** HTTP validators, so a poll can ask "has this changed?" for free. */
  etag?: string;
  lastModified?: string;
  intervalMs: number;
  lastCheckedAt?: string;
  /** Consecutive probe failures. A watcher that cannot see is not a watcher. */
  failureCount: number;
  lastError?: string;
  firedAt?: string;
  /** Absolute deadline. A watcher nobody cancels must still stop. */
  expiresAt: string;
}

/** How many watchers one session may hold. */
export const MAX_WATCHERS = 10;

/**
 * Floor on the poll interval.
 *
 * Not a politeness limit — a probe is a real call to somebody's server, and a
 * watcher is frequently authored by a model that has no idea what a reasonable
 * cadence is. 15 s is already far faster than any of the scenarios this exists
 * for need.
 */
export const MIN_INTERVAL_MS = 15_000;
export const DEFAULT_INTERVAL_MS = 60_000;

/** Ceiling on a watcher's life, and the default when none is given. */
export const MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Consecutive probe failures before a watcher gives up.
 *
 * It stops rather than retrying forever because a watcher that has been failing
 * for a day is not watching anything, and the user believes it is — the same
 * silent-failure shape the whole feature exists to remove.
 */
export const MAX_PROBE_FAILURES = 5;

/**
 * Default ceiling on fires for a repeating watcher.
 *
 * Sized so a busy conversation runs for hours without the user re-arming, while
 * a runaway stops the same day rather than at `expiresAt` a week later.
 */
export const DEFAULT_MAX_FIRES = 50;

/**
 * Cap on the observation handed to a woken turn, in CHARACTERS.
 *
 * Named for what it measures: it was `_BYTES` and compared against
 * `String.length`, while a second site multiplied it by four to get an HTTP
 * body ceiling — one constant meaning two different things at two sites.
 */
export const MAX_OBSERVATION_CHARS = 4_000;

/**
 * Ceiling on an HTTP response body a probe will hold.
 *
 * Larger than {@link MAX_OBSERVATION_CHARS} because the whole body is digested
 * for a `changed` comparison, and only the excerpt handed to the woken turn is
 * capped at the smaller number. Its own constant so the relationship is a stated
 * ratio rather than a `* 4` nobody can explain.
 */
export const MAX_HTTP_BODY_CHARS = 16_000;

/** Watcher ids are minted by us; a hand-edited file is refused, never repaired. */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidWatcherId(id: string): boolean {
  return ID_RE.test(id);
}

/**
 * Is this a watcher record?
 *
 * Validated on READ as well as write: the file is the user's own and hand
 * editable between runs, so a write-time check alone is a time-of-check /
 * time-of-use gap — #420 R6's rule, which `AppManifestSchema` follows for the
 * same reason.
 */
export function isWatcher(v: unknown): v is Watcher {
  if (typeof v !== 'object' || v === null) return false;
  const w = v as Record<string, unknown>;
  return (
    w.schemaVersion === 1 &&
    typeof w.id === 'string' &&
    isValidWatcherId(w.id) &&
    typeof w.name === 'string' &&
    typeof w.createdAt === 'string' &&
    typeof w.ownerSessionId === 'string' &&
    typeof w.ownerPid === 'number' &&
    typeof w.status === 'string' &&
    ['active', 'fired', 'cancelled', 'expired', 'failed'].includes(w.status) &&
    isWatchTarget(w.target) &&
    isWatchPredicate(w.predicate) &&
    typeof w.instructions === 'string' &&
    typeof w.intervalMs === 'number' &&
    typeof w.failureCount === 'number' &&
    typeof w.expiresAt === 'string'
  );
}

function isWatchTarget(v: unknown): v is WatchTarget {
  if (typeof v !== 'object' || v === null) return false;
  const t = v as Record<string, unknown>;
  switch (t.kind) {
    case 'mcp':
      return (
        typeof t.tool === 'string' &&
        typeof t.args === 'object' &&
        t.args !== null &&
        (t.extract === undefined || typeof t.extract === 'string')
      );
    case 'http':
      return typeof t.url === 'string';
    case 'file':
      return typeof t.path === 'string';
    case 'time':
      return typeof t.at === 'string';
    default:
      return false;
  }
}

function isWatchPredicate(v: unknown): v is WatchPredicate {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  switch (p.kind) {
    case 'changed':
      return true;
    case 'appeared':
      return (
        typeof p.idPath === 'string' &&
        (p.where === undefined ||
          (typeof p.where === 'object' &&
            p.where !== null &&
            typeof (p.where as { path?: unknown }).path === 'string'))
      );
    case 'matches':
      return typeof p.pattern === 'string';
    default:
      return false;
  }
}

/** Is this watcher still worth polling? */
export function isPollable(w: Watcher, now: number): boolean {
  if (w.status !== 'active') return false;
  return Date.parse(w.expiresAt) > now;
}

/** Is this watcher due for a poll? */
export function isDue(w: Watcher, now: number): boolean {
  // A `time` target is due exactly once, at its instant — polling it early is
  // pure waste and polling it on the generic interval would fire it late by up
  // to one interval.
  if (w.target.kind === 'time') return Date.parse(w.target.at) <= now;
  if (!w.lastCheckedAt) return true;
  return now - Date.parse(w.lastCheckedAt) >= w.intervalMs;
}

/**
 * One line naming what a watcher looks at.
 *
 * Here rather than in the tool or the UI because both need it and a second copy
 * drifts — the `/watchers` menu and the tool's own output would end up
 * describing the same record differently.
 */
export function describeWatchTarget(t: WatchTarget): string {
  switch (t.kind) {
    case 'mcp':
      return `tool ${t.tool}`;
    case 'http':
      return t.url;
    case 'file':
      return t.path;
    case 'time':
      return `at ${t.at}`;
  }
}
