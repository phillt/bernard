import type { Tool } from 'ai';
import type { BernardTool, ToolMeta } from './types.js';
import { toolToAISDK } from './adapter.js';

/**
 * Typed registry that holds `BernardTool` entries (native + legacy + MCP via
 * `legacyTool` / `wrapMCPTool`) and exposes capability filtering. Call sites
 * that still expect the AI-SDK shape get it back via `toAISDKRecord()`.
 */
export class ToolRegistry {
  private readonly tools: Map<string, BernardTool<unknown, unknown>>;

  constructor(entries: Iterable<BernardTool<unknown, unknown>> = []) {
    this.tools = new Map();
    for (const t of entries) this.tools.set(t.meta.name, t);
  }

  /** Adds or replaces an entry by `meta.name`. */
  add(t: BernardTool<unknown, unknown>): this {
    this.tools.set(t.meta.name, t);
    return this;
  }

  get(name: string): BernardTool<unknown, unknown> | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  all(): BernardTool<unknown, unknown>[] {
    return Array.from(this.tools.values());
  }

  /**
   * Returns every tool whose `meta` matches all keys in `filter`. Undefined
   * filter values are ignored. Useful for capability gates like
   * `byMetadata({kind: 'read'})`.
   */
  byMetadata(filter: Partial<ToolMeta>): BernardTool<unknown, unknown>[] {
    const entries = Object.entries(filter).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return this.all();
    return this.all().filter((t) =>
      entries.every(
        ([key, expected]) => (t.meta as unknown as Record<string, unknown>)[key] === expected,
      ),
    );
  }

  /** Converts the registry into the `Record<string, Tool>` shape the AI SDK expects. */
  toAISDKRecord(): Record<string, Tool> {
    const out: Record<string, Tool> = {};
    for (const t of this.tools.values()) {
      out[t.meta.name] = toolToAISDK(t);
    }
    return out;
  }
}
