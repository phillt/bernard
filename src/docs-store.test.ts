import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MAX_TOOL_RESULT_CHARS } from './context.js';
import {
  MAX_DOC_CHARS,
  allDocs,
  docIndex,
  findDoc,
  findDocsDir,
  parseDoc,
  renderDoc,
  renderIndex,
} from './docs-store.js';
import { generatedDocs } from './docs-generated.js';
import {
  APPLET_COLOR_TOKENS,
  APPLET_SCALE_TOKENS,
  APPLET_STYLED_SELECTORS,
  TOKENS_PATH,
} from './host/tokens.js';
import { SDK_PATH } from './host/sdk.js';
import { MANIFEST_PATH, ICON_PATH } from './host/webmanifest.js';
import { UI_RUNTIME_PATH } from './host/ui-runtime.js';
import { INTENT_FIELDS, INTENT_FIELD_LABELS } from './apps/brief.js';
import { SLASH_COMMANDS } from './ui/slash-commands.js';
import { CONFIRM_MODES, TOOL_MODES } from './tool-modes.js';
import { COORDINATOR_MODES } from './coordinator-modes.js';
import { REMOTE_MESSAGE_MODES } from './remote-messages.js';
import { DEFAULT_ROLE_TIERS, MODEL_ROLES } from './model-roles.js';
import { WIZARD_CATEGORIES_DATA } from './profiles-wizard-data.js';

/**
 * The whole index, which is what `docs list` returns.
 *
 * Measured rather than chosen: the corpus rendered 1,656 characters over 7
 * documents when this was raised, i.e. about 222 per row. The previous bound
 * was 2,000 — one spare row — so writing a manual against it fails on the
 * SECOND file, on an assertion naming whichever document happened to be added
 * last.
 *
 * The finished manual measures **5,458 over 22 documents**, about 250 a row:
 * the estimate this was set from was low, because the older corpus had shorter
 * titles and terser descriptions. So the remaining headroom is two or three
 * documents rather than a dozen, and the right response to the next one that
 * does not fit is to cut a routing line rather than to raise this — the index
 * is what a model reads before choosing, and a line that names its trigger in
 * fewer words is a better line.
 *
 * Affordable because the index is returned on a `list` CALL, never carried in
 * the cached prefix: `docs.ts`'s `DESCRIPTION` deliberately does not enumerate
 * the documents for exactly that reason. So this is a per-call cost on a tool
 * used once or twice in a session, not a per-turn tax — which is the only
 * reason raising it is cheap, and the reason it must not become the place the
 * corpus grows without anyone noticing.
 */
const MAX_INDEX_CHARS = 6_000;

/**
 * One row of that index. See the per-document assertion for why a sum needs a
 * per-row ceiling as well.
 */
const MAX_DESCRIPTION_CHARS = 220;

/** `src/index.ts`, read once — the only statement of what the CLI accepts. */
const cliSource = fs.readFileSync(path.join('src', 'index.ts'), 'utf-8');

