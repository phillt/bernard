import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POST_V1_BUNDLED } from '../specialists.js';
import { APPLET_COLOR_TOKENS, APPLET_STYLED_SELECTORS } from '../host/tokens.js';
import { UI_RUNTIME_PATH, UI_RUNTIME_RULE } from '../host/ui-runtime.js';

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

/**
 * The styler's token vocabulary must match the artefact (#465).
 *
 * A prompt that enumerates tokens is a second copy of `tokens.ts`, and #424
 * built the served stylesheet precisely because things repeated by hand drift.
 * The enumeration is allowed to exist — a model needs the vocabulary in front
 * of it — but only if a test makes the copy provably current.
 */
describe('applet-styler stays in step with the served tokens', () => {
  const styler = JSON.parse(fs.readFileSync(path.join(DIR, 'applet-styler.json'), 'utf-8')) as {
    systemPrompt: string;
    goodExamples: { call: string }[];
  };

  it('names every colour token the floor serves', () => {
    const missing = Object.keys(APPLET_COLOR_TOKENS).filter(
      (name) => !styler.systemPrompt.includes(name),
    );
    expect(missing).toEqual([]);
  });

  it('does not tell anyone to read the stylesheet off disk', () => {
    // `/__bernard/tokens.css` is generated in memory and never written to a
    // file, so the old `file_read_lines` instruction could not be followed.
    // The fix is not to write the sheet out — that reintroduces the per-applet
    // copy #424 removed — it is to make the enumeration above authoritative.
    expect(styler.systemPrompt).not.toContain('file_read_lines');
  });

  it('carries the same honesty clause as the reviewer', () => {
    expect(styler.systemPrompt).toContain('cannot see the page render');
  });

  it('names every selector the floor styles (#466)', () => {
    // The drift this replaces: the prompt's list omitted TEN selectors the
    // sheet really had — `.note`, `.err`, `.success`, `.warning`, `.info`,
    // `.output`, `.app`, `button.danger`, `ul`/`ol`, `section + section` — so a
    // model was told to write CSS it did not need. Nothing bound them.
    const missing = APPLET_STYLED_SELECTORS.filter(
      (sel) => !styler.systemPrompt.includes(`\`${sel}\``),
    );
    expect(
      missing,
      `selectors the floor styles but the styler is not told about: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('passes a `note` on update, which the tool now requires (#463)', () => {
    // The coupling that would otherwise break silently: `applet update`
    // refuses without a note, `styleNote` fails open, so the applet keeps its
    // scaffold page and nothing says why. Asserted on the record because the
    // record is the half that has to change.
    expect(styler.systemPrompt).toContain('`note`');
    for (const example of styler.goodExamples) {
      if (!example.call.includes('applet update')) continue;
      expect(example.call, 'the update example must model the required note').toContain('note:');
    }
  });
});

describe('the two-path rule is stated once (#466)', () => {
  it('the styler names the runtime and the rule for reaching for it', () => {
    // The rule lives in two prompts — here and the `applet` tool's `page`
    // description — and nothing bound them. That is the drift the styled-token
    // and styled-selector pins on this same branch exist to stop, so it gets
    // the same treatment rather than a third unbound copy.
    const styler = JSON.parse(fs.readFileSync(path.join(DIR, 'applet-styler.json'), 'utf-8')) as {
      systemPrompt: string;
    };
    expect(styler.systemPrompt).toContain(UI_RUNTIME_PATH);
    expect(styler.systemPrompt).toContain(UI_RUNTIME_RULE);
  });
});

/**
 * The three planners that decide what an applet should be (#13).
 *
 * They are frozen the moment they ship — `roleOf` derives `builtin` from this
 * directory, so no user can edit, disable or delete one — and their whole
 * mechanism is prose. That combination is what makes these pins worth having:
 * a prompt naming a document that does not exist, or claiming an authority the
 * write path does not grant, fails as a WORSE PLAN rather than as an error.
 */
describe('the applet planners (#13)', () => {
  const PLANNERS = ['applet-architect', 'applet-ux-planner', 'applet-data-planner'];

  const load = (name: string) =>
    JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf-8')) as {
      kind: string;
      targetTools: string[];
      structuredOutput: boolean;
      systemPrompt: string;
      guidelines: string[];
    };

  it.each(PLANNERS)('%s can reach the documentation it is told to read', (name) => {
    // `docs` is `audience: 'main'`, which sounds like it excludes a dispatched
    // specialist and does not: `toolWrapperDefinition` declares
    // `toolSurface: 'full'`, and the surface filter drops `'main'` groups only
    // on a WORKER surface. Without `docs` in targetTools these three would run
    // tool-less and plan from memory, which is the one thing they must not do.
    const record = load(name);
    expect(record.targetTools).toContain('docs');
    expect(record.kind).toBe('tool-wrapper');
    // Declared, never inherited from the `kind` default. `wantsStructuredOutput`
    // exists because the two dispatch doors once disagreed about that default.
    expect(record.structuredOutput).toBe(true);
    expect(record.guidelines.length).toBeGreaterThan(0);
  });

  it.each(PLANNERS)('%s names only documents that exist', async (name) => {
    // The anti-drift direction that matters: a prompt telling a planner to read
    // `applet-design` gets an `Error: no document` and a wasted step, and the
    // planner then invents the guidance it was sent to fetch.
    const { allDocs } = await import('../docs-store.js');
    const ids = new Set(allDocs().map((d) => d.id));
    const named = load(name).systemPrompt.match(/`(applet-[a-z-]+|bernard-[a-z-]+)`/g) ?? [];
    const unknown = [
      ...new Set(
        named
          .map((m) => m.replace(/`/g, ''))
          // The planners' own ids look exactly like doc ids, and a prompt
          // naming a sibling planner is not naming a document.
          .filter((id) => !PLANNERS.includes(id) && !ids.has(id)),
      ),
    ];
    expect(unknown, `Names documents that do not exist: ${unknown.join(', ')}`).toEqual([]);
  });

  it('the UX planner carries the honesty clause and the two-path rule', () => {
    const prompt = load('applet-ux-planner').systemPrompt;
    // The clause `applet-styler` and `applet-reviewer` both carry, for the same
    // reason: Bernard has no browser, so a claim about how a page LOOKS is
    // unfalsifiable. A planner is allowed to exist here precisely because it
    // decides structure, which is decidable from the records — the moment it
    // starts asserting appearance, that argument stops holding.
    expect(prompt).toContain('cannot see the page render');
    // Same pin the styler carries. Three prompts now state this rule; the point
    // of a constant is that none of them is allowed to paraphrase it.
    expect(prompt).toContain(UI_RUNTIME_PATH);
    expect(prompt).toContain(UI_RUNTIME_RULE);
  });

  it('the UX planner plans against selectors the stylesheet actually has', async () => {
    // It summarises the class list rather than enumerating it — the full list is
    // in `applet-styling`, which it is told to read, and a second enumeration is
    // exactly the copy #424 built the served sheet to end. So the pin runs the
    // other way: every class it DOES name has to be real.
    const named = load('applet-ux-planner').systemPrompt.match(/`\.[a-z-]+`/g) ?? [];
    const real = new Set(APPLET_STYLED_SELECTORS.map((s) => s.split(/[ :>]/)[0]));
    const invented = [...new Set(named.map((m) => m.replace(/`/g, '')))].filter(
      (c) => !real.has(c),
    );
    expect(invented, `Names classes the sheet does not style: ${invented.join(', ')}`).toEqual([]);
  });

  it('the data planner names every argument type and no others', async () => {
    // Read off the zod enum rather than retyped. A fifth type in the prompt is a
    // plan the manifest cannot express; a missing one is a plan that reaches for
    // `string` where an enum would have made the action uninjectable.
    const { ArgSpecSchema } = await import('../apps/manifest.js');
    const shape = (
      ArgSpecSchema as unknown as { _def: { schema?: { shape: Record<string, any> } } }
    )._def.schema?.shape;
    const types: string[] = (shape?.type?._def?.values ?? shape?.type?.options) as string[];
    expect(types.length).toBeGreaterThan(0);
    const prompt = load('applet-data-planner').systemPrompt;
    for (const t of types) expect(prompt, `does not name the \`${t}\` type`).toContain(`\`${t}\``);
  });

  it('no planner depends on an intent field the interview never fills', async () => {
    // The bridge from the interview to the planners is the brief's `intent`, and
    // it is NARROW: the record has twelve fields and four questions fill four of
    // them. A planner reaching for one of the other eight is not a visible
    // failure — `renderIntent` drops empty fields, so the planner never sees the
    // name, silently takes whatever fallback the prompt gave it, and the rule
    // reads as live while being dead on every single build.
    //
    // Found exactly that way: `applet-ux-planner` derived control size and
    // density from `intent.context`, which no question asks for, so the rule
    // could never once have fired.
    const { INTERVIEW_QUESTIONS } = await import('../apps/interview.js');
    const { INTENT_FIELDS } = await import('../apps/brief.js');
    const filled = new Set<string>(INTERVIEW_QUESTIONS.map((q) => q.field));
    expect(filled.size).toBeGreaterThan(0);

    for (const name of PLANNERS) {
      const prompt = load(name).systemPrompt;
      const dead = INTENT_FIELDS.filter((f) => !filled.has(f) && prompt.includes(`\`${f}\``));
      expect(
        dead,
        `${name} plans from intent fields the interview never collects, so those ` +
          `rules are dead on every build: ${dead.join(', ')}. Either ask for them ` +
          `or derive them from a field that IS filled (${[...filled].join(', ')}).`,
      ).toEqual([]);
    }
  });

  it('states the plain-language rule once, for both the interviewer and the labels', async () => {
    // Same shape as the `UI_RUNTIME_RULE` pin directly below. Two surfaces —
    // what the interviewer SAYS and what a button LABEL says — one rule, and
    // before the constant they were two strings nothing held together.
    const { PLAIN_LANGUAGE_RULE, interviewPlaybook } = await import('../apps/interview.js');
    expect(interviewPlaybook()).toContain(PLAIN_LANGUAGE_RULE);
    expect(load('applet-ux-planner').systemPrompt).toContain(PLAIN_LANGUAGE_RULE);
  });

  it('no planner claims it can grant tools', () => {
    // `toolAllowlist`, `toolMode` and `confirmMode` are the user's, settable
    // only from the command line — the `applet` tool merely carries them
    // through from a prior manifest. A planner that writes one into its plan
    // produces an action created tool-less that then answers badly rather than
    // failing, which is the hardest shape to diagnose.
    const prompt = load('applet-data-planner').systemPrompt;
    expect(prompt).toContain('bernard app allow');
    expect(prompt).toMatch(/cannot grant them/i);
    for (const name of PLANNERS) {
      expect(load(name).systemPrompt).not.toMatch(/set `?toolAllowlist/i);
    }
  });
});
