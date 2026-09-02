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
  /**
   * Wall-clock when Bernard RETRIEVED this — not when the content was written
   * or published. Always present, because it is a fact about our own fetch.
   *
   * Kept distinct from {@link SourceItem.publishedAt} on purpose: conflating
   * "when we looked" with "how old this is" is the mistake that makes a
   * decade-old page look fresh.
   */
  timestamp: number;
  /**
   * When the underlying content was published or last modified, as reported by
   * the source itself, or `undefined` when unknown.
   *
   * Unknown is a real and common answer — treat it as such rather than falling
   * back to {@link SourceItem.timestamp}. A missing date is a known gap; a
   * retrieval time presented as a publication date is a wrong answer.
   */
  publishedAt?: string;
  /**
   * The retrieved text in full, for checking a quoted span against its source.
   *
   * **Deliberately separate from {@link SourceItem.contentPreview}, and never
   * rendered into the context message.** `contentPreview` is capped at
   * {@link MAX_PREVIEW} precisely because `<available_sources>` re-sends every
   * source's preview to the model on every turn; raising that cap would
   * multiply per-turn context cost across every source in the store.
   *
   * Without this field a containment check is not merely expensive but
   * impossible: `web_read` returns up to 20,000 characters, history keeps
   * 10,000, and the only copy addressable by source id was the 2,000-character
   * preview — so a quote from the middle of a page could not be checked against
   * anything Bernard still held, and would read as fabricated.
   *
   * Capped at {@link MAX_VERIFY_TEXT} so one enormous page cannot dominate the
   * store, and undefined for sources whose full text is not retained.
   */
  verifyText?: string;
}

/**
 * What a caller may supply. `id` and `timestamp` are minted by the store —
 * `publishedAt` and `verifyText` are not, because only the retrieving tool
 * knows them.
 */
export type SourceItemInput = Omit<SourceItem, 'id' | 'timestamp'>;

/**
 * Snapshot of one completed turn's provenance, for the Shift+Tab citation
 * history view. Persisted alongside conversation history. Issue #211.
 */
export interface TurnProvenance {
  /** Monotonic index within the conversation (0-based). */
  turnIndex: number;
  /** Raw user input that started this turn. Trimmed for display. */
  userInput: string;
  /** Every source registered during the turn. */
  sources: SourceItem[];
  /** Subset of `sources[].id` that the model actually cited with `[^Sn]`. */
  citedIds: string[];
  /** Wall-clock epoch ms at end of turn. */
  timestamp: number;
}

// Kept generous so the Shift+Tab Sources viewer can show a substantial,
// human-readable excerpt in its right-hand content panel (issue #211 redesign).
// The dedup/upgrade path in `add()` replaces a shorter stored preview with a
// longer one, so raising this only ever retains MORE of what tools already pass.
const MAX_PREVIEW = 2000;

/**
 * Cap on {@link SourceItem.verifyText}. Sized to hold a whole `web_read`
 * return (`MAX_OUTPUT_CHARS`, 20,000) so the text a quote could have come from
 * is the same text a check runs against — a smaller cap would reintroduce the
 * gap this field exists to close, just further down the page.
 *
 * This never enters the context message, so it costs memory rather than
 * tokens.
 */
const MAX_VERIFY_TEXT = 20_000;

function truncateVerifyText(s: string | undefined): string | undefined {
  if (!s) return undefined;
  return s.length > MAX_VERIFY_TEXT ? s.slice(0, MAX_VERIFY_TEXT) : s;
}

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
        // A later registration may know the date when the first did not — a
        // `web_search` snippet upgraded by a `web_read` of the same URL is the
        // common case. Never overwrite a known date with an unknown one.
        if (item.publishedAt && !stored.publishedAt) {
          stored.publishedAt = item.publishedAt;
        }
        // Same upgrade rule: a `web_read` of a URL a `web_search` already
        // registered brings the full text the snippet never had.
        const incoming = truncateVerifyText(item.verifyText);
        if (incoming && incoming.length > (stored.verifyText?.length ?? 0)) {
          stored.verifyText = incoming;
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
      ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
      ...(item.verifyText ? { verifyText: truncateVerifyText(item.verifyText) } : {}),
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
