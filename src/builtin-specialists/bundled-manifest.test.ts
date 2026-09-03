import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POST_V1_BUNDLED } from '../specialists.js';

/**
 * What the original `.seeded-v1` pass shipped.
 *
 * A test fixture, not production state: `seedBundledJsonDir` copies the whole
 * directory under one marker, so this set only ever existed as "whatever was
 * there that day". It is frozen by definition — no future edit can change what
 * v1 shipped — so it has no business being importable by production code, and
 * `SpecialistStore` should not export a field about the past.
 */
const V1_BUNDLED = [
  'correction-agent.json',
  'file-wrapper.json',
  'shell-wrapper.json',
  'specialist-creator.json',
  'web-wrapper.json',
];

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

/**
 * The two applet-authoring prompts must teach the served client, not the wire
 * protocol.
 *
 * Both once described the protocol in prose — bootstrap, then POST with an
 * `x-bernard-token` header — and a generated page duly hand-rolled it and got
 * a 403 on every click. The write path refuses that now, but a prompt that
 * still teaches it wastes a turn per applet before the refusal lands.
 */
describe('the applet specialists teach the client, not the protocol', () => {
  const load = (name: string) =>
    JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf-8')) as Record<string, unknown>;

  const text = (record: Record<string, unknown>) =>
    JSON.stringify([record.systemPrompt, record.guidelines, record.goodExamples]);

  for (const name of ['applet-styler', 'applet-reviewer']) {
    it(`${name} names the served client`, () => {
      expect(text(load(name))).toContain('/__bernard/applet.js');
    });

    it(`${name} never instructs a page to set the session header`, () => {
      // The one instruction that reproduces the original defect. Allowed only
      // as something to REFUSE — so it may appear in a badExample, never in
      // the prompt, guidelines or a good example.
      expect(text(load(name)).toLowerCase()).not.toContain('with `x-bernard-token`');
    });
  }

  it('applet-reviewer does not claim `bernard script` proves a button works', () => {
    // It bypasses the HTTP server entirely, so a green run and a dead button
    // are compatible — which is how a broken applet shipped.
    const p = String(load('applet-reviewer').systemPrompt);
    expect(p).toContain('does not touch the browser half');
    expect(p).not.toContain('This is the check that matters');
  });
});
