import { tool, type Tool } from 'ai';
import type { BernardTool, ToolMeta, ToolResult } from './types.js';
import { isToolResult } from './types.js';

/**
 * Wraps a `BernardTool` so it satisfies the AI SDK's `tool()` contract. The
 * adapter swallows execution-level throws and rethrows them — the model still
 * sees the historical shape via `serializeForModel`; downstream Bernard code
 * sees the envelope when it inspects the wrapped tool's return.
 *
 * Returns the AI-SDK `Tool` object **plus** a non-enumerable `meta` field so
 * the augmentation layer and the registry can read metadata without holding a
 * separate reference to the `BernardTool`.
 */
export function toolToAISDK<TArgs, TData>(t: BernardTool<TArgs, TData>): Tool {
  const aisdk = tool({
    description: t.description,
    parameters: t.parameters,
    execute: async (args, opts) => {
      const envelope = await t.execute(args as TArgs, opts as never);
      return t.serializeForModel(envelope);
    },
  });
  Object.defineProperty(aisdk, '__bernardMeta', {
    value: t.meta,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  // Stash the source BernardTool so augmentation can re-run execute and
  // inspect the raw envelope without rebuilding the adapter chain.
  Object.defineProperty(aisdk, '__bernardSource', {
    value: t,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return aisdk;
}

/**
 * Reads the source {@link BernardTool} attached to a `Tool` by
 * {@link toolToAISDK}. Returns `undefined` for legacy/MCP tools that did not
 * pass through the adapter.
 */
export function readBernardSource(t: unknown): BernardTool<unknown, unknown> | undefined {
  if (!t || typeof t !== 'object') return undefined;
  const src = (t as { __bernardSource?: unknown }).__bernardSource;
  if (
    src &&
    typeof src === 'object' &&
    typeof (src as BernardTool<unknown, unknown>).execute === 'function' &&
    typeof (src as BernardTool<unknown, unknown>).serializeForModel === 'function'
  ) {
    return src as BernardTool<unknown, unknown>;
  }
  return undefined;
}

/**
 * Lifts an existing AI-SDK `Tool` into a `BernardTool` slot so the registry
 * can hold mixed migrated/unmigrated entries without losing type safety on the
 * migrated ones. The returned `execute` wraps the legacy return in an envelope
 * by treating any thrown error as `{status: 'error', ...}` and any value as
 * `{status: 'ok', result: <value>}`. `serializeForModel` is a passthrough.
 */
export function legacyTool(t: Tool, meta: ToolMeta): BernardTool<unknown, unknown> {
  return {
    meta,
    description: typeof t.description === 'string' ? t.description : '',
    // The AI SDK's parameter shape is opaque here; cast through unknown so the
    // registry's TS slot is satisfied. Runtime behavior is unaffected.
    parameters: t.parameters as never,
    execute: async (args, opts) => {
      try {
        const value = await (t as { execute: (a: unknown, o: unknown) => unknown }).execute(
          args,
          opts,
        );
        // If the legacy tool happens to already return an envelope, pass it through.
        if (isToolResult(value)) return value as ToolResult<unknown>;
        return { status: 'ok', result: value };
      } catch (e) {
        return {
          status: 'error',
          error: {
            type: 'exec_failed',
            message: e instanceof Error ? e.message : String(e),
          },
        };
      }
    },
    serializeForModel: (r) => (r.status === 'ok' ? r.result : `Error: ${r.error.message}`),
  };
}

/**
 * Reads the metadata attached to a `Tool` by `toolToAISDK`. Returns
 * `undefined` for tools that did not pass through the adapter (legacy or MCP).
 */
export function readToolMeta(t: unknown): ToolMeta | undefined {
  if (!t || typeof t !== 'object') return undefined;
  const meta = (t as { __bernardMeta?: unknown }).__bernardMeta;
  if (
    meta &&
    typeof meta === 'object' &&
    typeof (meta as ToolMeta).name === 'string' &&
    typeof (meta as ToolMeta).kind === 'string'
  ) {
    return meta as ToolMeta;
  }
  return undefined;
}
