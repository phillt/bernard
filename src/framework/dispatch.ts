import { tool, type Tool } from 'ai';
import type { z } from 'zod';
import type { AgentContext } from './context.js';
import { definitions } from './agents/registry.js';
import { runDefinition } from './agents/run.js';
import type { ModelOverrides } from './agents/types.js';

export type AllowedOverride = 'provider' | 'model';

export interface DispatchToolOpts<TArgs, TInput> {
  /** Tool name surfaced to the model (e.g. `'agent'`, `'specialist_run'`). */
  toolName: string;
  description: string;
  parameters: z.ZodType<TArgs>;
  /** Registry id of the {@link AgentDefinition} this dispatch tool targets. */
  definitionId: string;
  /** AgentContext threaded through to the resolved definition. */
  ctx: AgentContext;
  /** Maps the AI-SDK tool args into the definition's TInput. */
  resolveInput(args: TArgs, ctx: AgentContext): TInput;
  /** Which `provider`/`model` overrides the args may carry. */
  allowOverrides?: AllowedOverride[];
  /**
   * Maps the formatted payload returned by the definition into the exact wire
   * bytes the model expects from this dispatch tool. Defaults to identity.
   */
  serializeForModel?(formatted: unknown, args: TArgs): unknown;
}

/**
 * Generic factory: turns an {@link AgentDefinition} (looked up by id from the
 * registry) into an AI-SDK `tool()` invocation. The four current dispatch
 * tools (`agent`, `specialist_run`, `task`, `tool_wrapper_run`) collapse to a
 * single call to this factory, distinguished only by `toolName`, `parameters`,
 * `definitionId`, and the `resolveInput` mapper.
 */
export function createDispatchTool<TArgs, TInput>(opts: DispatchToolOpts<TArgs, TInput>): Tool {
  const {
    ctx,
    definitionId,
    description,
    parameters,
    resolveInput,
    serializeForModel,
    allowOverrides,
  } = opts;

  return tool({
    description,
    parameters,
    execute: async (args, execOpts) => {
      const def = definitions.get<TInput>(definitionId);
      const input = resolveInput(args, ctx);
      const overrides = extractOverrides(args, allowOverrides);
      const { formatted } = await runDefinition(ctx, def, input, {
        abortSignal: execOpts.abortSignal,
        overrides,
      });
      return serializeForModel ? serializeForModel(formatted, args) : formatted;
    },
  });
}

function extractOverrides<TArgs>(
  args: TArgs,
  allowed: AllowedOverride[] | undefined,
): ModelOverrides | undefined {
  if (!allowed || allowed.length === 0) return undefined;
  const a = args as Record<string, unknown>;
  const out: ModelOverrides = {};
  if (allowed.includes('provider') && typeof a.provider === 'string') {
    out.provider = a.provider;
  }
  if (allowed.includes('model') && typeof a.model === 'string') {
    out.model = a.model;
  }
  return out.provider || out.model ? out : undefined;
}
