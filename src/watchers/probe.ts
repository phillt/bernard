/**
 * @module watchers/probe
 *
 * Looking once at whatever a watcher watches. **No model is involved.**
 *
 * That is the economic premise of the whole feature: a 60 s watcher polls 1,440
 * times a day, and dispatching an agent to answer "nothing changed" is the shape
 * this must not take — `CronJob.prompt` runs a full agent per fire, which was
 * measured at ~49k prompt tokens. A probe is a fetch, a `stat`, or one tool
 * call. The agent runs only once, when the predicate actually fires.
 *
 * Every dependency is injected — `fetch`, the filesystem, the tool registry —
 * the idiom `voice-service.ts` uses for the same reason: otherwise the tests
 * need a network, a real MCP server, and a built `dist/`.
 */
// Named import, not `import fs from 'node:fs'`. Several suites replace
// `node:fs` with a partial mock of named functions and no `default` export, and
// a default import fails at MODULE LOAD against those — taking down suites that
// have nothing to do with watchers.
import { statSync } from 'node:fs';

import { readToolMeta } from '../framework/tools/adapter.js';
import { isReadOnlyMCPSuffix } from '../risk.js';
import { MAX_OBSERVATION_BYTES, type WatchTarget } from './types.js';
import type { Observation } from './evaluate.js';

/**
 * The production `statFile`, kept here rather than at the call site so the UI
 * layer does not acquire a `node:fs` import to describe a probe it does not
 * perform. Injected in tests; this is simply the default.
 */
export function statFileSync(p: string): { mtimeMs: number; size: number } | null {
  try {
    const st = statSync(p);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    // Absent, unreadable, or a path we may not traverse. All three are
    // "nothing to see", which `probeFile` turns into an observation rather than
    // a failure — see there for why that distinction matters.
    return null;
  }
}

/** Hard cap on one probe, so a hung server cannot wedge the poll loop. */
export const PROBE_TIMEOUT_MS = 10_000;

/** Everything the probe reaches the world through. */
export interface ProbeDeps {
  fetch: typeof fetch;
  statFile: (p: string) => { mtimeMs: number; size: number } | null;
  /** The live tool registry, re-taken per poll — never a cached bag. */
  tools: () => Record<string, unknown>;
}

export type ProbeResult = { ok: true; observation: Observation } | { ok: false; error: string };

/**
 * Whether a watcher may name this tool.
 *
 * Read-classified only. A watcher runs unattended and repeatedly, so a write
 * target would be a way to make something happen 1,440 times a day with nobody
 * looking. `isReadOnlyMCPSuffix` is the same gate `reference-tool-lookup.ts`
 * uses to decide what an unattended lookup may call, and reusing it means there
 * is one answer to "what is safe to call without a person" rather than two that
 * can drift.
 *
 * Returns a refusal string, or `null` when allowed — `directInvocableRefusal`'s
 * shape, so a caller reports WHY rather than a bare boolean.
 */
export function watchableToolRefusal(
  toolName: string,
  tool: unknown,
  available?: Record<string, unknown>,
): string | null {
  if (!tool) {
    // Name what IS watchable. A bare "not available" leaves a model guessing at
    // a namespaced key it cannot enumerate — observed once as a fallback to a
    // blind `time` watcher, which polls a clock instead of the thing asked
    // about. Suggestions are filtered to read-only, so nothing offered here can
    // then be refused by the very next check.
    const near = available ? suggestions(toolName, available) : [];
    const hint = near.length
      ? ` Watchable tools with a similar name: ${near.join(', ')}.`
      : ' Note a watcher needs the real tool name (e.g. `server_ab12__list_messages`), not a `delegate_<server>` tool.';
    return `No tool named "${toolName}" is available in this session.${hint}`;
  }
  const meta = readToolMeta(tool);
  // A built-in declares its own kind; an MCP tool is classified from its suffix
  // by `mcp.ts`, which sets `kind: 'read'` for the `*_list` / `*_search` /
  // `*_get` family. Accept either statement of the same fact.
  const declaredRead = meta?.kind === 'read';
  if (!declaredRead && !isReadOnlyMCPSuffix(meta?.rawName ?? toolName)) {
    return `Tool "${toolName}" is not a read-only tool, so a watcher cannot poll it.`;
  }
  if (typeof (tool as { execute?: unknown }).execute !== 'function') {
    return `Tool "${toolName}" cannot be invoked directly.`;
  }
  return null;
}

/**
 * Up to five watchable tools whose names look like what was asked for.
 *
 * Matched on the SEGMENTS of a namespaced key — `beeper_ab12__list_messages`
 * shares `beeper` and `messages` with `beeper_ab12__read_messages` — because the
 * usual near-miss is the right server and the wrong verb, which a whole-string
 * distance would score as far apart.
 */
