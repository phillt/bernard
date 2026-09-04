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
    expect(renderIndex(docIndex()).length).toBeLessThan(2_000);
  });

  it('lists every document it can serve', () => {
    const rendered = renderIndex(docIndex());
    for (const doc of docs) expect(rendered).toContain(doc.id);
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
