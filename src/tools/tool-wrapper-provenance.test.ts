import { describe, it, expect, vi } from 'vitest';

// Minimal mocks for the imports tool-wrapper-run pulls in. We only exercise
// the two pure helpers (ctxToToolWrapperDeps / depsToCtx) so the heavyweight
// dispatcher dependencies can be stubbed.
vi.mock('ai', () => ({
  generateText: vi.fn(),
  tool: vi.fn((def: any) => def),
}));
vi.mock('../providers/index.js', () => ({
  getModel: vi.fn(() => 'mock-model'),
  getModelForConfig: vi.fn(() => 'mock-model'),
  getProviderOptions: vi.fn(() => undefined),
  getProviderOptionsForConfig: vi.fn(() => undefined),
}));
vi.mock('./index.js', () => ({ createTools: vi.fn(() => ({})) }));
vi.mock('./subagent.js', () => ({ createSubAgentTool: vi.fn(() => ({})) }));
vi.mock('./task.js', () => ({
  createTaskTool: vi.fn(() => ({})),
  makeLastStepTextOnly: vi.fn(() => undefined),
}));
vi.mock('./specialist-run.js', () => ({ createSpecialistRunTool: vi.fn(() => ({})) }));

import { ctxToToolWrapperDeps, depsToCtx } from './tool-wrapper-run.js';
import { ProvenanceStore } from '../provenance.js';
import type { AgentContext } from '../framework/context.js';

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  const base: any = {
    config: {} as any,
    stores: {
      memory: {} as any,
      routines: {} as any,
      specialists: {} as any,
      candidates: {} as any,
      correction: {} as any,
      toolProfiles: {} as any,
    },
    mcp: { tools: {}, serverNames: [] },
    rag: undefined,
    toolOptions: {} as any,
    provenance: new ProvenanceStore(),
  };
  return { ...base, ...overrides } as AgentContext;
}

describe('ToolWrapperDeps provenance round-trip (issue #173)', () => {
  it('ctxToToolWrapperDeps forwards the same ProvenanceStore reference', () => {
    const ctx = makeCtx();
    const deps = ctxToToolWrapperDeps(ctx);
    expect(deps.provenance).toBe(ctx.provenance);
  });

  it('depsToCtx preserves the original store reference (shared by reference)', () => {
    const ctx = makeCtx();
    ctx.provenance.add({
      kind: 'web',
      label: 'parent',
      contentPreview: '',
      rawRef: 'https://parent',
    });
    const deps = ctxToToolWrapperDeps(ctx);
    const innerCtx = depsToCtx(deps);
    expect(innerCtx.provenance).toBe(ctx.provenance);
    expect(innerCtx.provenance.size()).toBe(1);
    // mutations inside the inner ctx must be visible to the parent
    innerCtx.provenance.add({
      kind: 'web',
      label: 'child',
      contentPreview: '',
      rawRef: 'https://child',
    });
    expect(ctx.provenance.size()).toBe(2);
  });

  it('depsToCtx supplies a fresh store when deps.provenance is absent', () => {
    const deps = ctxToToolWrapperDeps(makeCtx());
    delete (deps as any).provenance;
    const innerCtx = depsToCtx(deps);
    expect(innerCtx.provenance).toBeInstanceOf(ProvenanceStore);
    expect(innerCtx.provenance.size()).toBe(0);
  });
});
