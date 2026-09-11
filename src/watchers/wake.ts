/**
 * @module watchers/wake
 *
 * Turning a fired watcher into the two halves of a turn.
 *
 * ## The boundary this exists to hold
 *
 * `bernard say` deliberately never starts a turn, and CLAUDE.md calls that
 * structural rather than policy: the text has no path into `agent.history`, so
 * no later refactor can accidentally open one. Two tests pin it. A watcher
 * *does* start a turn, so the guarantee has to be re-established on different
 * ground rather than simply spent.
 *
 * It is re-established by asking who wrote each byte:
 *
 * - **`instructions`** were authored by this session when the watcher was
 *   created — the user said *"when John replies, draft a response"*. That is an
 *   instruction and belongs in the instruction slot.
 * - **the observation** is whatever the world then put in front of the watcher:
 *   an email body, a page, a message. It is DATA, and travels in the data
 *   channel where a banner marks it and the model is told not to obey it.
 *
 * The split is a compile error rather than a convention: the data channel takes
 * `UntrustedData`, which a plain string cannot satisfy. So the natural mistake —
 * concatenating the observation into the instruction because it is "just
 * context" — does not type-check.
 *
 * This is deliberately NOT the inbox. A wake is in-process and its instruction
 * comes from the session's own record, so nothing any local writer can produce
 * reaches the instruction slot. `bernard say`'s transport and its two tests are
 * untouched by watchers; the separate opt-in that lets a *remote* sender start a
 * turn is #493's, and is a different trust case with a different gate.
 */
import { renderObservationBlock } from '../framework/agents/user-message.js';
import type { UntrustedData } from '../framework/agents/user-message.js';
import { stableStringify } from './extract.js';
import { MAX_OBSERVATION_BYTES, type Watcher } from './types.js';

/** A turn a watcher is asking for. */
export interface Wake {
  watcherId: string;
  /** For the attributed panel: which watcher, and why it fired. */
  name: string;
  reason: string;
  firedAt: string;
  /** The instruction channel — authored by the session, a plain string. */
  instruction: string;
  /** The data channel — what was seen. Absent for a `time` target. */
  data?: UntrustedData;
}

/**
 * Renders the observed value for a human and a model to read.
 *
 * Bounded, because the value is whatever a server chose to return and a woken
 * turn pays for every byte of it. Truncation is MARKED — an observation that
 * stops mid-sentence and says nothing about it invites the model to reason about
 * a message it only half saw.
 */
export function renderObservation(value: unknown): string {
  const text = typeof value === 'string' ? value : stableStringify(value);
  if (text.length <= MAX_OBSERVATION_BYTES) return text;
  return `${text.slice(0, MAX_OBSERVATION_BYTES)}\n… (truncated, ${text.length} chars total)`;
}

/**
 * Builds the wake for a watcher that just fired.
 *
 * `observed` is omitted for a `time` target, which has nothing to show — the
 * event IS the clock, and a fabricated empty block would suggest the watcher
 * looked at something.
 */
export function buildWake(
  watcher: Watcher,
  reason: string,
  observed: { value: unknown } | null,
  firedAt = new Date(),
): Wake {
  const source =
    watcher.target.kind === 'mcp'
      ? watcher.target.tool
      : watcher.target.kind === 'http'
        ? watcher.target.url
        : watcher.target.kind === 'file'
          ? watcher.target.path
          : 'a scheduled time';

  return {
    watcherId: watcher.id,
    name: watcher.name,
    reason,
    firedAt: firedAt.toISOString(),
    // Verbatim. Nothing observed is interpolated into this string — that is the
    // entire point of the module.
    instruction: watcher.instructions,
    ...(observed === null
      ? {}
      : { data: renderObservationBlock(source, renderObservation(observed.value)) }),
  };
}
