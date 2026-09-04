import * as fs from 'node:fs';
import * as path from 'node:path';
import { debugLog } from '../logger.js';
import { registerSession, unregisterSession } from './registry.js';
import {
  isInboxMessage,
  isMessageFile,
  sanitizeNoticeText,
  sanitizeSourceLabel,
  INBOX_POLL_MS,
  MAX_RENDER_BURST,
  type InboxMessage,
} from './types.js';

/**
 * The receiving half of `bernard say` (#462): watch this session's inbox and
 * hand each message to a callback.
 *
 * No React imports, deliberately. `src/ui/message-store.ts` states the
 * layering rule this follows — the UI depends on the plumbing, never the
 * other way round — and it is what lets the whole transport be tested with no
 * Ink at all.
 *
 * ## Why a callback and not a store
 *
 * `MessageStore` uses `useSyncExternalStore` because streaming deltas must not
 * become React state — there are thousands per turn. A notice is one event,
 * and its destination is `staticItems`, which is already React-owned
 * append-only state. A snapshot store would add a second list and a commit
 * cursor for one delivery. So this borrows `MessageStore`'s *lifecycle*
 * (plain class, constructed at mount, torn down at unmount) and not its shape.
 *
 * It is also not a member of `InkHandlers`: that bridge is request/response
 * and tool→UI, with a global slot whose documented failure mode is silently
 * dropping a member one frame short of the overlay (#266). One-way delivery
 * needs no global slot, so the callback goes in the constructor and that whole
 * class of bug is unreachable.
 */

export interface InboxWatcherOptions {
  sessionId: string;
  /** Called once per delivered message, in arrival order. */
  onMessage: (message: InboxMessage) => void;
  /**
   * Called when a burst is coalesced, with how many were folded away.
   *
   * Required, not optional: a caller that omitted it would silently drop
   * everything past the burst cap with no signal that anything was lost, and
   * both call sites pass one anyway.
   */
  onCoalesced: (count: number, sourceLabel: string) => void;
  pollMs?: number;
}

export class InboxWatcher {
  private readonly opts: InboxWatcherOptions;
  private inboxDir: string | null = null;
  private watcher: fs.FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private draining = false;

  constructor(opts: InboxWatcherOptions) {
    this.opts = opts;
  }

  /**
   * Registers the session, drains anything already waiting, then watches.
   *
   * The immediate drain covers the window between the record appearing and
   * the watch being armed — which is precisely the window a fast
   * `bernard say` hits.
   */
  start(): void {
    const record = registerSession({ sessionId: this.opts.sessionId });
    this.inboxDir = record.inboxDir;
    this.drain();

    // Watch the DIRECTORY, never a file: `atomicWriteFileSync` finishes with a
    // rename, which replaces the inode, so a file watch stops firing after the
    // first write. Both daemons carry this same note.
    try {
      this.watcher = fs.watch(record.inboxDir, () => this.drain());
      // So a missed `stop()` can never be the reason the process will not
      // exit — the hazard class `src/host/client.ts` documents for `fork`'s
      // IPC channel and undici's keep-alive pool.
      this.watcher.unref();
    } catch (err) {
      debugLog('inbox:watch-failed', { message: err instanceof Error ? err.message : String(err) });
    }

    // The poll is the floor, not a fallback nobody expects to run: `fs.watch`
    // coalesces on macOS and does not fire at all on some network
    // filesystems. Both paths call the same idempotent drain, so a double
    // fire costs one `readdir`.
    this.timer = setInterval(() => this.drain(), this.opts.pollMs ?? INBOX_POLL_MS);
    this.timer.unref();
  }

  /** Stops watching and removes this session's registration and inbox. */
  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    unregisterSession(this.opts.sessionId);
  }

  /**
   * Reads, delivers and unlinks every waiting message.
   *
   * Idempotent, and never throws — it runs from a filesystem event, a timer
   * and `start()`, and a failure to render a notice must not become a louder
   * failure than the one being reported.
   *
   * A message is unlinked whether or not it could be read: a file that is
   * corrupt, oversized or unreadable would otherwise wedge the drain forever,
   * and the writer is untrusted by construction.
   */
  drain(): void {
    if (this.draining || !this.inboxDir) return;
    this.draining = true;
    try {
      const names = fs.readdirSync(this.inboxDir).filter(isMessageFile).sort();
      const messages: InboxMessage[] = [];
      for (const name of names) {
        const file = path.join(this.inboxDir, name);
        const message = readAndRemove(file);
        if (message) messages.push(message);
      }
      this.deliver(messages);
    } catch {
      // The directory may not exist yet, or may have been swept.
    } finally {
      this.draining = false;
    }
  }

  /**
   * Hands messages to the callback, bounding how many reach the screen.
   *
   * Rate limiting belongs on the receive side because the send side is
   * untrusted: a page in a retry loop can write as fast as it likes, and the
   * screen is the resource being protected.
   */
  private deliver(messages: InboxMessage[]): void {
    for (const message of messages.slice(0, MAX_RENDER_BURST)) this.opts.onMessage(message);
    const extra = messages.length - MAX_RENDER_BURST;
    if (extra > 0) {
      this.opts.onCoalesced(extra, messages[messages.length - 1].sourceLabel);
    }
  }
}

/**
 * Reads one message and removes it, whatever happens.
 *
 * Removal is also the delivery receipt the sender polls for, so it must happen
 * on the failure path too — otherwise a malformed message leaves `bernard say`
 * waiting for a pickup that can never come.
 */
function readAndRemove(file: string): InboxMessage | null {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    parsed = null;
  }
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Someone else may have taken it.
  }
  if (!isInboxMessage(parsed)) return null;
  // Re-sanitized on the way in as well as on the way out, because the writer
  // is not necessarily this code — anything that can write the directory can
  // write the file.
  const { text, truncated } = sanitizeNoticeText(parsed.text);
  if (text.length === 0) return null;
  return {
    ...parsed,
    text: truncated ? `${text}\n(truncated)` : text,
    sourceLabel: sanitizeSourceLabel(parsed.sourceLabel),
    ...(parsed.hint ? { hint: sanitizeNoticeText(parsed.hint).text } : {}),
  };
}
