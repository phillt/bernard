/**
 * Per-turn ProvenanceStore — collects "source items" the agent can cite
 * via inline `[^S1]` markers or via the `cite` tool. Issue #173.
 *
 * Source items are populated automatically by retrieval/lookup tools
 * (web_read, web_search, file_read_lines, memory.read, scratch.read) and
 * by the Agent class for RAG hits. They are surfaced to the model both in
 * the per-turn `<available_sources>` block (see `src/context-message.ts`)
 * and inline in each tool's return string.
 *
 * Treat source content as UNTRUSTED data: never elevate `contentPreview`,
 * `label`, or `rawRef` into the SYSTEM channel — XML-escape before
 * embedding in `<system_provided_context>` per OWASP LLM01.
 */

export type SourceKind = 'tool-result' | 'web' | 'rag' | 'memory' | 'file' | 'user';

export interface SourceItem {
  /** Stable id within the current turn: `S1`, `S2`, ... */
  id: string;
  kind: SourceKind;
  /** Short human-readable label (page title, file path, memory key). */
  label: string;
  /** Truncated preview of the underlying content (≤ MAX_PREVIEW chars). */
  contentPreview: string;
  /** Pointer the user can act on: URL, file path with line range, memory key, tool-call id. */
  rawRef: string;
  /** Wall-clock when the item was added. */
  timestamp: number;
}

export type SourceItemInput = Omit<SourceItem, 'id' | 'timestamp'>;

const MAX_PREVIEW = 200;

function truncatePreview(s: string): string {
  return s.length > MAX_PREVIEW ? s.slice(0, MAX_PREVIEW) + '…' : s;
}

/**
 * Per-turn collection of cite-able sources. Created on the AgentContext and
 * cleared at the start of every `Agent.processInput` turn. Shared by
 * reference with sub-agent / tool-wrapper contexts so a `web_read` inside
 * a wrapper specialist shows up in the parent's viewer.
 */
export class ProvenanceStore {
  private items: SourceItem[] = [];
  private byRef = new Map<string, string>();
  private nextId = 1;

  /**
   * Register a source. If a previous call already registered the same
   * `kind`+`rawRef`, the existing id is returned (prevents id spam when a
   * tool re-reads the same URL). When the duplicate call carries a richer
   * preview/label — e.g. `web_search` registers a snippet, then `web_read`
   * fetches the full page — the stored item is upgraded in place so the
   * Shift+Tab viewer and `cite get` show the better detail.
   */
  add(item: SourceItemInput): string {
    const key = `${item.kind}:${item.rawRef}`;
    const preview = truncatePreview(item.contentPreview);
    const existing = this.byRef.get(key);
    if (existing) {
      const stored = this.items.find((s) => s.id === existing);
      if (stored) {
        if (preview.length > stored.contentPreview.length) {
          stored.contentPreview = preview;
        }
        if (item.label && item.label.length > stored.label.length) {
          stored.label = item.label;
        }
      }
      return existing;
    }

    const id = `S${this.nextId++}`;
    this.items.push({
      id,
      kind: item.kind,
      label: item.label,
      contentPreview: preview,
      rawRef: item.rawRef,
      timestamp: Date.now(),
    });
    this.byRef.set(key, id);
    return id;
  }

  list(): SourceItem[] {
    return [...this.items];
  }

  get(id: string): SourceItem | undefined {
    return this.items.find((s) => s.id === id);
  }

  clear(): void {
    this.items = [];
    this.byRef.clear();
    this.nextId = 1;
  }

  size(): number {
    return this.items.length;
  }
}

/**
 * Extract `[^Sn]` markers from a model response, return the deduped set of
 * referenced source ids in first-appearance order. Invalid markers
 * (referencing an id not in the store) are filtered out — callers can pass
 * a store to enforce that, or omit it to get the raw id list.
 */
export function extractCitationMarkers(text: string, store?: ProvenanceStore): string[] {
  const re = /\[\^(S\d+)\]/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const id = m[1];
    if (seen.has(id)) continue;
    if (store && !store.get(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
