import { describe, it, expect } from 'vitest';
import type { Tool } from 'ai';
import { toolWrapperDefinition } from '../tool-wrapper.js';
import { CITATIONS_PROMPT } from '../../../agent-prompt.js';
import type { AgentContext } from '../../context.js';

const specialist = {
  id: 'x',
  name: 'X',
  description: '',
  systemPrompt: 'You are X.',
  guidelines: [],
  kind: 'tool-wrapper' as const,
  createdAt: '',
  updatedAt: '',
};

function ctxWith(provider: string, model: string): AgentContext {
  return {
    config: { provider, model, modelMode: 'off', customProviders: {} },
    stores: { specialists: { get: () => specialist } },
  } as unknown as AgentContext;
}

const input = (tools: string[]) => ({
  specialistId: 'x',
  input: 'q',
  slotId: 1,
  wantStructured: true,
  childTools: Object.fromEntries(tools.map((t) => [t, {} as Tool])),
});

const prompt = (ctx: AgentContext, tools: string[]) =>
  toolWrapperDefinition.systemPrompt(ctx, input(tools) as any);

describe('tool-wrapper citation conventions (#417)', () => {
  // The gap this closes: CITATIONS_PROMPT attached only to the main agent, so a
  // dispatched specialist registered sources into the shared store and was
  // never told the convention for citing them.
  it('tells a source-bearing wrapper how to cite', () => {
    expect(
      prompt(ctxWith('anthropic', 'claude-sonnet-4-5-20250929'), ['cite', 'web_read']),
    ).toContain(CITATIONS_PROMPT);
  });

  // Gated on the RESOLVED registry, not on `targetTools`: `cite` only exists
  // when a provenance store does, so a wrapper without it must not be told to
  // use a tool it does not have.
  it('says nothing about citations when cite did not resolve', () => {
    expect(prompt(ctxWith('anthropic', 'claude-sonnet-4-5-20250929'), ['web_read'])).not.toContain(
      CITATIONS_PROMPT,
    );
  });

  // Mirrors the main agent's carve-out: these families' systemSuffix already
  // forbids narrating inline markers, so forcing `[^Sn]` would conflict.
  it('suppresses the marker instruction on reasoning families', () => {
    expect(prompt(ctxWith('openai', 'gpt-5.2'), ['cite', 'web_read'])).not.toContain(
      CITATIONS_PROMPT,
    );
  });

  it('leaves the rest of the prompt assembly unchanged', () => {
    const out = prompt(ctxWith('anthropic', 'claude-sonnet-4-5-20250929'), ['cite']);
    expect(out.startsWith('You are X.')).toBe(true);
    expect(out).toContain('Available tools for this run: cite');
  });
});
