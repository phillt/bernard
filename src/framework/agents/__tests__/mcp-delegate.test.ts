import { describe, it, expect } from 'vitest';
import type { Tool } from 'ai';
import {
  mcpDelegateDefinition,
  MCP_DELEGATE_STEP_RATIO,
  buildDelegateSystemPrompt,
  type McpDelegateInput,
} from '../mcp-delegate.js';
import { pacActorDefinition, type PacActorInput } from '../pac-actor.js';
import { NormalStrategy } from '../../strategies/normal.js';
import { SUBAGENT_RESULT_MAX_CHARS } from '../../../tools/result-cap.js';
import type { BernardConfig } from '../../../config.js';
import type { AgentContext } from '../../context.js';

function input(over: Partial<McpDelegateInput> = {}): McpDelegateInput {
  return {
    server: 'google',
    task: 'find the latest email from Jody',
    slotId: 1,
    childTools: { google__list: {} as Tool, ask_user: {} as Tool },
    systemPrompt: 'SYS',
    ...over,
  };
}

describe('mcpDelegateDefinition (#296)', () => {
  it('is a store-free single-loop helper at the tool-wrapper site with ephemeral history', () => {
    expect(mcpDelegateDefinition.id).toBe('mcp-delegate');
    expect(mcpDelegateDefinition.site).toBe('tool-wrapper');
    expect(mcpDelegateDefinition.historyMode).toBe('ephemeral');
    expect(mcpDelegateDefinition.strategy({} as AgentContext, input())).toBeInstanceOf(
      NormalStrategy,
    );
  });

  it('returns the caller-provided scoped tool set and system prompt verbatim', () => {
    const inp = input();
    expect(mcpDelegateDefinition.tools({} as AgentContext, inp)).toBe(inp.childTools);
    expect(mcpDelegateDefinition.systemPrompt({} as AgentContext, inp)).toBe('SYS');
  });

  it('budgets half of maxSteps with a floor of 2', () => {
    expect(MCP_DELEGATE_STEP_RATIO).toBe(0.5);
    expect(mcpDelegateDefinition.stepBudget({ maxSteps: 25 } as BernardConfig, input())).toBe(13); // ceil(12.5)
    expect(mcpDelegateDefinition.stepBudget({ maxSteps: 10 } as BernardConfig, input())).toBe(5);
    expect(mcpDelegateDefinition.stepBudget({ maxSteps: 1 } as BernardConfig, input())).toBe(2); // floor
  });

  it('composes the user message with task alone, or task + context', () => {
    expect(mcpDelegateDefinition.buildUserMessage(input())).toEqual({
      role: 'user',
      content: 'Task: find the latest email from Jody',
    });
    expect(mcpDelegateDefinition.buildUserMessage(input({ context: 'account: work' }))).toEqual({
      role: 'user',
      content: 'Task: find the latest email from Jody\n\nContext: account: work',
    });
  });

  it('caps an over-budget result and passes a small one through untouched', () => {
    const long = 'x'.repeat(SUBAGENT_RESULT_MAX_CHARS + 500);
    const capped = mcpDelegateDefinition.formatResult(
      { text: long } as never,
      input(),
      {} as AgentContext,
    );
    expect(capped.length).toBeLessThanOrEqual(SUBAGENT_RESULT_MAX_CHARS);
    expect(capped).toContain('[output truncated');

    const small = mcpDelegateDefinition.formatResult(
      { text: 'short summary' } as never,
      input(),
      {} as AgentContext,
    );
    expect(small).toBe('short summary');
  });
});

describe('buildDelegateSystemPrompt (#296)', () => {
  it('names the server, lists its tools, and enforces the return contract', () => {
    const p = buildDelegateSystemPrompt('google', ['google__list', 'google__get']);
    expect(p).toContain('"google"');
    expect(p).toContain('google__list, google__get');
    expect(p).toContain('NEVER dump raw');
    expect(p).toContain('ask_user');
    expect(p).toContain('Stay strictly within this server');
  });
});

describe('pacActorDefinition scoped-tools override (#296 Phase 2E)', () => {
  function actorInput(over: Partial<PacActorInput> = {}): PacActorInput {
    return { task: 't', plan: 'p', slotId: 1, ...over };
  }

  it('returns the caller-provided childTools verbatim, keeping MCP schemas contained', () => {
    const scoped: Record<string, Tool> = {
      google__list: {} as Tool,
      ask_user: {} as Tool,
    };
    const out = pacActorDefinition.tools({} as AgentContext, actorInput({ childTools: scoped }));
    expect(out).toBe(scoped);
  });
});
