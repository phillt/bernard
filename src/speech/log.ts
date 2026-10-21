import { debugLog } from '../logger.js';

/** How much of a transcript or a spoken reply a log row carries. */
export const SPEECH_TEXT_PREVIEW = 300;

/**
 * Records one speech event — mic, vendor request, playback, talk-mode state —
 * in the debug session log, under `speech:<event>`. One helper so every speech
 * path logs the same way and none is left silent: before it, a failed
 * utterance was a toast and an `http:*` status line with no reason attached.
 * Never pass a key; text is previewed, not whole.
 */
export function speechLog(event: string, data: Record<string, unknown> = {}): void {
  debugLog(`speech:${event}`, data);
}

/** A bounded, single-line preview of text for a log row. */
export function previewText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SPEECH_TEXT_PREVIEW ? `${flat.slice(0, SPEECH_TEXT_PREVIEW)}…` : flat;
}

/** The fields worth logging from a thrown value, the vendor's status included. */
export function errorFields(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { error: String(err) };
  const status = (err as { status?: unknown }).status;
  return {
    error: err.message,
    errorName: err.name,
    ...(typeof status === 'number' ? { status } : {}),
  };
}
