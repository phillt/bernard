import { printInfo, printError } from './output.js';
import { listLiveSessions, reapDeadSessions } from './inbox/registry.js';
import { sendToSessions, waitForConsumption } from './inbox/send.js';
import { DEFAULT_DELIVERY_TIMEOUT_MS, type InboxSourceKind } from './inbox/types.js';

/**
 * `bernard say` — put a message in front of a running REPL (#462).
 *
 * Deliberately imports nothing from `src/ui/`: this has to start and exit in
 * tens of milliseconds, and pulling React and Ink into that path would make a
 * one-line notification cost a cold start.
 *
 * It delivers a NOTICE. It does not start a turn, nothing is billed, and the
 * text never reaches the model — which is what makes it safe for anything on
 * the machine to call.
 */

export interface SayOptions {
  session?: string;
  all?: boolean;
  source?: string;
  sourceKind?: InboxSourceKind;
  hint?: string;
  ifRunning?: boolean;
  wait?: boolean;
  timeout?: number;
  list?: boolean;
}

/** Exit codes, so a caller can tell "nowhere to send" from "it broke". */
export const SAY_EXIT = {
  ok: 0,
  usage: 1,
  ambiguous: 2,
  noSession: 3,
  notPickedUp: 4,
} as const;

export async function sayCommand(text: string, opts: SayOptions = {}): Promise<number> {
  reapDeadSessions();

  if (opts.list) {
    const live = listLiveSessions();
    if (live.length === 0) {
      printInfo('No Bernard session is running.');
      return SAY_EXIT.ok;
    }
    for (const s of live) printInfo(describeSession(s));
    return SAY_EXIT.ok;
  }

  if (text.trim().length === 0) {
    printError('Nothing to say — pass some text.');
    return SAY_EXIT.usage;
  }

  const result = sendToSessions({
    text,
    source: { kind: opts.sourceKind ?? 'cli', label: opts.source ?? 'cli' },
    ...(opts.hint ? { hint: opts.hint } : {}),
    ...(opts.session
      ? { target: { sessionId: opts.session } }
      : opts.all
        ? { target: { all: true } }
        : {}),
  });

  if (result.reason === 'none-running') {
    // `--if-running` exists so a failure hook does not itself register as a
    // failure when nobody happens to be at a terminal.
    if (opts.ifRunning) return SAY_EXIT.ok;
    printError('No Bernard session is running.');
    printInfo('Start one with `bernard`, then run this again.');
    return SAY_EXIT.noSession;
  }
  if (result.reason === 'ambiguous') {
    printError('Several Bernard sessions are running — name one with --session, or use --all:');
    for (const s of result.candidates ?? []) printInfo(`  ${describeSession(s)}`);
    return SAY_EXIT.ambiguous;
  }
  if (result.reason === 'unknown-session') {
    printError(`No live session matches "${opts.session ?? ''}".`);
    return SAY_EXIT.usage;
  }
  if (result.reason === 'too-large' || result.reason === 'empty') {
    printError(
      result.reason === 'empty' ? 'Nothing to say once stripped.' : 'That message is too long.',
    );
    return SAY_EXIT.usage;
  }
  if (result.reason === 'inbox-full') {
    printError('That session has too many undelivered messages already.');
    return SAY_EXIT.usage;
  }
  if (result.delivered.length === 0) {
    // Deduped: an identical message from the same source moments ago.
    return SAY_EXIT.ok;
  }

  if (opts.wait === false) {
    printInfo(`Written to ${result.delivered.map((d) => d.sessionId).join(', ')}.`);
    return SAY_EXIT.ok;
  }

  // Deletion IS the acknowledgement — the REPL unlinks what it renders, so
  // there is no ack file and no protocol to keep in step.
  const timeout = opts.timeout ?? DEFAULT_DELIVERY_TIMEOUT_MS;
  const picked = await Promise.all(
    result.delivered.map(async (d) => ({ ...d, ok: await waitForConsumption(d.file, timeout) })),
  );
  const missed = picked.filter((p) => !p.ok);
  for (const p of picked.filter((x) => x.ok)) printInfo(`Delivered to ${p.sessionId}.`);
  if (missed.length === 0) return SAY_EXIT.ok;

  for (const p of missed) {
    printError(`Written to ${p.sessionId}'s inbox, but it was not picked up within ${timeout}ms.`);
  }
  printInfo('The session may be busy or unresponsive; the message appears if it recovers.');
  return SAY_EXIT.notPickedUp;
}

function describeSession(s: { sessionId: string; pid: number; startedAt: number; cwd: string }) {
  const started = new Date(s.startedAt).toLocaleTimeString();
  return `${s.sessionId}   pid ${s.pid}   started ${started}   ${s.cwd}`;
}
