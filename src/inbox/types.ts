/**
 * The wire format for a message delivered into a running REPL (#462), and the
 * sanitizing that makes it safe to render.
 *
 * A pure leaf — no `node:fs`, no React — so the sanitizer, which is the
 * security-critical part, is testable without touching a filesystem or a
 * terminal.
 *
 * ## A notice, never a turn
 *
 * `bernard say` puts a message on the user's screen. It does **not** start an
 * agent turn, is never billed, and never enters `agent.history`. That is the
 * whole trust story: the text has no path to the model, so the
 * instruction-source boundary is a property of the plumbing rather than a
 * policy every future refactor has to re-honour. `kind` exists so a later mode
 * (a message that *does* prompt) fails loudly against an older REPL instead of
 * being silently delivered as something it is not.
 */

/** What a message asks the receiving REPL to do. Only one thing, so far. */
export type InboxKind = 'notice';

/** Where a message claims to come from. A CLAIM — see {@link sanitizeSourceLabel}. */
export type InboxSourceKind = 'cli' | 'applet';

/** One message, as it sits on disk. */
export interface InboxMessage {
  schemaVersion: 1;
  kind: InboxKind;
  sourceKind: InboxSourceKind;
  /** Free-text attribution, e.g. `applet:news-headlines`. Unauthenticated. */
  sourceLabel: string;
  text: string;
  /** One line suggesting what to do about it, e.g. a command to run. */
  hint?: string;
  sentAt: number;
}

/** One live REPL. */
export interface SessionRecord {
  schemaVersion: 1;
  sessionId: string;
  pid: number;
  startedAt: number;
  cwd: string;
  /** Absolute, so a sender never re-derives the layout. */
  inboxDir: string;
  /**
   * What this REPL can be asked to do.
   *
   * Checked before delivery, not merely recorded: a sender refuses a session
   * whose capabilities do not include the message's `kind`. That is the whole
   * point — a later mode (a message that DOES start a turn) must fail against
   * an older REPL rather than arrive there and be rendered as a notice.
   */
  capabilities: readonly InboxKind[];
}

/** Bytes of message text accepted. Enforced on BOTH sides. */
export const MAX_NOTICE_BYTES = 4096;
/** Lines kept after sanitizing; a wall of text is a denial of the screen. */
export const MAX_NOTICE_LINES = 40;
/** Characters of the attribution label. */
export const MAX_SOURCE_LABEL = 64;
/** Undelivered messages one inbox may hold before writes are refused. */
export const MAX_PENDING = 32;
/** Messages rendered per drain; the rest are coalesced into one summary. */
export const MAX_RENDER_BURST = 5;
/** How often the watcher sweeps, as the floor under `fs.watch`. */
export const INBOX_POLL_MS = 1000;
/**
 * How long `bernard say` waits for its file to be consumed.
 *
 * Must exceed {@link INBOX_POLL_MS}, or a healthy session that happens to be
 * between sweeps is reported as unresponsive. Tuning one without the other is
 * the mistake this comment exists to prevent.
 */
export const DEFAULT_DELIVERY_TIMEOUT_MS = 3000;
/** Identical text from the same source inside this window is sent once. */
export const DEDUPE_WINDOW_MS = 30_000;

/**
 * Only files named exactly `*.json` are messages.
 *
 * Load-bearing, not tidiness: `atomicWriteFileSync` writes `<name>.tmp`
 * **in the directory being watched** and then renames it. A drain that
 * accepted anything not starting with `.` would read half-written files. Do
 * not "simplify" this predicate.
 */
export function isMessageFile(name: string): boolean {
  return name.endsWith('.json');
}

/**
 * Everything in C0, DEL and C1 except the newline.
 *
 * Removing ESC removes every escape sequence, since none can be expressed
 * without it. Written as explicit ranges rather than a `\s` class so it is
 * obvious what survives: `\n` and nothing else below space.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x09\x0B-\x1F\x7F-\x9F]/g;

/**
 * Strips what must never reach a terminal, and bounds what is left.
 *
 * **This is the security-critical function in #462.** Ink writes `<Text>`
 * content essentially verbatim, and the REPL may be in the alternate screen
 * buffer with `withFullScreen` owning the terminal state — so untrusted text
 * carrying CSI or OSC sequences could move the cursor, clear the screen, or
 * set the window title. Nothing in the repo strips control characters today:
 * `normalizeToolText` repairs Unicode, which is a different job.
 *
 * Newlines survive because a message is prose.
 */
export function sanitizeNoticeText(raw: string): { text: string; truncated: boolean } {
  const stripped = raw.replace(CONTROL_CHARS, '');
  const lines = stripped.split('\n');
  const tooManyLines = lines.length > MAX_NOTICE_LINES;
  const kept = lines.slice(0, MAX_NOTICE_LINES).join('\n').trim();
  const buf = Buffer.from(kept, 'utf-8');
  const overLong = buf.byteLength > MAX_NOTICE_BYTES;
  const text = overLong ? buf.subarray(0, MAX_NOTICE_BYTES).toString('utf-8') : kept;
  return { text, truncated: tooManyLines || overLong };
}

/**
 * The attribution label, reduced to one harmless line.
 *
 * Any local writer can set this, so it is a claim and never a credential — the
 * renderer must not style it as verified.
 */
export function sanitizeSourceLabel(raw: string): string {
  const { text } = sanitizeNoticeText(raw);
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_SOURCE_LABEL) || 'unknown';
}

/** Whether a parsed value is a message this binary understands. */
export function isInboxMessage(value: unknown): value is InboxMessage {
  if (!value || typeof value !== 'object') return false;
  const m = value as Partial<InboxMessage>;
  return (
    m.schemaVersion === 1 &&
    m.kind === 'notice' &&
    typeof m.sourceLabel === 'string' &&
    typeof m.text === 'string' &&
    typeof m.sentAt === 'number' &&
    (m.hint === undefined || typeof m.hint === 'string') &&
    (m.sourceKind === 'cli' || m.sourceKind === 'applet')
  );
}

/** Whether a session can be asked to handle this kind of message. */
export function sessionAccepts(record: SessionRecord, kind: InboxKind): boolean {
  return record.capabilities.includes(kind);
}

/** Whether a parsed value is a session record this binary understands. */
export function isSessionRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<SessionRecord>;
  return (
    r.schemaVersion === 1 &&
    typeof r.sessionId === 'string' &&
    typeof r.pid === 'number' &&
    typeof r.startedAt === 'number' &&
    typeof r.inboxDir === 'string' &&
    Array.isArray(r.capabilities)
  );
}
