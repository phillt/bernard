import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./providers/index.js', () => ({
  getModel: vi.fn(() => ({ modelId: 'mock' })),
  getProviderOptions: vi.fn(() => undefined),
}));

vi.mock('./logger.js', () => ({
  debugLog: vi.fn(),
}));

const generateTextMock = vi.fn();
vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return {
    ...actual,
    generateText: (...args: unknown[]) => generateTextMock(...args),
  };
});

import {
  isAllowedLookupTool,
  runReferenceLookup,
  interpretLookupResult,
  executeLookupTool,
} from './reference-tool-lookup.js';
import type { BernardConfig } from './config.js';

function makeConfig(overrides: Partial<BernardConfig> = {}): BernardConfig {
  return {
    provider: 'anthropic',
    model: 'claude-test',
    maxTokens: 4096,
    shellTimeout: 30000,
    tokenWindow: 0,
    maxSteps: 25,
    ragEnabled: false,
    theme: 'bernard',
    criticMode: false,
    reactMode: false,
    toolDetails: false,
    autoCreateSpecialists: false,
    autoCreateThreshold: 0.8,
    correctionEnabled: false,
    promptRewriter: false,
    referenceLookup: true,
    referenceLookupTools: [],
    ...overrides,
  };
}

function makeTool(execute: (args: unknown) => unknown, description = '', schema?: unknown): any {
  return {
    description,
    parameters: schema ? { jsonSchema: schema } : undefined,
    execute: vi.fn(async (args: unknown) => execute(args)),
  };
}

describe('isAllowedLookupTool', () => {
  it('allows MCP tools with read-only suffix', () => {
    expect(isAllowedLookupTool('contacts__search')).toBe(true);
    expect(isAllowedLookupTool('gmail__list')).toBe(true);
    expect(isAllowedLookupTool('crm__find')).toBe(true);
    expect(isAllowedLookupTool('docs__lookup')).toBe(true);
    expect(isAllowedLookupTool('files__read')).toBe(true);
    expect(isAllowedLookupTool('contacts__get')).toBe(true);
    expect(isAllowedLookupTool('contacts__query')).toBe(true);
  });

  it('rejects MCP tools with write suffix', () => {
    expect(isAllowedLookupTool('contacts__create')).toBe(false);
    expect(isAllowedLookupTool('contacts__update')).toBe(false);
    expect(isAllowedLookupTool('contacts__delete')).toBe(false);
    expect(isAllowedLookupTool('mailer__send')).toBe(false);
    expect(isAllowedLookupTool('docs__post')).toBe(false);
  });

  it('rejects built-in non-network tools by default', () => {
    expect(isAllowedLookupTool('shell')).toBe(false);
    expect(isAllowedLookupTool('memory')).toBe(false);
    expect(isAllowedLookupTool('cron_list')).toBe(false);
    expect(isAllowedLookupTool('file_read_lines')).toBe(false);
  });

  it('always allows web_search and web_read', () => {
    expect(isAllowedLookupTool('web_search')).toBe(true);
    expect(isAllowedLookupTool('web_read')).toBe(true);
  });

  it('honors the extraAllowed override (BERNARD_LOOKUP_TOOLS)', () => {
    expect(isAllowedLookupTool('shell', ['shell'])).toBe(true);
    expect(isAllowedLookupTool('custom_tool', ['custom_tool'])).toBe(true);
    expect(isAllowedLookupTool('contacts__create', ['contacts__create'])).toBe(true);
  });

  it('matches suffixes case-insensitively', () => {
    expect(isAllowedLookupTool('contacts__Search')).toBe(true);
    expect(isAllowedLookupTool('Contacts__LIST')).toBe(true);
  });
});

