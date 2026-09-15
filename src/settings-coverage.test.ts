import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPTIONS_REGISTRY } from './config.js';
import { WIZARD_FIELDS } from './profiles-wizard-data.js';
import type { ProfileSettings } from './profiles.js';

/**
 * Every settable preference is either asked about or deliberately excluded.
 *
 * The wizard covered 22 of `ProfileSettings`' 40 fields (#447), and the other 18
 * were not a considered exclusion — nobody had ever added them. `provider`,
 * `model`, the active lineup, every voice setting and five behaviour toggles
 * were reachable from no wizard at all, and the drift is silent by
 * construction: a field added to `ProfileSettings` works everywhere else and is
 * merely absent from the registry, which nothing notices.
 *
 * So this walks the FIELDS DECLARED IN THE SOURCE to the registry, not the
 * registry to itself — the record-to-table direction, per
 * `builtin-specialists/bundled-manifest.test.ts`, and the direction the mistake
 * is actually made in. Iterating `WIZARD_FIELDS` and checking each is a
 * `ProfileSettings` key would pass forever while the gap grew.
 *
 * Reading the interface out of the source is the `ui/__tests__/keys.test.ts`
 * move: a type is erased at runtime, and the alternative — a hand-written list
 * of 40 names — is a second copy of the thing being checked.
 */

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'profiles.ts');

/** Field names declared directly on `interface ProfileSettings`. */
function declaredSettingKeys(): string[] {
  const source = fs.readFileSync(SRC, 'utf-8');
  const start = source.indexOf('export interface ProfileSettings {');
  expect(start).toBeGreaterThan(-1);
  const open = source.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = source.slice(open + 1, end);
  // Two-space indent only, so a field of a nested inline type cannot be read as
  // a setting.
  return [...body.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*)\??:/gm)].map((m) => m[1]);
}

/**
 * Settings the wizard deliberately does not ask about, each with the reason.
 *
 * Structured permission state, in all three cases. They are maps keyed by tool,
 * app id and directive — not a value a person answers in one screen — and each
 * already has a surface built for it. A wizard row that could only clear them
 * would be a way to lose a grant by walking past it.
 */
const NOT_IN_SETUP: Readonly<Record<string, string>> = {
  toolPermissions: 'per-tool grants — `/tool-permissions`',
  appToolGrants: 'per-applet tool grants — `bernard app-grant`',
  appCspGrants: 'per-applet CSP grants — `bernard app csp`',
};

/** Keys the registry decides, including those folded into another field's step. */
function coveredKeys(): Set<string> {
  const covered = new Set<string>();
  for (const field of WIZARD_FIELDS) {
    covered.add(field.key);
    for (const also of field.covers ?? []) covered.add(also);
  }
  return covered;
}

