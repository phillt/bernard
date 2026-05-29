import { describe, it, expect, vi } from 'vitest';
import { assembleContext } from '../context.js';
import type { BernardConfig } from '../../config.js';
import type { ToolOptions } from '../../tools/types.js';

// Tests construct stores against the real filesystem; isolate via BERNARD_HOME.
vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  renameSync: vi.fn(),
}));

function makeConfig(): BernardConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 4096,
    shellTimeout: 30000,
    tokenWindow: 0,
    maxSteps: 25,
    ragEnabled: false,
    theme: 'bernard',
    coordinatorMode: 'off',
    autoCreateSpecialists: false,
    autoCreateThreshold: 0.8,
    anthropicApiKey: 'sk-test',
  } as BernardConfig;
}

function makeToolOptions(): ToolOptions {
  return {
    shellTimeout: 30000,
    confirmDangerous: async () => false,
  };
}

describe('assembleContext', () => {
  it('carries config and toolOptions through', () => {
    const config = makeConfig();
    const toolOptions = makeToolOptions();
    const ctx = assembleContext({ config, toolOptions });
    expect(ctx.config).toBe(config);
    expect(ctx.toolOptions).toBe(toolOptions);
  });

  it('defaults mcp to empty registry + serverNames', () => {
    const ctx = assembleContext({ config: makeConfig(), toolOptions: makeToolOptions() });
    expect(ctx.mcp.tools).toEqual({});
    expect(ctx.mcp.serverNames).toEqual([]);
  });

  it('honors provided mcp registry', () => {
    const tools = { foo: { description: 'mock' } };
    const ctx = assembleContext({
      config: makeConfig(),
      toolOptions: makeToolOptions(),
      mcp: { tools, serverNames: ['a', 'b'] },
    });
    expect(ctx.mcp.tools).toBe(tools);
    expect(ctx.mcp.serverNames).toEqual(['a', 'b']);
  });

  it('honors store overrides for testing', () => {
    const fakeMemory = { sentinel: 'memory' } as any;
    const fakeSpecialists = { sentinel: 'specialists' } as any;
    const ctx = assembleContext({
      config: makeConfig(),
      toolOptions: makeToolOptions(),
      stores: {
        memory: fakeMemory,
        specialists: fakeSpecialists,
      },
    });
    expect(ctx.stores.memory).toBe(fakeMemory);
    expect(ctx.stores.specialists).toBe(fakeSpecialists);
    // Non-overridden stores still get defaults
    expect(ctx.stores.routines).toBeDefined();
    expect(ctx.stores.candidates).toBeDefined();
    expect(ctx.stores.correction).toBeDefined();
    expect(ctx.stores.toolProfiles).toBeDefined();
  });

  it('defaults all stores when none are provided', () => {
    const ctx = assembleContext({ config: makeConfig(), toolOptions: makeToolOptions() });
    expect(ctx.stores.memory).toBeDefined();
    expect(ctx.stores.routines).toBeDefined();
    expect(ctx.stores.specialists).toBeDefined();
    expect(ctx.stores.candidates).toBeDefined();
    expect(ctx.stores.correction).toBeDefined();
    expect(ctx.stores.toolProfiles).toBeDefined();
  });

  it('passes rag through unchanged', () => {
    const fakeRag = { sentinel: 'rag' } as any;
    const ctx = assembleContext({
      config: makeConfig(),
      toolOptions: makeToolOptions(),
      rag: fakeRag,
    });
    expect(ctx.rag).toBe(fakeRag);
  });
});
