import { describe, it, expect } from 'vitest';
import { createDocsTool } from './docs.js';
import { allDocs } from '../docs-store.js';
import { readToolMeta } from '../framework/tools/adapter.js';
import { riskFromMeta } from '../risk.js';

const tool = createDocsTool();
const run = (args: unknown) =>
  (tool.execute as (a: unknown, o: unknown) => Promise<string>)(args, {});

describe('the docs tool', () => {
  it('lists every document', async () => {
    const out = await run({ action: 'list' });
    for (const doc of allDocs()) {
      expect(out).toContain(doc.id);
      expect(out).toContain(doc.description);
    }
  });

  it('returns a document whole, framed, with the directive last', async () => {
    const doc = allDocs()[0];
    const out = await run({ action: 'read', id: doc.id });
    expect(out).toContain(doc.body.trimEnd());
    expect(out).toContain(`<source>${doc.id}</source>`);
    expect(out.indexOf('</document>')).toBeLessThan(out.indexOf('Do not paraphrase'));
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
    expect(await run({ action: 'read', id: ` ${doc.id} ` })).toContain(`<source>${doc.id}</source>`);
  });
});

describe('its classification', () => {
  const meta = readToolMeta(tool)!;

  it('is declared read-only, so the fail-closed gate does not refuse it', async () => {
    // `attachActionMeta` classifies an action a write unless it is named in
    // `readActions`, and under `toolMode: 'read-only'` the block gate then
    // refuses it outright — with nobody to ask, in a headless dispatch. That
    // is the trap `applet`'s `interview` action hit. Both actions are reads,
    // so both are asserted, not just the one that obviously looks like one.
    expect(meta.kind).toBe('read');
    expect(meta.sideEffect).toBe('none');
    for (const action of ['list', 'read']) {
      expect(meta.isWriteAction?.({ action }), action).toBe(false);
    }
  });

  it('is low risk, so it never raises a confirmation prompt', () => {
    expect(riskFromMeta(meta, { action: 'read', id: 'x' })).toBe('low');
  });

  it('is cacheable for the session, since the corpus cannot change under it', () => {
    // The cache sits AFTER every permission gate, so this cannot be used to
    // skip one. `cacheTtlMs: 0` is session-lifetime, not "no cache".
    expect(meta.deterministic).toBe(true);
    expect(meta.cacheable).toBe(true);
    expect(meta.cacheTtlMs).toBe(0);
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