describe('settings coverage', () => {
  it('reads the interface it is checking', () => {
    // Guard the guard: a regex that matched nothing would make every assertion
    // below vacuously true.
    const keys = declaredSettingKeys();
    expect(keys.length).toBeGreaterThan(30);
    expect(keys).toContain('provider');
    expect(keys).toContain('specialistRecall');
  });

  it('asks about every setting that is not deliberately excluded', () => {
    const covered = coveredKeys();
    const unexplained = declaredSettingKeys().filter(
      (k) => !covered.has(k) && !Object.hasOwn(NOT_IN_SETUP, k),
    );
    expect(unexplained).toEqual([]);
  });

  it('has no stale exclusions', () => {
    // An exclusion for a field that no longer exists, or one the wizard now
    // asks about, is a reason nobody will re-read but everybody will trust.
    const declared = new Set(declaredSettingKeys());
    const covered = coveredKeys();
    for (const key of Object.keys(NOT_IN_SETUP)) {
      expect(declared.has(key)).toBe(true);
      expect(covered.has(key)).toBe(false);
    }
  });

  it('declares no field that is not a setting', () => {
    const declared = new Set(declaredSettingKeys());
    const strays = WIZARD_FIELDS.map((f) => f.key as string).filter((k) => !declared.has(k));
    expect(strays).toEqual([]);
  });

  it('never asks the same question twice', () => {
    const keys = WIZARD_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

/**
 * `OPTIONS_REGISTRY` and the wizard both describe the four numeric options, and
 * neither derives from the other — `/options` reads one, the wizard reads the
 * other, and a bound changed in one is invisible to the other.
 *
 * Reconciled rather than merged: unifying the three settings registries is
 * #441's job, and the established answer here for two tables that must agree is
 * a test (`timeout-offer.test.ts` already reconciles a third one against this
 * same registry).
 */
describe('numeric options agree with OPTIONS_REGISTRY', () => {
  const overlap = Object.values(OPTIONS_REGISTRY);

  it('covers all four', () => {
    const byKey = new Map(WIZARD_FIELDS.map((f) => [f.key as string, f]));
    for (const opt of overlap) expect(byKey.has(opt.configKey)).toBe(true);
  });

  it('names the same environment variable', () => {
    const byKey = new Map(WIZARD_FIELDS.map((f) => [f.key as string, f]));
    for (const opt of overlap) {
      expect(byKey.get(opt.configKey)?.envVar).toBe(opt.envVar);
    }
  });

  it('declares a range that admits the registry default', () => {
    // The failure this catches: a bound tightened in the wizard past the value
    // `/options` hands out, so accepting the default is refused as out of range.
    const byKey = new Map(WIZARD_FIELDS.map((f) => [f.key as string, f]));
    for (const opt of overlap) {
      const field = byKey.get(opt.configKey)?.field;
      expect(field?.kind).toBe('int');
      if (field?.kind !== 'int') continue;
      expect(opt.default).toBeGreaterThanOrEqual(field.min);
      expect(opt.default).toBeLessThanOrEqual(field.max);
    }
  });
});

/**
 * Every question explains the TRADE, not just the mechanism (#447).
 *
 * The question a reader brings to a settings page is "which of these is right
 * for me", and naming the mechanism does not answer it — `Integer 1-20.` was a
 * real description here, and `Which colors the terminal uses.` was as much as
 * most of the others said. A reader could not tell from any of them whether to
 * touch the setting.
 *
 * So each one now says what it is for, what it buys, what it costs, and the
 * condition under which the cost is not worth paying. That is a judgement and
 * cannot be asserted directly; what CAN be asserted is the shape it takes, and
 * the shapes the old copy took when it was not doing the job.
 */
describe('every question says enough to decide on', () => {
  it('is more than a restatement of its own label', () => {
    // The floor is deliberately low. It is not a style rule — it is the guard
    // against a description that names the type and stops, which is what the
    // step-budget and concurrency questions used to do.
    for (const f of WIZARD_FIELDS) {
      expect(f.description.split(/\s+/).length, f.key).toBeGreaterThan(12);
      expect(f.description.toLowerCase(), f.key).not.toBe(`${f.label.toLowerCase()}.`);
    }
  });

  it('carries a second sentence, which is where the trade lives', () => {
    // One sentence can only say what a thing is. What it costs, and when not to
    // pay it, needs another — so a single-sentence description is the tell that
    // the question went back to describing its mechanism.
    for (const f of WIZARD_FIELDS) {
      const sentences = f.description.split(/[.!?](?:\s|$)/).filter((s) => s.trim() !== '');
      expect(sentences.length, `${f.key}: ${f.description}`).toBeGreaterThan(1);
    }
  });

  it('puts nothing in parentheses on a row label', () => {
    // A gloss beside the option is the thing the description is supposed to
    // have absorbed. Asserted across every list rather than per question,
    // because this was fixed three times — coordinator, tool and confirm mode —
    // before the rule was general.
    for (const f of WIZARD_FIELDS) {
      if (f.field.kind !== 'list') continue;
      for (const o of f.field.options) expect(o.label, `${f.key}/${o.value}`).not.toMatch(/[()]/);
    }
  });
});

/** Type-level: `covers` may only name real settings. */
const _coversAreSettings: Array<keyof ProfileSettings> = WIZARD_FIELDS.flatMap(
  (f) => f.covers ?? [],
);
void _coversAreSettings;
