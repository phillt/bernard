import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POST_V1_BUNDLED, V1_BUNDLED } from '../specialists.js';

/**
 * The two-edit rule, as an invariant rather than a per-record test.
 *
 * A new bundled specialist reaches existing installs ONLY if its filename is
 * in `POST_V1_BUNDLED`: `.seeded-v1` short-circuits `seedOnce` before the v1
 * loop, so dropping a JSON file into this directory alone reaches nobody who
 * has already run Bernard once. That rule is written down in three places and
 * enforced by none — until now.
 *
 * Deliberately NOT a parameterized walk of `POST_V1_BUNDLED`. Iterating the
 * constant to assert things about the constant makes the test self-consistent
 * with whatever it happens to say — the objection this codebase already raises
 * to importing a constant into the test that pins it. The direction that
 * matters is the other one: from the FILES on disk to the constant, which is
 * the order the mistake is actually made in.
 */
const DIR = path.dirname(fileURLToPath(import.meta.url));

function bundledFilenames(): string[] {
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

describe('bundled specialist manifest', () => {
  it('every bundled record is either v1 or listed in POST_V1_BUNDLED', () => {
    const unreachable = bundledFilenames().filter(
      (f) => !V1_BUNDLED.includes(f) && !POST_V1_BUNDLED.includes(f),
    );
    expect(
      unreachable,
      `These bundled specialists would reach only FRESH installs — add each to ` +
        `POST_V1_BUNDLED in src/specialists.ts: ${unreachable.join(', ')}`,
    ).toEqual([]);
  });

  it('every name in POST_V1_BUNDLED exists on disk', () => {
    const files = bundledFilenames();
    const missing = POST_V1_BUNDLED.filter((f) => !files.includes(f));
    expect(missing, `Named for seeding but not shipped: ${missing.join(', ')}`).toEqual([]);
  });

  // A mismatch makes the record unreachable (`get(id)` reads `<id>.json`) AND
  // unprotected (`roleOf` derives ids from filenames).
  it('every record id equals its filename', () => {
    const mismatched: string[] = [];
    for (const file of bundledFilenames()) {
      const raw = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf-8')) as { id?: string };
      if (raw.id !== file.replace(/\.json$/, '')) mismatched.push(file);
    }
    expect(mismatched).toEqual([]);
  });
});
