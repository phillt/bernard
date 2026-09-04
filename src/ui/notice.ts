import type { InboxMessage, InboxSourceKind } from '../inbox/types.js';

/**
 * What a message from outside the session looks like once it is on screen
 * (#462).
 *
 * Mirrors `error-format.ts`: a plain data shape, so the panel that renders it
 * stays a pure function of its props and can be tested without a transport.
 */
export interface NoticeData {
  sourceKind: InboxSourceKind;
  /**
   * Who the message says it is from.
   *
   * **An unauthenticated claim.** Anything that can write the inbox directory
   * chooses this string, so the panel must never style it as verified — no
   * lock, no badge, no colour that reads as trusted. It is rendered at the
   * same weight as the timestamp for exactly that reason.
   */
  sourceLabel: string;
  text: string;
  hint?: string;
  receivedAt: number;
}

/** Projects a delivered message into what the transcript renders. */
export function toNoticeData(message: InboxMessage): NoticeData {
  return {
    sourceKind: message.sourceKind,
    sourceLabel: message.sourceLabel,
    text: message.text,
    ...(message.hint ? { hint: message.hint } : {}),
    receivedAt: Date.now(),
  };
}

/** The panel's summary of a coalesced burst, so a flood is one row not forty. */
export function coalescedNotice(count: number, sourceLabel: string): NoticeData {
  return {
    sourceKind: 'cli',
    sourceLabel,
    text: `+${count} more message${count === 1 ? '' : 's'} not shown.`,
    receivedAt: Date.now(),
  };
}
