import type { AgentDefinition } from './types.js';

/**
 * Registry of {@link AgentDefinition}s keyed by their stable `id`. Populated at
 * startup by `src/framework/agents/index.ts`, which imports each definition
 * module and calls {@link DefinitionRegistry.register}.
 *
 * Entries are kind-level (`'main'`, `'sub'`, `'specialist'`, `'task'`,
 * `'tool-wrapper'`, `'cron'`) — per-instance variation flows through the
 * definition's `TInput`, not through more registry entries. Correction is not
 * a registered kind; it runs through `tool_wrapper_run` against the bundled
 * `correction-agent` specialist.
 */
export class DefinitionRegistry {
  private readonly entries = new Map<string, AgentDefinition<any, any>>();

  register<TInput, TFormatted>(def: AgentDefinition<TInput, TFormatted>): void {
    if (this.entries.has(def.id)) {
      throw new Error(`AgentDefinition '${def.id}' already registered`);
    }
    this.entries.set(def.id, def as AgentDefinition<any, any>);
  }

  get<TInput = unknown, TFormatted = unknown>(id: string): AgentDefinition<TInput, TFormatted> {
    const def = this.entries.get(id);
    if (!def) {
      throw new Error(
        `AgentDefinition '${id}' not found. Registered: ${[...this.entries.keys()].join(', ') || '(none)'}`,
      );
    }
    return def as AgentDefinition<TInput, TFormatted>;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  /** @internal Test helper. */
  _clear(): void {
    this.entries.clear();
  }
}

/** Process-wide singleton consumed by {@link runDefinition} and dispatch tools. */
export const definitions = new DefinitionRegistry();
