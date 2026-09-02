import { describe, it, expect } from 'vitest';
import { createTools } from '../tools/index.js';
import { ProvenanceStore } from '../provenance.js';
import record from './research-agent.json' with { type: 'json' };

// The bundled manifest is copied byte-for-byte at seed time — `createFull` is
// not on that path, so nothing validates these records at runtime. These are
// the checks that would otherwise only fail as silent misbehaviour.
describe('research-agent bundled record', () => {
  it('has an id matching its filename', () => {
    // `get(id)` reads `<id>.json` and `roleOf` derives ids from filenames, so a
    // mismatch makes the record unreachable AND unprotected.
    expect(record.id).toBe('research-agent');
  });

  it('names only tools that actually resolve', () => {
    // An unresolvable name is dropped with only a debugLog, so a typo yields a
    // quietly under-equipped specialist rather than an error.
    // `cite` is only constructed when a provenance store is supplied — the
    // 8th positional argument — which is what the wrapper dispatch passes.
    const registry = createTools(
      {} as any, // options
      {} as any, // memoryStore
      undefined, // mcpTools
      undefined, // routineStore
      undefined, // specialistStore
      undefined, // candidateStore
      undefined, // config
      new ProvenanceStore(),
      { surface: 'full' },
    );
    for (const name of record.targetTools) {
      expect(Object.keys(registry)).toContain(name);
    }
  });

  it('leads with the tool its failures should be classified against', () => {
    // `targetTools[0]` is what reaches `classifyError` on the correction path.
    expect(record.targetTools[0]).toBe('web_search');
  });

  it('declares structured output, which its result shape depends on', () => {
    expect(record.kind).toBe('tool-wrapper');
    expect(record.structuredOutput).toBe(true);
  });

  it('can cite, which is what gates the citation conventions', () => {
    expect(record.targetTools).toContain('cite');
  });
});
