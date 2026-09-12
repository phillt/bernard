import { describe, it, expect, beforeEach } from 'vitest';

import {
  duplicateWriteRefusal,
  recordWriteSuccess,
  __resetDuplicateGuard,
  DUPLICATE_WINDOW_MS,
} from './duplicate-guard.js';

/**
 * The Dom incident: `send_message` at `21:18:02.647` returned
 * `"**Open the chat in Beeper**: /open/29"` — no id, no success field — and the
 * model re-sent byte-identical at `21:18:06.357` with no read anywhere between.
 * The write barrier cannot help, because the second call was never checking the
 * first.
 *
 * Time is injected rather than faked globally: what is under test is a window,
 * and a suite that moves a global clock makes every unrelated assertion in the
 * file depend on it.
 */
const T0 = 1_000_000;
const ARGS = '{"chatID":"29","text":"Nice try, Dom."}';

beforeEach(__resetDuplicateGuard);

describe('duplicateWriteRefusal', () => {
  it('lets a first call through', () => {
    expect(duplicateWriteRefusal('send_message', ARGS, T0)).toBeNull();
  });

  it('refuses an identical write that already succeeded', () => {
    recordWriteSuccess('send_message', ARGS, T0);
    const refusal = duplicateWriteRefusal('send_message', ARGS, T0 + 3_700);
    expect(refusal).toMatch(/already SUCCEEDED/);
    // The elapsed time is the part that makes it checkable rather than a scold.
    expect(refusal).toMatch(/4s ago/);
  });

  it('says the earlier call SUCCEEDED, which is the load-bearing half', () => {
    // A model that re-issues is one that believes the first call failed. "An
    // identical call was made" confirms what it already thinks and it retries
    // anyway; the fact it was missing — and could not get from a result that
    // says nothing — is that the call worked.
    recordWriteSuccess('send_message', ARGS, T0);
    const refusal = duplicateWriteRefusal('send_message', ARGS, T0 + 1_000)!;
    expect(refusal).toMatch(/it did not/i);
    expect(refusal).toMatch(/make the identical call again/i);
  });

  it('runs the call that follows a refusal — re-issuing IS the confirmation', () => {
    recordWriteSuccess('send_message', ARGS, T0);
    expect(duplicateWriteRefusal('send_message', ARGS, T0 + 1_000)).not.toBeNull();
    expect(duplicateWriteRefusal('send_message', ARGS, T0 + 2_000)).toBeNull();
  });

  it('does not re-arm on the confirmed call', () => {
    // Otherwise the call AFTER the confirmed one is refused on the strength of
    // a success the model has already been told about and deliberately
    // repeated — an endless alternation rather than a gate.
    recordWriteSuccess('send_message', ARGS, T0);
    duplicateWriteRefusal('send_message', ARGS, T0 + 1_000);
    duplicateWriteRefusal('send_message', ARGS, T0 + 2_000);
    expect(duplicateWriteRefusal('send_message', ARGS, T0 + 3_000)).toBeNull();
  });

  it('ignores a success older than the window', () => {
    // 102 of 103 real repeated-write pairs fall inside it; the straggler is 93
    // minutes apart, which is a separate decision rather than a retry.
    recordWriteSuccess('send_message', ARGS, T0);
    expect(duplicateWriteRefusal('send_message', ARGS, T0 + DUPLICATE_WINDOW_MS + 1)).toBeNull();
  });

  it('never gates a write that FAILED', () => {
    // Nothing records a failure, so a retry after one is untouched. Gating it
    // would turn a transient failure into a permanent one — the opposite of
    // what a retry is for.
    expect(duplicateWriteRefusal('send_message', ARGS, T0)).toBeNull();
    expect(duplicateWriteRefusal('send_message', ARGS, T0 + 1_000)).toBeNull();
    expect(duplicateWriteRefusal('send_message', ARGS, T0 + 2_000)).toBeNull();
  });

  it('keys on the arguments, so a different message is not a duplicate', () => {
    recordWriteSuccess('send_message', ARGS, T0);
    expect(
      duplicateWriteRefusal('send_message', '{"chatID":"29","text":"different"}', T0 + 1_000),
    ).toBeNull();
  });

  it('keys on the tool, so two tools do not shadow each other', () => {
    recordWriteSuccess('send_message', ARGS, T0);
    expect(duplicateWriteRefusal('other_tool', ARGS, T0 + 1_000)).toBeNull();
  });

  it('reproduces the Dom sequence: send, blind re-send, refusal', () => {
    // 21:18:02.647 send → succeeded. 21:18:04.568 focus_app. 21:18:06.357 send
    // again, identical, with no read in between. The barrier sees no race here
    // because there is no read; this is the gate that catches it.
    recordWriteSuccess('send_message', ARGS, T0);
    expect(duplicateWriteRefusal('send_message', ARGS, T0 + 3_710)).toMatch(/already SUCCEEDED/);
  });
});
