import { printInfo, printError } from './output.js';
import { reapAndListLiveSessions } from './inbox/registry.js';
import { sendToSessions, waitForConsumption } from './inbox/send.js';
import { DEFAULT_DELIVERY_TIMEOUT_MS } from './inbox/types.js';
import type { SendReason } from './inbox/send.js';

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

/**
 * Every refusal's exit status, as a table rather than an if-chain.
 *
 * A `Record` keyed on the union so adding a `SendReason` is a compile error
 * until its status is decided — the reasoning `EXIT_FOR` in `src/script/run.ts`
 * already states. The chain this replaced would have let a new reason fall
 * through to the success path and report a delivery that never happened.
 */
const REASON_EXIT: Record<SendReason, number> = {
  'none-running': SAY_EXIT.noSession,
  ambiguous: SAY_EXIT.ambiguous,
  'unknown-session': SAY_EXIT.usage,
  empty: SAY_EXIT.usage,
  'too-large': SAY_EXIT.usage,
  'inbox-full': SAY_EXIT.usage,
};

const REASON_MESSAGE: Record<SendReason, (opts: SayOptions) => string> = {
  'none-running': () => 'No Bernard session is running.',
  ambiguous: () => 'Several Bernard sessions are running — name one with --session, or use --all:',
  'unknown-session': (o) => `No live session matches "${o.session ?? ''}".`,
  empty: () => 'Nothing to say once stripped.',
  'too-large': () => 'That message is too long.',
  'inbox-full': () => 'That session has too many undelivered messages already.',
};

export async function sayCommand(text: string, opts: SayOptions = {}): Promise<number> {
  if (opts.list) {
    // `sendToSessions` reaps on the send path, so this is the only place the
    // CLI needs to ask.
    const live = reapAndListLiveSessions();
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
    source: { kind: 'cli', label: opts.source ?? 'cli' },
    ...(opts.hint ? { hint: opts.hint } : {}),
    ...(opts.session
      ? { target: { sessionId: opts.session } }
      : opts.all
        ? { target: { all: true } }
        : {}),
  });

  if (result.reason) {
    // `--if-running` exists so a failure hook does not itself register as a
    // failure when nobody happens to be at a terminal.
    if (result.reason === 'none-running' && opts.ifRunning) return SAY_EXIT.ok;
    printError(REASON_MESSAGE[result.reason](opts));
    if (result.reason === 'ambiguous') {
      for (const s of result.candidates ?? []) printInfo(`  ${describeSession(s)}`);
    }
    if (result.reason === 'none-running')
      printInfo('Start one with `bernard`, then run this again.');
    return REASON_EXIT[result.reason];
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