/** Every `.command('<name> …')` Commander is given, in declaration order. */
const cliCommands = [...cliSource.matchAll(/\.command\('([a-z][a-z0-9-]*)/g)].map((m) => m[1]);

/**
 * Every `--flag` spelling that appears in `src/index.ts`, as whole tokens.
 *
 * Deliberately every occurrence rather than only the first argument of an
 * `.option()` call: a flag named in a description or a comment there is still a
 * flag this CLI knows about, and parsing Commander's option grammar to be
 * stricter would fail on `-b, --bundled` and `--allow <specifier...>` long
 * before it caught anything.
 *
 * Whole tokens matter, though. A substring test passes `--voice-normalize`,
 * which does not exist — the real flag is `--no-voice-normalize`, and the
 * option Commander derives from it is not something a reader can type.
 */
const cliFlags = new Set(cliSource.match(/--[a-z][a-z0-9-]*/g) ?? []);

/**
 * Commander's own flags, which are real and appear in no `.option()` call.
 * `--version` is registered by `.version()`, `--help` by Commander itself.
 */
const BUILTIN_FLAGS = new Set(['--help', '--version']);

/**
 * Words that follow `bernard` in a backticked span without naming a command,
 * each with the reason — a `Record`, never a bare list, so a lazy exclusion has
 * to be argued for in review (`settings-coverage.test.ts`'s rule).
 *
 * The collision is real rather than sloppy: `bernard` is ALSO the JavaScript
 * global an applet page calls, and the browser's own message for a missing one
 * is quoted verbatim in `applet-page` — verbatim being the entire value, since
 * a reader greps the console text. Excluded by the following word rather than
 * by loosening the pattern, because every looser rule that skips this also
 * skips a real reference: dropping three-token spans loses `bernard app list`,
 * and requiring a flag loses `bernard setup`.
 */
const NOT_A_SUBCOMMAND: Record<string, string> = {
  is: "the browser error `bernard is not defined`, where `bernard` is the page's JS global",
};

/** Every `.ts`/`.tsx` file under `src/`, excluding tests. */
function sourceFiles(dir = 'src', out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('the document budget', () => {
  it('leaves a budget-sized document under the only cut a tool result meets', () => {
    // The whole verbatim guarantee, and the reason there is no new mechanism.
    // `truncateToolResults` is the single place a built-in tool's result is
    // shortened, applied when the turn enters history — so a document under
    // this survives byte-identical on every continuation re-seed, and one over
    // it is silently cut from the next turn onward.
    //
    // Asserted on the FRAMED document, which subsumes `MAX_DOC_CHARS <
    // MAX_TOOL_RESULT_CHARS` and additionally catches a wrapper that grew.
    // Asserted here rather than derived in `docs-store.ts`, which must not
    // import `context.ts` — 65 ms of module graph on every worker dispatch,
    // for one number. A test can afford that import; the leaf cannot.
    const framed = renderDoc({
      id: 'x',
      title: 't',
      description: 'd',
      body: 'y'.repeat(MAX_DOC_CHARS),
    });
    expect(framed.length).toBeLessThan(MAX_TOOL_RESULT_CHARS);
  });
});

describe('the shipped corpus', () => {
  const docs = allDocs();
  const cases = docs.map((d) => [d.id, d] as const);

  it('resolves beside the loaded module and is non-empty', () => {
    // `dist/docs` under a build, `src/docs` under `tsx` — the
    // `findBuiltinSpecialistsDir` idiom. A resolver anchored on `process.cwd()`
    // passes in this repo and fails in a global install. A `null` directory
    // renders as "no documentation is installed" rather than throwing —
    // correct at runtime, and silent, so it is pinned here.
    const dir = findDocsDir();
    expect(dir).not.toBeNull();
    expect(path.basename(dir!)).toBe('docs');
    expect(fs.statSync(dir!).isDirectory()).toBe(true);
    expect(docs.length).toBeGreaterThan(0);
  });

  it('parses every `.md` file on disk — a malformed one is skipped silently', () => {
    // `allDocs` swallows a parse failure so documentation cannot take a turn
    // down. That makes "I added a doc and it never appeared" the failure mode
    // this test exists to catch.
    const dir = findDocsDir()!;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    const ids = new Set(docs.map((d) => d.id));
    for (const file of files) expect(ids, `${file} did not parse`).toContain(file.slice(0, -3));
  });

  it('serves the derived documents alongside the authored ones', () => {
    // They come from `generatedDocs()`, not from disk, so the readdir check
    // above cannot see them — and a merge that silently dropped them would
    // leave three topics missing from the index with every other test green.
    const ids = docs.map((d) => d.id);
    for (const doc of generatedDocs()) expect(ids).toContain(doc.id);
  });

  it('derives the styling document from the live records, never a copy', () => {
    // The mutation this catches: a token added to `APPLET_COLOR_TOKENS` or a
    // selector to `APPLET_STYLED_SELECTORS` that never reaches the doc. Both
    // directions, because a doc naming a token the sheet does not serve is the
    // worse half — an agent writes `var(--x)` and gets nothing.
    const body = findDoc('applet-styling')!.body;
    for (const name of Object.keys(APPLET_COLOR_TOKENS)) expect(body).toContain(name);
    for (const sel of APPLET_STYLED_SELECTORS) expect(body).toContain(`\`${sel}\``);
    // The scale half. It was omitted entirely at first — 18 served tokens the
    // one document claiming to be complete never mentioned — so a styler told
    // to trust it would write raw rem values against a floor that has a scale.
    for (const name of Object.keys(APPLET_SCALE_TOKENS)) expect(body).toContain(name);
  });

  it('never names a colour variable that does not exist, in any document', () => {
    // The reverse direction, and the worse half: an agent told to write
    // `var(--muted)` gets nothing, silently, and the page looks broken with no
    // error anywhere. Matched as a backticked reference so the markdown table
    // separator and prose hyphens are not mistaken for tokens.
    // Both records, because the scale half (`--space-3`, `--text-lg`) is just
    // as real and just as served. Checking colours alone did more than miss
    // them — it made the corpus STRUCTURALLY unable to document the scale,
    // failing any doc that mentioned a token the floor genuinely has.
    const served = { ...APPLET_COLOR_TOKENS, ...APPLET_SCALE_TOKENS };
    for (const doc of docs) {
      for (const m of doc.body.match(/`(--[a-z][a-z0-9-]*)`/g) ?? []) {
        const name = m.slice(1, -1);
        // A CLI flag shares the `--name` spelling, and the manual backticks
        // `--sdk` and `--allow` exactly as it backticks `--accent`. Those are
        // checked against `src/index.ts` by the flag guard below, so the two
        // guards together still say that EVERY backticked `--name` is either a
        // token the stylesheet serves or a flag the CLI accepts — which is
        // strictly stronger than either alone, and is why this is an exemption
        // rather than a narrower regex.
        if (cliFlags.has(name)) continue;
        expect(served, `${doc.id} names ${name}`).toHaveProperty(name);
      }
    }
  });

  it('never names a served path that does not exist, in any document', () => {
    // Written after this exact mistake: the page contract was authored naming
    // `/__bernard/sdk.js`, which does not exist — the client is served at
    // `/__bernard/applet.js`. A page built from that doc links a 404 and every
    // button fails with `bernard is not defined`. It is the hallucination class
    // the corpus exists to prevent, so it cannot be left to proofreading.
    const served = new Set([TOKENS_PATH, SDK_PATH, MANIFEST_PATH, ICON_PATH, UI_RUNTIME_PATH]);
    for (const doc of docs) {
      for (const m of doc.body.match(/\/__bernard\/[A-Za-z0-9._-]+/g) ?? []) {
        expect([...served], `${doc.id} names ${m}`).toContain(m);
      }
    }
  });

  it('never names a `bernard` command that does not exist, in any document', () => {
    // Same shape as the served-path guard above, and the direction that has
    // actually failed: `docs/manual.html` still tells people to set
    // `BERNARD_REFERENCE_LOOKUP`, which #447 deleted along with the module it
    // gated. A manual naming a command that was removed is worse than one that
    // omits it — the reader types it, gets an error, and distrusts the rest.
    //
    // BACKTICKED only. Prose legitimately says "ask bernard to check the
    // deploy", and a bare-word scan would read `to` as a subcommand.
    for (const doc of docs) {
      for (const span of doc.body.match(/`[^`\n]+`/g) ?? []) {
        const named = /^`bernard\s+([a-z][a-z0-9-]*)/.exec(span);
        if (!named || named[1] in NOT_A_SUBCOMMAND) continue;
        expect(cliCommands, `${doc.id} names \`bernard ${named[1]}\``).toContain(named[1]);
      }
    }
  });

  it('routes to every other document from `bernard-capabilities`', () => {
    // That document is the one the base prompt points at for "what can you
    // do?", so a topic it does not name is a topic reachable only by a model
    // that already guessed the id. There is no search — `renderIndex` is the
    // whole retrieval layer — so the router is the other half of discovery,
    // and it is the half that rots, since adding a document does not touch it.
    const body = findDoc('bernard-capabilities')!.body;
    for (const doc of docs) {
      if (doc.id === 'bernard-capabilities') continue;
      expect(body, `nothing routes to ${doc.id}`).toContain(doc.id);
    }
  });

  it('documents every `bernard` command, or says why not', () => {
    // The record-to-table direction, which is the one the mistake is made in:
    // a command added to `src/index.ts` works, ships, and is simply absent from
    // the manual, which nothing notices. `settings-coverage.test.ts` makes the
    // same argument for `ProfileSettings`.
    //
    // A `Record`, never a `string[]`. Requiring a sentence is the cheapest
    // thing that makes a lazy exclusion visible in review — "we did not get to
    // it" does not survive being written down next to the name.
    const excluded: Record<string, string> = {
      'validate-lineup':
        'a diagnostic probe; `bernard-models` tells the reader to run it without tabulating it as a command',
      'voice-test':
        'a diagnostic; `bernard-cli` names it under diagnostics and `/voice` is the surface people use',
      'tool-profiles': 'a diagnostic readout of what Bernard learned, named under diagnostics',
    };
    // Backticked spans, with a leading `bernard ` optional, because a document
    // grouping a family writes `` `remove-key` `` and a document showing an
    // invocation writes `` `bernard say <text>` ``. Matching the bare word in
    // prose would accept `app`, `usage`, `update` and `script` by accident,
    // which are the four this guard most needs to be right about.
    const mentioned = new Set<string>();
    for (const doc of docs) {
      for (const span of doc.body.match(/`[^`\n]+`/g) ?? []) {
        const inner = span.slice(1, -1).replace(/^bernard\s+/, '');
        const head = /^([a-z][a-z0-9-]*)/.exec(inner);
        // Whole token: `cron-delete-all` must not stand in for `cron-delete`.
        if (head) mentioned.add(head[1]);
      }
    }
    for (const name of cliCommands) {
      if (name in excluded) continue;
      expect([...mentioned], `\`bernard ${name}\` is documented nowhere`).toContain(name);
    }
  });

  it('never names a `/command` that does not exist, in any document', () => {
    // The fourth member of a family that had three, and the gap let a wrong
    // sentence ship: `bernard-models` told the reader `/model` picks a model,
    // and `/model` is a deprecation stub that flashes a toast pointing at
    // `/lineup`. It is deliberately absent from `SLASH_COMMANDS` — the one
    // command the catalogue omits on purpose — so the corpus contradicted
    // itself, with `bernard-commands` correctly declining to list it two
    // documents away.
    //
    // A slash command is the same promise to the same reader as a `bernard`
    // subcommand, checked against a catalogue this file already imports. There
    // was no reason for it to be the unguarded one except that nobody had
    // written it.
    const known = new Set(SLASH_COMMANDS.map((c) => c.name));
    for (const doc of docs) {
      // Backticked, like the `bernard` guard, and for the sharper version of
      // the same reason: prose about "the /usage of a tool" is not a command,
      // and a bare-slash scan reads every path in the corpus as one.
      for (const span of doc.body.match(/`[^`\n]+`/g) ?? []) {
        // The closing backtick is itself the terminator, so a bare `` `/help` ``
        // needs no padding to match.
        const named = /^`(\/[a-z][a-z-]*)[\s`]/.exec(span);
        if (!named) continue;
        expect([...known], `${doc.id} names ${named[1]}`).toContain(named[1]);
      }
    }
  });

  it('never names a CLI flag that does not exist, in any document', () => {
    // The flag half of the same guarantee. Flags are where a manual rots
    // fastest: a command survives a rename far more often than its options do.
    //
    // CSS custom properties share the `--name` spelling and are checked by
    // their own guard above, so they are excluded here rather than matched
    // loosely — a regex narrow enough to miss `--img-src` would also miss
    // `--no-open`.
    const cssTokens = new Set([
      ...Object.keys(APPLET_COLOR_TOKENS),
      ...Object.keys(APPLET_SCALE_TOKENS),
    ]);
    for (const doc of docs) {
      for (const m of doc.body.match(/(?<![\w-])--[a-z][a-z0-9-]*/g) ?? []) {
        if (cssTokens.has(m) || BUILTIN_FLAGS.has(m)) continue;
        expect([...cliFlags], `${doc.id} names ${m}`).toContain(m);
      }
    }
  });

  it('never names a `BERNARD_*` variable nothing reads, in any document', () => {
    // The third direction of the same rule, and the one the 0.9 manual got
    // wrong. A variable that is documented and read by nothing is a setting the
    // reader believes they have changed: they set it, nothing happens, and
    // there is no error to search for.
    //
    // Read sites rather than a registry, because there is no registry — a
    // setting reaches `loadConfig` as `prefs.X ?? process.env.BERNARD_X ??
    // DEFAULT`, written inline at each field.
    const reads = sourceFiles()
      .map((f) => fs.readFileSync(f, 'utf-8'))
      .join('\n');
    for (const doc of docs) {
      for (const m of doc.body.match(/\bBERNARD_[A-Z0-9_]+/g) ?? []) {
        expect(reads, `${doc.id} names ${m}`).toContain(`process.env.${m}`);
      }
    }
  });

  it('derives the brief document from the field record', () => {
    const body = findDoc('applet-brief')!.body;
    for (const field of INTENT_FIELDS) {
      expect(body).toContain(`\`${field}\``);
      expect(body).toContain(INTENT_FIELD_LABELS[field]);
    }
  });

  it('derives the command document from the catalogue', () => {
    // Bernard maintains 35 commands with descriptions and, before this, no
    // code path put them in front of the model — it could not answer "what can
    // you do?" from the list it already keeps.
    const body = findDoc('bernard-commands')!.body;
    for (const cmd of SLASH_COMMANDS) {
      expect(body).toContain(cmd.name);
      expect(body).toContain(cmd.description);
    }
  });

  it('derives the permission document from the mode tables', () => {
    // `tool-modes.ts` exists because three surfaces spelled the same three
    // answers three different ways and one of them was wrong. A manual is the
    // fourth surface and the one a reader trusts most, so both halves of every
    // row are asserted: a label alone would let the explanation drift, which is
    // precisely the half that was wrong last time.
    const body = findDoc('bernard-permissions')!.body;
    for (const table of [TOOL_MODES, CONFIRM_MODES, COORDINATOR_MODES, REMOTE_MESSAGE_MODES]) {
      for (const row of table) {
        expect(body).toContain(row.label);
        expect(body).toContain(row.description);
      }
    }
  });

  it('derives the model document from the role record', () => {
    // `model-roles.ts` calls itself the single source of truth and derives the
    // lineup slots, the tier table and the editor menu from one list. Six
    // labels and eighteen tier cells restated by hand are the one copy running
    // Bernard cannot check.
    const body = findDoc('bernard-models')!.body;
    for (const role of MODEL_ROLES) {
      expect(body).toContain(role.label);
      expect(body).toContain(role.description);
      expect(body).toContain(role.lookFor);
    }
    // The grid, whole rows rather than cells. Asserting that the tier NAMES
    // appear somewhere would pass on a table with every row wrong, and the
    // reader's question — "what does balanced cost me?" — is answered by a row.
    for (const role of MODEL_ROLES) {
      const tiers = (['optimize-tokens', 'balanced', 'optimize-performance'] as const)
        .map((mode) => DEFAULT_ROLE_TIERS[mode][role.id])
        .join(' | ');
      expect(body, `tier row for ${role.id}`).toContain(`| **${role.label}** | ${tiers} |`);
    }
  });

  it('derives the settings document from the wizard registry', () => {
    // `settings-coverage.test.ts` already binds that registry to
    // `ProfileSettings`, so binding the document to the registry makes the
    // manual complete by transitivity — a setting added to Bernard fails that
    // test until it is declared, and fails this one until it is documented.
    const body = findDoc('bernard-settings')!.body;
    for (const category of WIZARD_CATEGORIES_DATA) {
      expect(body).toContain(category.title);
      for (const field of category.fields) {
        expect(body, `${field.key} label`).toContain(field.label);
        // The variable is the half a reader copies into a shell, and the half
        // the 0.9 manual got wrong by naming one that had been deleted.
        if (field.envVar) expect(body, `${field.key} variable`).toContain(field.envVar);
      }
    }
  });

  it('keeps every settings cell on one row', () => {
    // The document renders a first sentence into a markdown table. Nothing
    // stops a wizard description wrapping inside its first sentence or
    // containing a pipe — it is prose written for a full-screen step — and
    // either one silently breaks the table for every row after it.
    // EXACTLY three cells, not "at most". A pipe inside a cell gives too many
    // and a newline inside one gives too few, by splitting the row across two
    // lines — and only the first of those two failures is the one that springs
    // to mind, which is how a `toBeLessThanOrEqual` here would have shipped
    // blind to the likelier half.
    const body = findDoc('bernard-settings')!.body;
    for (const line of body.split('\n')) {
      if (!line.startsWith('| ')) continue;
      expect(line.split(/(?<!\\)\|/).length, `row: ${line}`).toBe(5);
    }
  });

  it.each(cases)('%s fits the budget', (_id, doc) => {
    expect(doc.body.length).toBeLessThanOrEqual(MAX_DOC_CHARS);
  });

  it.each(cases)('%s says what it is AND when to read it', (_id, doc) => {
    // `description` is the entire L1 payload — the only thing a model sees
    // before choosing. Anthropic's own anti-example is "Helps with
    // documents": a category with no trigger. Length is a proxy, and the
    // trigger clause is the part that actually matters, so both are checked.
    expect(doc.description.length).toBeGreaterThan(40);
    expect(doc.description).toMatch(/\b(read|use|consult|check)\b/i);
    expect(doc.title.length).toBeLessThan(60);
    // And an upper bound, because {@link MAX_INDEX_CHARS} is a SUM. Without a
    // per-row ceiling one expansive description silently spends three other
    // documents' share of the index, and the failure then surfaces on whichever
    // document happened to be added last — which is never the one at fault.
    expect(doc.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
  });

  it.each(cases)('%s round-trips byte-identically through read', (_id, doc) => {
    // No reflow, no escaping, no trimming of the interior. An agent acting
    // on a partially-rendered snippet is the documented failure — a page
    // that shipped without its `<script src>` line and 403'd on every click.
    const framed = renderDoc(doc);
    const inner = framed.slice(
      framed.indexOf('<document_content>\n') + '<document_content>\n'.length,
      framed.indexOf('\n</document_content>'),
    );
    expect(inner).toBe(doc.body.trimEnd());
  });

  it('gives each document a unique id', () => {
    expect(new Set(docs.map((d) => d.id)).size).toBe(docs.length);
  });

  it('keeps the index small enough to hand over whole', () => {
    // L1 is what makes the corpus discoverable without paying for it. If the
    // index itself needs paging, the design has stopped working.
    expect(renderIndex(docIndex()).length).toBeLessThan(MAX_INDEX_CHARS);
  });

  it('lists every document it can serve', () => {
    const rendered = renderIndex(docIndex());
    for (const doc of docs) expect(rendered).toContain(doc.id);
  });
});

describe('what the documents promise about the client', () => {
  /**
   * The binding that was missing when this cost someone half an hour: every
   * `bernard.*` a document names must exist on the client the host actually
   * serves. The corpus already binds colour tokens and served paths this way;
   * an API was the obvious third and was not there.
   *
   * Membership, not string equality — it asserts against a set derived from
   * executing the real script, so a rename fails and a reword does not.
   */
  async function servedSurface() {
    const vm = await import('node:vm');
    const { appletSdkScript } = await import('./host/sdk.js');
    const ctx: Record<string, unknown> = {
      window: {} as Record<string, unknown>,
      addEventListener() {},
      document: { getElementById: () => null },
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    };
    vm.createContext(ctx);
    new vm.Script(appletSdkScript()).runInContext(ctx);
    const bernard = (ctx.window as { bernard: Record<string, unknown> }).bernard;
    return {
      top: new Set(Object.keys(bernard)),
      store: new Set(Object.keys(bernard.store as object)),
    };
  }

  it('names no `bernard.store.*` method the client does not have', async () => {
    const { store } = await servedSurface();
    for (const doc of allDocs()) {
      for (const m of doc.body.matchAll(/\bbernard\.store\.([A-Za-z_$][\w$]*)/g)) {
        expect([...store], `${doc.id} names bernard.store.${m[1]}`).toContain(m[1]);
      }
    }
  });

  it('names no `bernard.*` member the client does not have', async () => {
    const { top } = await servedSurface();
    for (const doc of allDocs()) {
      for (const m of doc.body.matchAll(/\bbernard\.([A-Za-z_$][\w$]*)/g)) {
        expect([...top], `${doc.id} names bernard.${m[1]}`).toContain(m[1]);
      }
    }
  });

  it('shows no `<form>` in any code example, since the write path refuses one', () => {
    // A document teaching markup the write path rejects is worse than no
    // document. Closes the loop between the refusal and the corpus.
    //
    // Fenced blocks only. Prose that names `<form>` in order to FORBID it is
    // exactly what these documents should contain — the first cut checked the
    // whole body and failed on the warning it was written to enforce.
    for (const doc of allDocs()) {
      for (const block of doc.body.match(/```[\s\S]*?```/g) ?? []) {
        expect(block, `${doc.id} shows a <form> in an example`).not.toMatch(/<form[\s>]/i);
      }
    }
  });
});

describe('front matter', () => {
  it('reads the two keys and leaves the body untouched', () => {
    // The id comes from the FILENAME, never the front matter — no shipped doc
    // carries an `id:` key.
    const parsed = parseDoc(
      'x',
      '---\ntitle: A title\ndescription: What and when.\n---\n# Body\n\n  indented\n',
    );
    expect(parsed).toEqual({
      id: 'x',
      title: 'A title',
      description: 'What and when.',
      body: '# Body\n\n  indented\n',
    });
  });

  it('refuses a document missing a description, rather than shipping a blank one', () => {
    // A doc with no `description` is invisible at L1 — it would appear in the
    // index as a bare id and never be chosen. Dropping it is louder.
    expect(parseDoc('x', '---\ntitle: T\n---\nbody')).toBeNull();
    expect(parseDoc('x', '---\ndescription: D\n---\nbody')).toBeNull();
  });

  it('refuses a document with no front matter at all', () => {
    expect(parseDoc('x', '# Just a heading\n')).toBeNull();
  });

  it('tolerates CRLF and quoted values', () => {
    const parsed = parseDoc('x', '---\r\ntitle: "T"\r\ndescription: \'D E F\'\r\n---\r\nbody\r\n');
    expect(parsed?.title).toBe('T');
    expect(parsed?.description).toBe('D E F');
    expect(parsed?.body).toBe('body\r\n');
  });
});

describe('the rendered document', () => {
  const doc = allDocs()[0];
  const framed = renderDoc(doc);

  it('is delimited and names its source', () => {
    expect(framed).toContain(`<source>${doc.id}</source>`);
    expect(framed).toContain('<document_content>');
  });

  it('puts the directive AFTER the content', () => {
    // Documents-then-instruction, which is Anthropic's stated ordering and
    // worth up to 30% on multi-document tasks. A tool result arrives after the
    // instruction that asked for it, so this restores the ordering inside the
    // one message we control. Reversing it is a silent regression.
    expect(framed.indexOf('</document>')).toBeLessThan(framed.indexOf('Do not paraphrase'));
  });

  it('tells the model not to invent what is missing', () => {
    // 19.7% of packages suggested by code LLMs in a 576k-sample study did not
    // exist. This is the one line standing between that and a generated page.
    expect(framed).toMatch(/exact names/);
    expect(framed).toMatch(/rather than guessing/);
  });
});

describe('shipping', () => {
  it('the build copies the directory the resolver looks for', () => {
    // The finder and its `cpSync` line are coupled and nothing binds them, and
    // no test CAN bind them by resolution: vitest resolves `./docs-store.js` to
    // `src/`, so `findDocsDir()` returns `src/docs` whether or not `dist/docs`
    // was ever produced. A dropped copy step therefore ships a build where
    // `docs list` answers "No documentation is installed" with the whole suite
    // green — and this is the first bundled directory read on a TOOL RESULT
    // path, where absence is user-visible and silent.
    const script = fs.readFileSync('scripts/copy-builtins.mjs', 'utf-8');
    expect(script).toMatch(/'docs'/);
    expect(script).toMatch(/cpSync\(`src\/\$\{dir\}`, `dist\/\$\{dir\}`/);
  });

  it('clears each destination first, because cpSync merges and never deletes', () => {
    // A source file removed or renamed stays in `dist` forever across
    // incremental builds. That happened: `applet-ui-runtime.md` moved into
    // `docs-generated.ts`, and the stale `dist` copy meant a built install
    // served that document TWICE — the generated one bound to the live
    // constants, and the drifted hand-written copy deleted for drifting.
    //
    // No test can observe it directly: vitest resolves `src/`, so every finder
    // answers `src/docs` and `dist` is unreachable from here. Asserting on the
    // script is the only place the guarantee can live.
    const script = fs.readFileSync('scripts/copy-builtins.mjs', 'utf-8');
    expect(script).toMatch(/rmSync\(`dist\/\$\{dir\}`, \{ recursive: true, force: true \}\)/);
  });

  it('no authored document can shadow a generated one', () => {
    // The source-level form of the same collision, and the one that IS
    // reachable: a `src/docs/<id>.md` whose name matches a generated doc gives
    // two entries with one id, where `findDoc`'s `Array.find` silently picks a
    // winner. The stale-`dist` case above is prevented by the build; this one
    // has to be prevented here.
    const generated = new Set(generatedDocs().map((d) => d.id));
    for (const file of fs.readdirSync(findDocsDir()!)) {
      if (!file.endsWith('.md')) continue;
      expect(generated, `${file} shadows a generated document`).not.toContain(file.slice(0, -3));
    }
  });
});