describe('runReferenceLookup', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
  });

  it('returns none when referenceLookup is disabled', async () => {
    const result = await runReferenceLookup(
      'my brother',
      { contacts__search: makeTool(() => []) },
      makeConfig({ referenceLookup: false }),
    );
    expect(result).toEqual({ status: 'none' });
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('returns none when no allowlisted tools are available', async () => {
    const result = await runReferenceLookup(
      'my brother',
      {
        shell: makeTool(() => 'output'),
        memory: makeTool(() => null),
        cron_list: makeTool(() => []),
      },
      makeConfig(),
    );
    expect(result).toEqual({ status: 'none' });
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('returns none when the LLM declines to pick a tool', async () => {
    generateTextMock.mockResolvedValueOnce({ text: '{"status":"none"}' });
    const result = await runReferenceLookup(
      'my brother',
      { contacts__search: makeTool(() => []) },
      makeConfig(),
    );
    expect(result).toEqual({ status: 'none' });
  });

  it('returns none when the LLM picks an unknown tool', async () => {
    generateTextMock.mockResolvedValueOnce({
      text: '{"status":"call","toolName":"hallucinated__search","args":{}}',
    });
    const result = await runReferenceLookup(
      'my brother',
      { contacts__search: makeTool(() => []) },
      makeConfig(),
    );
    expect(result).toEqual({ status: 'none' });
  });

  it('returns found when select → execute → interpret all succeed', async () => {
    const tool = makeTool(() => [{ name: 'Tom', email: 'tom@example.com' }]);
    generateTextMock
      .mockResolvedValueOnce({
        text: '{"status":"call","toolName":"contacts__search","args":{"query":"brother"}}',
      })
      .mockResolvedValueOnce({
        text: '{"status":"found","resolvedTo":"Tom <tom@example.com>"}',
      });
    const result = await runReferenceLookup('my brother', { contacts__search: tool }, makeConfig());
    expect(result).toEqual({
      status: 'found',
      resolvedTo: 'Tom <tom@example.com>',
      toolName: 'contacts__search',
    });
    expect(tool.execute).toHaveBeenCalledOnce();
  });

  it('returns ambiguous when interpret says so', async () => {
    generateTextMock
      .mockResolvedValueOnce({
        text: '{"status":"call","toolName":"contacts__search","args":{"query":"brother"}}',
      })
      .mockResolvedValueOnce({ text: '{"status":"ambiguous"}' });
    const result = await runReferenceLookup(
      'my brother',
      { contacts__search: makeTool(() => [{ name: 'Tom' }, { name: 'Tim' }]) },
      makeConfig(),
    );
    expect(result).toEqual({ status: 'ambiguous' });
  });

  it('falls open to none when the tool throws', async () => {
    generateTextMock.mockResolvedValueOnce({
      text: '{"status":"call","toolName":"contacts__search","args":{"query":"brother"}}',
    });
    const tool = {
      description: '',
      execute: vi.fn(async () => {
        throw new Error('network error');
      }),
    };
    const result = await runReferenceLookup('my brother', { contacts__search: tool }, makeConfig());
    expect(result).toEqual({ status: 'none' });
  });

  it('falls open to none when select response is malformed JSON', async () => {
    generateTextMock.mockResolvedValueOnce({ text: 'not even close to JSON' });
    const result = await runReferenceLookup(
      'my brother',
      { contacts__search: makeTool(() => []) },
      makeConfig(),
    );
    expect(result).toEqual({ status: 'none' });
  });

  it('honors the BERNARD_LOOKUP_TOOLS extension', async () => {
    generateTextMock
      .mockResolvedValueOnce({
        text: '{"status":"call","toolName":"my_custom_tool","args":{}}',
      })
      .mockResolvedValueOnce({ text: '{"status":"found","resolvedTo":"Result"}' });
    const result = await runReferenceLookup(
      'my brother',
      { my_custom_tool: makeTool(() => ({ ok: true })) },
      makeConfig({ referenceLookupTools: ['my_custom_tool'] }),
    );
    expect(result).toEqual({
      status: 'found',
      resolvedTo: 'Result',
      toolName: 'my_custom_tool',
    });
  });
});

describe('interpretLookupResult', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
  });

  it('parses a found response', async () => {
    generateTextMock.mockResolvedValueOnce({
      text: '{"status":"found","resolvedTo":"Tom Smith"}',
    });
    const result = await interpretLookupResult(
      'my brother',
      'contacts__search',
      '[{"name":"Tom"}]',
      makeConfig(),
    );
    expect(result).toEqual({
      status: 'found',
      resolvedTo: 'Tom Smith',
      toolName: 'contacts__search',
    });
  });

  it('falls open to none on malformed JSON', async () => {
    generateTextMock.mockResolvedValueOnce({ text: 'garbage' });
    const result = await interpretLookupResult(
      'my brother',
      'contacts__search',
      '[]',
      makeConfig(),
    );
    expect(result).toEqual({ status: 'none' });
  });

  it('falls open to none when generateText throws', async () => {
    generateTextMock.mockRejectedValueOnce(new Error('boom'));
    const result = await interpretLookupResult(
      'my brother',
      'contacts__search',
      '[]',
      makeConfig(),
    );
    expect(result).toEqual({ status: 'none' });
  });

  it('rejects a found response missing resolvedTo', async () => {
    generateTextMock.mockResolvedValueOnce({ text: '{"status":"found"}' });
    const result = await interpretLookupResult(
      'my brother',
      'contacts__search',
      '[]',
      makeConfig(),
    );
    expect(result).toEqual({ status: 'none' });
  });
});

describe('executeLookupTool', () => {
  it('returns null when the tool is not in the registry', async () => {
    const result = await executeLookupTool('nonexistent', {}, {});
    expect(result).toBeNull();
  });

  it('returns null when the tool throws', async () => {
    const tool = {
      description: '',
      execute: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const result = await executeLookupTool('t', {}, { t: tool });
    expect(result).toBeNull();
  });

  it('serializes object results to JSON', async () => {
    const tool = makeTool(() => ({ name: 'Tom' }));
    const result = await executeLookupTool('t', {}, { t: tool });
    expect(result).toBe('{"name":"Tom"}');
  });

  it('returns string results directly', async () => {
    const tool = makeTool(() => 'plain text');
    const result = await executeLookupTool('t', {}, { t: tool });
    expect(result).toBe('plain text');
  });

  it('aborts a slow tool via the abort signal', async () => {
    const tool = {
      description: '',
      execute: vi.fn(
        (_args: unknown, opts: { abortSignal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            const sig = opts.abortSignal;
            if (sig?.aborted) {
              reject(new Error('aborted'));
              return;
            }
            sig?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    };
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await executeLookupTool('t', {}, { t: tool }, ctrl.signal);
    expect(result).toBeNull();
  });
});
