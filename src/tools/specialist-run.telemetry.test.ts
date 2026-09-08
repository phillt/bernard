import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Specialist spend is attributed to a specialist site (#299, #508).
 *
 * `specialistDefinition` declares `site: 'specialist'`, but `resolveModel`
 * overrides the resolved site and `run.ts`'s precedence puts `opts.telemetrySite`
 * first — so the number `bernard usage` actually shows is decided here, at the
 * call site, exactly as `tool_wrapper_run`'s `tool-wrapper:<id>` and
 * `delegate_<server>`'s `mcp:<server>` are.
 *
 * Its own file because it mocks `runDefinition`, which the main suite drives for
 * real.
 */

const runDefinitionMock = vi.fn(async () => ({ formatted: 'done', result: {}, resolved: {} }));

vi.mock('../framework/agents/run.js', () => ({
  runDefinition: (...args: unknown[]) => runDefinitionMock(...(args as [])),
}));

vi.mock('../framework/agents/index.js', () => ({
  specialistDefinition: { id: 'specialist' },
  registerBuiltinDefinitions: vi.fn(),
  definitions: { get: () => ({ id: 'specialist' }) },
}));

vi.mock('../output.js', () => ({
  printSpecialistStart: vi.fn(),
  printSpecialistEnd: vi.fn(),
}));

const { createSpecialistRunTool } = await import('./specialist-run.js');

function makeCtx(): any {
  return {
    config: {
      provider: 'anthropic',
      model: 'claude-x',
      anthropicApiKey: 'sk-test',
      maxSteps: 20,
      customProviders: {},
    },
    stores: {
      specialists: {
        get: (id: string) =>
          id === 'researcher'
            ? { id, name: 'R', description: '', systemPrompt: '', guidelines: [] }
            : undefined,
      },
    },
    mcp: { tools: {}, serverNames: [], serverTools: new Map() },
    toolOptions: {},
  };
}

beforeEach(() => vi.clearAllMocks());

describe('specialist_run telemetry attribution', () => {
  it('names its own site per specialist, so spend stops folding into `main`', async () => {
    const tool = createSpecialistRunTool(makeCtx());
    await tool.execute!({ specialistId: 'researcher', task: 'go' } as never, {} as never);

    expect(runDefinitionMock).toHaveBeenCalledTimes(1);
    const opts = runDefinitionMock.mock.calls[0][3] as { telemetrySite?: string };
    expect(opts.telemetrySite).toBe('specialist:researcher');
  });
});