function suggestions(wanted: string, available: Record<string, unknown>): string[] {
  const parts = new Set(
    wanted
      .toLowerCase()
      .split(/[_\W]+/)
      .filter((p) => p.length > 2),
  );
  if (parts.size === 0) return [];
  const scored: { name: string; score: number }[] = [];
  for (const [name, tool] of Object.entries(available)) {
    if (watchableToolRefusal(name, tool) !== null) continue;
    const theirs = name.toLowerCase().split(/[_\W]+/);
    const score = theirs.filter((p) => parts.has(p)).length;
    if (score > 0) scored.push({ name, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 5)
    .map((s) => s.name);
}

/** Looks once. Never throws; a failure is a value the caller counts. */
/** Carried-forward state a probe can use to ask a cheaper question. */
export interface ProbeContext {
  signal?: AbortSignal;
  /** From the last poll, so an HTTP probe can send a conditional request. */
  etag?: string;
  lastModified?: string;
}

export async function probe(
  target: WatchTarget,
  deps: ProbeDeps,
  ctx: ProbeContext = {},
): Promise<ProbeResult> {
  switch (target.kind) {
    // Nothing to look at: `isDue` is the whole predicate, and `evaluate` fires
    // on arrival. Probing here would be a call with no question.
    case 'time':
      return { ok: true, observation: { value: null } };
    case 'file':
      return probeFile(target.path, deps);
    case 'http':
      return probeHttp(target, deps, ctx);
    case 'mcp':
      return probeMcp(target, deps, ctx);
  }
}

function probeFile(p: string, deps: ProbeDeps): ProbeResult {
  const st = deps.statFile(p);
  // Absence is an OBSERVATION, not an error — "tell me when this file appears"
  // is a real thing to want, and reporting it as a failure would tick the
  // failure counter until the watcher gave up waiting for the thing it was
  // watching for.
  if (!st) return { ok: true, observation: { value: { exists: false } } };
  return { ok: true, observation: { value: { exists: true, mtimeMs: st.mtimeMs, size: st.size } } };
}

async function probeHttp(
  target: Extract<WatchTarget, { kind: 'http' }>,
  deps: ProbeDeps,
  ctx: ProbeContext,
): Promise<ProbeResult> {
  try {
    const res = await deps.fetch(target.url, {
      // Conditional request: when the server honours it a `304` costs no body
      // and answers the question outright. A `304` is safe to act on because
      // acting costs nothing — but a `200` is NOT proof of change, which is why
      // the body is still digested by `evaluate`.
      //
      // `If-None-Match` wins over `If-Modified-Since` when a server sees both,
      // an entity tag being the stronger signal, so sending both is free.
      headers: conditionalHeaders(ctx),
      signal: ctx.signal,
      redirect: 'follow',
    });
    if (res.status === 304) {
      return { ok: true, observation: { value: null, unchanged: true } };
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.text();
    return {
      ok: true,
      observation: {
        value: body.slice(0, MAX_OBSERVATION_BYTES * 4),
        etag: res.headers.get('etag') ?? undefined,
        lastModified: res.headers.get('last-modified') ?? undefined,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function conditionalHeaders(ctx: ProbeContext): Record<string, string> {
  const headers: Record<string, string> = {};
  if (ctx.etag) headers['if-none-match'] = ctx.etag;
  if (ctx.lastModified) headers['if-modified-since'] = ctx.lastModified;
  return headers;
}

async function probeMcp(
  target: Extract<WatchTarget, { kind: 'mcp' }>,
  deps: ProbeDeps,
  ctx: ProbeContext,
): Promise<ProbeResult> {
  const registry = deps.tools();
  const tool = registry[target.tool];
  const refusal = watchableToolRefusal(target.tool, tool, registry);
  if (refusal) return { ok: false, error: refusal };

  const execute = (tool as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute;
  try {
    // A hard race, not just the signal: many MCP tools ignore `abortSignal`
    // entirely, which is the reason `reference-tool-lookup.ts` wraps its own
    // call the same way. Without it one unresponsive server stalls every other
    // watcher behind it.
    const result = await Promise.race([
      execute(target.args, {
        toolCallId: `watch-${Date.now()}`,
        messages: [],
        abortSignal: ctx.signal,
      }),
      new Promise<never>((_r, reject) =>
        setTimeout(() => reject(new Error('probe timed out')), PROBE_TIMEOUT_MS).unref?.(),
      ),
    ]);
    return { ok: true, observation: { value: unwrap(result) } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Unwraps the `CallToolResult` envelope so a path like `$.messages.id` means
 * what its author expects.
 *
 * An MCP result is `{content: [{type:'text', text:'<json>'}]}` — the payload is
 * JSON encoded as a STRING inside the envelope, so without this every watcher
 * path would have to start `$.content[0].text` and then could not traverse into
 * it at all. The same shape `mcp-result-shaper.ts` had to learn to unwrap (#458)
 * after a Gmail read silently lost its `Cc` header to a front-slice.
 *
 * Only a single text entry is unwrapped: several entries are several values, and
 * choosing between them is not this module's call.
 */
function unwrap(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length !== 1) return result;
  const only = content[0] as { type?: unknown; text?: unknown };
  if (only?.type !== 'text' || typeof only.text !== 'string') return result;
  try {
    return JSON.parse(only.text);
  } catch {
    // Plenty of servers return prose. That is a legitimate value to watch.
    return only.text;
  }
}
