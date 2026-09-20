import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEGACY_MODE,
  MODEL_MODES,
  isKnownMode,
  legacyModelModeNotice,
  normalizeStoredModelMode,
} from './model-modes.js';

/**
 * The model-mode vocabulary, written down once (#170/#225/#606).
 *
 * Sibling of `coordinator-modes.test.ts` / `tool-modes.test.ts`, and the same
 * argument one step further: those two hold the ROWS, this one also holds the
 * type, the predicate and the migration, because `profiles.ts` and `config.ts`
 * sit on opposite sides of a cycle from `model-policy.ts` and had each
 * re-spelled the three-member list by hand rather than import it.
 *
 * The reconciliation against the surfaces that ASK the question lives in
 * `settings-coverage.test.ts`, where the wizard registry already is.
 */
describe('the model-mode rows are written down once', () => {
  it('puts nothing in parentheses on a label', () => {
    for (const m of MODEL_MODES) expect(m.label, m.value).not.toMatch(/[()]/);
  });

  it('keeps every note inside the one row it is given', () => {
    // The bound `coordinator-modes.test.ts` pins on this same shape, and for
    // the same reason: the wizard reserves exactly one row for the note and
    // TRUNCATES, so a longer sentence is cut rather than wrapped. It was stated
    // in prose here and checked nowhere, and the drift had already started — the
    // longest row measured 53 against a docstring saying "under about fifty".
    // A stated rule nothing checks is how a four-row menu ended up in front of a
    // three-value union.
    for (const m of MODEL_MODES) expect(m.description.length, m.value).toBeLessThan(60);
  });

  it('names no mode in a row description', () => {
    // The description ADDS to the framing. A row that quotes one of the other
    // answers back is the enumeration the field description just shed.
    for (const m of MODEL_MODES) {
      for (const other of MODEL_MODES) {
        expect(m.description.toLowerCase(), `${m.value} names ${other.value}`).not.toContain(
          other.value,
        );
      }
    }
  });
});

describe('normalizeStoredModelMode', () => {
  it('migrates legacy "off" to "optimize-performance"', () => {
    expect(normalizeStoredModelMode(LEGACY_MODE)).toBe('optimize-performance');
  });

  it('passes through valid modes', () => {
    expect(normalizeStoredModelMode('balanced')).toBe('balanced');
    expect(normalizeStoredModelMode('optimize-tokens')).toBe('optimize-tokens');
    expect(normalizeStoredModelMode('optimize-performance')).toBe('optimize-performance');
  });

  it('returns undefined for unknown values', () => {
    expect(normalizeStoredModelMode('nonsense')).toBeUndefined();
    expect(normalizeStoredModelMode(null)).toBeUndefined();
    expect(normalizeStoredModelMode(undefined)).toBeUndefined();
  });

  it('agrees with the predicate it is built on', () => {
    // `isKnownMode` was private and re-spelled inline here; `config.ts` carried
    // a third copy with no caller, and `profiles.ts` two more. The collapse is
    // behaviour-preserving only while these two answer the same question, which
    // is what this pins.
    for (const m of MODEL_MODES) {
      expect(isKnownMode(m.value), m.value).toBe(true);
      expect(normalizeStoredModelMode(m.value), m.value).toBe(m.value);
    }
    expect(isKnownMode(LEGACY_MODE)).toBe(false);
  });
});

/**
 * The migration owes the user a sentence, on both surfaces that reach it (#606).
 *
 * The settings row was the visible half. The other two are a `profiles.json`
 * written by that row — anyone whose first run took it since #582 has `'off'` on
 * disk right now — and `BERNARD_MODEL_MODE=off` in a shell profile, which is not
 * an old preference being read once but a value RE-PICKED at every launch, from
 * a surface with no label in front of it at all. Both land on
 * `optimize-performance`, silently, which is the defect this PR exists to
 * remove reached by a different door.
 */
describe('legacyModelModeNotice', () => {
  it('says nothing when nothing legacy is in play', () => {
    expect(legacyModelModeNotice({})).toBeUndefined();
    expect(legacyModelModeNotice({ env: 'balanced', stored: 'optimize-tokens' })).toBeUndefined();
    expect(legacyModelModeNotice({ env: undefined, stored: undefined })).toBeUndefined();
  });

  it('names the variable, and unsetting it, when the env var is the source', () => {
    const n = legacyModelModeNotice({ env: LEGACY_MODE })!;
    expect(n).toContain('BERNARD_MODEL_MODE');
    expect(n).toMatch(/unset/i);
    // The remedy has to name what it became, or the reader has no reason to act.
    expect(n).toContain('optimize-performance');
  });

  it('points at the menu, not the variable, when the profile is the source', () => {
    const n = legacyModelModeNotice({ stored: LEGACY_MODE })!;
    expect(n).not.toContain('BERNARD_MODEL_MODE');
    expect(n).toContain('/agent-options');
  });

  it('covers both when both say it', () => {
    const n = legacyModelModeNotice({ env: LEGACY_MODE, stored: LEGACY_MODE })!;
    expect(n).toContain('BERNARD_MODEL_MODE');
    expect(n).toMatch(/profile/i);
  });

  it('reads an unparsed value, which is the only shape it ever sees', () => {
    // `stored` is typed `unknown` deliberately. `ProfileSettings.modelMode` is
    // `ModelMode`, so the TYPE says `'off'` is impossible there — while
    // `loadProfiles` casts its settings blob rather than validating it, so the
    // VALUE arrives unparsed. A reader who trusts the type deletes this check.
    expect(legacyModelModeNotice({ stored: LEGACY_MODE })).toBeDefined();
    expect(legacyModelModeNotice({ stored: 0 })).toBeUndefined();
    expect(legacyModelModeNotice({ stored: { modelMode: 'off' } })).toBeUndefined();
  });

  it('is actually pushed at startup, not merely computed', () => {
    // The wiring half, and the one that fails silently: a notice minted into a
    // local and never pushed is #461's shape — the message computed and thrown
    // away — with every unit test above still green. `runRepl` is a CLI entry
    // behind Commander with no reachable seam, so this is a source scan, which
    // is what is available; it is strictly stronger than nothing, which is what
    // the wiring had.
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.ts'),
      'utf-8',
    );
    expect(src).toContain('legacyModelModeNotice(');
    // Both sources reach it, and it reaches the notice list. Asserted as three
    // facts rather than one blob match, so a reformat cannot break it and a
    // half-wiring cannot pass it.
    expect(src).toMatch(/env:\s*process\.env\.BERNARD_MODEL_MODE/);
    expect(src).toMatch(/stored:\s*getActiveSettings\(/);
    expect(src).toMatch(/startupNotices\.push\(legacyNotice\)/);
  });

  it('never claims the migrated value is in force', () => {
    // `prefs.modelMode ?? envModelMode` means a stored answer beats an exported
    // one, so a session can carry a dead `BERNARD_MODEL_MODE=off` while running
    // `balanced`. "You are on optimize-performance" would be this PR's own
    // defect — a confident sentence about a setting that is not what it says.
    const n = legacyModelModeNotice({ env: LEGACY_MODE })!;
    expect(n).toMatch(/being read as/i);
    expect(n).not.toMatch(/you are (now )?(on|using|running)/i);
  });
});
