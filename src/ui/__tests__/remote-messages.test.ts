import { describe, it, expect } from 'vitest';
import {
  ACT_HINT,
  ACT_KEY,
  OPTIONS_KEY,
  REMOTE_MESSAGE_MODES,
  capabilitiesFor,
  runsUnattended,
  type RemoteMessageMode,
} from '../remote-messages.js';

/**
 * The mode → behaviour decision, away from Ink (#462/#493).
 *
 * Both predicates here decide whether a local process may put instructions in
 * front of the agent with nobody watching, so the case that matters is the one
 * that is not in the type: an absent mode.
 */
describe('remote-messages', () => {
  const ABSENT = undefined as unknown as RemoteMessageMode;
  const GARBAGE = 'yes' as unknown as RemoteMessageMode;

  describe('an unknown mode fails CLOSED', () => {
    // Written as `mode !== 'ask'` both predicates are TRUE for `undefined`, and
    // a caller can hand one `undefined` with no type error: every
    // `BernardConfig` in the suite is an object literal, and a field nobody
    // listed is simply absent. That is how the first cut of this shipped — a
    // session that had opted in to nothing advertised `prompt` and would run an
    // arbitrary turn for any local writer.
    for (const [name, mode] of [
      ['absent', ABSENT],
      ['garbage', GARBAGE],
    ] as const) {
      it(`advertises no prompt capability for a ${name} mode`, () => {
        expect(capabilitiesFor(mode)).toEqual({});
      });

      it(`runs nothing unattended for a ${name} mode`, () => {
        expect(runsUnattended(mode, 'prompt')).toBe(false);
        expect(runsUnattended(mode, 'notice')).toBe(false);
      });
    }
  });

  it('advertises nothing under ask, and both kinds under the automatic modes', () => {
    // Spread into an optional field, so `ask` contributes no key at all rather
    // than re-stating `DEFAULT_CAPABILITIES`.
    expect(capabilitiesFor('ask')).toEqual({});
    expect(capabilitiesFor('prompts')).toEqual({ capabilities: ['notice', 'prompt'] });
    expect(capabilitiesFor('all')).toEqual({ capabilities: ['notice', 'prompt'] });
  });

  it('runs exactly what each mode says, and nothing more', () => {
    // The whole table in one place, because the interesting cell is
    // `prompts` × `notice` — opting in to `--run` must not turn every delivered
    // message into a turn.
    expect(runsUnattended('ask', 'notice')).toBe(false);
    expect(runsUnattended('ask', 'prompt')).toBe(false);
    expect(runsUnattended('prompts', 'notice')).toBe(false);
    expect(runsUnattended('prompts', 'prompt')).toBe(true);
    expect(runsUnattended('all', 'notice')).toBe(true);
    expect(runsUnattended('all', 'prompt')).toBe(true);
  });

  it('offers every mode, least permissive first', () => {
    // Order is what a reader scans; `all` arriving first would put the widest
    // grant under the cursor on open.
    expect(REMOTE_MESSAGE_MODES.map((m) => m.value)).toEqual(['ask', 'prompts', 'all']);
  });

  it('builds the prose hint from the keys, so the two cannot disagree', () => {
    // Three surfaces interpolate ACT_HINT; a hand-written copy is how a panel
    // ends up naming a key nothing is bound to.
    expect(ACT_HINT).toContain(ACT_KEY);
    expect(ACT_HINT).toContain(OPTIONS_KEY);
  });
});
