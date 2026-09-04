import { describe, it, expect } from 'vitest';
import { createDocsTool } from './docs.js';
import { allDocs, docIndex, renderDoc, renderIndex } from '../docs-store.js';
import { readToolMeta } from '../framework/tools/adapter.js';
import { riskFromMeta } from '../risk.js';

const tool = createDocsTool();
const run = (args: unknown) =>
  (tool.execute as (a: unknown, o: unknown) => Promise<string>)(args, {});

describe('the docs tool', () => {
  // Identity, not a re-check of the renderers' internals — `docs-store.test.ts`
  // owns the framing, the directive ordering and the byte-identical round trip.
  // What this file is for is that the tool hands those back unaltered.
  it('lists exactly the rendered index', async () => {
    expect(await run({ action: 'list' })).toBe(renderIndex(docIndex()));
  });

  it('returns exactly the rendered document', async () => {
    const doc = allDocs()[0];
    expect(await run({ action: 'read', id: doc.id })).toBe(renderDoc(doc));
  });

  it('names what exists when an id is wrong', async () => {
    // A bare refusal makes a model guess a second plausible id and spend
    // another turn on it. The available list is the cheapest possible recovery.
    const out = await run({ action: 'read', id: 'applet-styles' });
    expect(out).toMatch(/^Error:/);
    for (const doc of allDocs()) expect(out).toContain(doc.id);
  });

  it('asks for an id rather than guessing one', async () => {
    const out = await run({ action: 'read' });
    expect(out).toMatch(/^Error:/);
    expect(out).toContain('list');
  });

  it('trims an id, since a model copying from the index brings whitespace', async () => {
    const doc = allDocs()[0];
    expect(await run({ action: 'read', id: ` ${doc.id} ` })).toContain(
      `<source>${doc.id}</source>`,
    );
  });
});

describe('its classification', () => {
  const meta = readToolMeta(tool)!;

  it('is declared read-only, so the fail-closed gate does not refuse it', () => {
    // Under `toolMode: 'read-only'` the block gate refuses anything classified
    // a write, outright, with nobody to ask in a headless dispatch — the trap
    // `applet`'s `interview` action hit, where a constant-string getter was
    // treated as a mutation. Asserted as the OUTCOME (both actions run at low
    // risk and the tool is a read) rather than on whichever helper attached
    // the meta, so swapping that helper cannot silently change the answer.
    expect(meta.kind).toBe('read');
    expect(meta.sideEffect).toBe('none');
    for (const action of ['list', 'read']) {
      expect(riskFromMeta(meta, { action }), action).toBe('low');
    }
  });

  it('describes itself with the trigger words that make it reachable', () => {
    // The description is the whole discovery mechanism — it is the only thing
    // in the cached prefix, and the index deliberately is not. If it stops
    // naming applets or capabilities, the corpus becomes unreachable without a
    // single test failing anywhere else.
    const d = tool.description!;
    expect(d).toMatch(/applet/i);
    expect(d).toMatch(/list/);
    expect(d).toMatch(/what Bernard can do/i);
  });
});

describe('what makes the main agent look', () => {
  it('the base system prompt tells it the documentation exists', async () => {
    // The whole reason this is worth a line in the cached prefix: `list` and
    // `read` are cheap and reachable, but nothing TRIGGERS them. A user asking
    // "what can you do?" produces no tool call at all unless the model has
    // been told there is something to read — it answers from its tool list,
    // which is what it can reach this turn, not what Bernard is.
    const { BASE_SYSTEM_PROMPT } = await import('../agent-prompt.js');
    expect(BASE_SYSTEM_PROMPT).toContain('`docs`');
    expect(BASE_SYSTEM_PROMPT).toMatch(/what you can do/i);
  });

  it('states it as one static sentence, so the cached prefix stays byte-stable', async () => {
    // The prefix is the Anthropic prompt-cache boundary and must not vary with
    // anything turn-scoped. A line that interpolated the index — the obvious
    // "improvement" — would re-bill the whole prefix whenever a document
    // changed, and put the index in the one place progressive disclosure
    // exists to keep it out of.
    const { BASE_SYSTEM_PROMPT } = await import('../agent-prompt.js');
    for (const doc of allDocs()) expect(BASE_SYSTEM_PROMPT).not.toContain(doc.description);
  });
});
