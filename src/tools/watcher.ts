import { tool } from 'ai';
import { z } from 'zod';

import { attachActionMeta } from '../framework/tools/adapter.js';
import { debugLog, getSessionId } from '../logger.js';
import { WatcherStore } from '../watchers/store.js';
import { captureBaseline } from '../watchers/poller.js';
import { statFileSync, watchableToolRefusal, type ProbeDeps } from '../watchers/probe.js';
import {
  DEFAULT_INTERVAL_MS,
  MAX_LIFETIME_MS,
  MIN_INTERVAL_MS,
  describeWatchTarget,
  type WatchPredicate,
  type WatchTarget,
} from '../watchers/types.js';

/**
 * Creating and cancelling watchers (#479/#201).
 *
 * An action-enum tool, the shape `cron` / `routine` / `specialist` already use,
 * with `readActions` so `list` and `get` still pass the read-only block gate.
 *
 * ## What this tool deliberately cannot do
 *
 * A watcher's whole job is to start a turn later, so the obvious escalation is a
 * watcher that watches something it can also cause. Two things stop that, and
 * neither is a prompt instruction:
 *
 * - `watchableToolRefusal` admits only READ-classified tools, checked at create
 *   time and again on every poll. The same gate `reference-tool-lookup.ts` uses
 *   to decide what an unattended lookup may call.
 * - The `instructions` it stores are the INSTRUCTION channel. Whatever the
 *   watcher later observes travels separately as `UntrustedData`, so an email
 *   body cannot become the next turn's prompt — see `watchers/wake.ts`.
 *
 * `audience: 'main'` in the group table: a dispatched worker has no session to
 * wake, so a watcher created inside one would be orphaned at birth.
 */
const READ_ACTIONS = new Set(['list', 'get']);

type Action = 'create' | 'list' | 'get' | 'cancel';

export interface WatcherToolDeps {
  store: WatcherStore;
  probeDeps: ProbeDeps;
  /**
   * Read lazily, per create, rather than captured when the tool is built.
   *
   * Two reasons. It is only needed when a watcher is actually created, so
   * resolving it at construction makes every `createTools` call depend on the
   * session registry for a value most of them never use. And `createTools` runs
   * in suites that partially mock `logger.js`; a construction-time read turns a
   * missing mock export into a failure in tests that have nothing to do with
   * watchers, which is how an unrelated suite ends up pinned to this feature.
   */
  sessionId: () => string;
}

/** Builds the target, or an error string naming what was missing. */
function buildTarget(args: Record<string, unknown>): WatchTarget | string {
  const kind = args.targetKind as string;
  switch (kind) {
    case 'mcp': {
      if (typeof args.tool !== 'string') return 'Error: targetKind "mcp" needs `tool`.';
      let parsedArgs: Record<string, string | number | boolean> = {};
      if (typeof args.toolArgs === 'string' && args.toolArgs.trim() !== '') {
        try {
          parsedArgs = JSON.parse(args.toolArgs) as Record<string, string | number | boolean>;
        } catch {
          return 'Error: `toolArgs` must be a JSON object, e.g. {"query":"from:john is:unread"}.';
        }
      }
      return {
        kind: 'mcp',
        tool: args.tool,
        args: parsedArgs,
        ...(typeof args.extract === 'string' && args.extract ? { extract: args.extract } : {}),
      };
    }
    case 'http':
      if (typeof args.url !== 'string') return 'Error: targetKind "http" needs `url`.';
      return { kind: 'http', url: args.url };
    case 'file':
      if (typeof args.watchPath !== 'string') return 'Error: targetKind "file" needs `watchPath`.';
      return { kind: 'file', path: args.watchPath };
    case 'time':
      if (typeof args.at !== 'string') return 'Error: targetKind "time" needs `at` (ISO-8601).';
      if (Number.isNaN(Date.parse(args.at))) return `Error: could not parse \`at\`: ${args.at}`;
      return { kind: 'time', at: args.at };
    default:
      return `Error: unknown targetKind ${JSON.stringify(kind)}.`;
  }
}

function buildPredicate(args: Record<string, unknown>): WatchPredicate | string {
  // A `time` target's predicate is its own arrival; anything declared would be
  // ignored, and silently ignoring a declaration is how a user believes they
  // narrowed something they did not.
  if (args.targetKind === 'time') return { kind: 'changed' };
  const kind = (args.predicate as string) ?? 'changed';
  switch (kind) {
    case 'changed':
      return { kind: 'changed' };
    case 'appeared':
      if (typeof args.idPath !== 'string') {
        return 'Error: predicate "appeared" needs `idPath`, e.g. "$.messages.id".';
      }
      return { kind: 'appeared', idPath: args.idPath };
    case 'matches':
      if (typeof args.pattern !== 'string') {
        return 'Error: predicate "matches" needs `pattern`.';
      }
      try {
        new RegExp(args.pattern);
      } catch {
        return `Error: \`pattern\` is not a valid regular expression: ${args.pattern}`;
      }
      return { kind: 'matches', pattern: args.pattern };
    default:
      return `Error: unknown predicate ${JSON.stringify(kind)}.`;
  }
}

async function create(deps: WatcherToolDeps, args: Record<string, unknown>): Promise<string> {
  if (typeof args.name !== 'string' || !args.name.trim()) {
    return 'Error: `name` is required — a short label the user will see.';
  }
  if (typeof args.instructions !== 'string' || !args.instructions.trim()) {
    return 'Error: `instructions` is required — what to do when it fires.';
  }
  const target = buildTarget(args);
  if (typeof target === 'string') return target;
  const predicate = buildPredicate(args);
  if (typeof predicate === 'string') return predicate;

  // Refused HERE as well as on every poll. The poll-time check is what actually
  // bounds the feature (a manifest on disk is editable between runs), but a
  // refusal at creation is the only one a model can act on — the division
  // `targetToolsScopeError` already makes against `buildChildTools`.
  if (target.kind === 'mcp') {
    const refusal = watchableToolRefusal(target.tool, deps.probeDeps.tools()[target.tool]);
    if (refusal) return `Error: ${refusal}`;
  }

  // The baseline is taken NOW, before the record exists. Deferred to the first
  // poll, a `changed` watcher would compare a real digest against nothing and
  // fire immediately — every watcher would wake the moment it was created.
  const baseline = await captureBaseline(target, predicate, deps.probeDeps);
  if (!baseline.ok) {
    return `Error: could not read the target to establish a baseline — ${baseline.error}. The watcher was not created.`;
  }

  try {
    const w = deps.store.create({
      name: args.name.trim(),
      target,
      predicate,
      instructions: args.instructions.trim(),
      ownerSessionId: deps.sessionId(),
      ...(typeof args.intervalSeconds === 'number'
        ? { intervalMs: Math.max(args.intervalSeconds * 1000, MIN_INTERVAL_MS) }
        : {}),
      ...(typeof args.ttlHours === 'number'
        ? { ttlMs: Math.min(args.ttlHours * 3_600_000, MAX_LIFETIME_MS) }
        : {}),
      ...(baseline.snapshot === undefined ? {} : { snapshot: baseline.snapshot }),
      ...(baseline.baselineIds === undefined ? {} : { baselineIds: baseline.baselineIds }),
      ...(baseline.etag === undefined ? {} : { etag: baseline.etag }),
      ...(baseline.lastModified === undefined ? {} : { lastModified: baseline.lastModified }),
    });
    const every =
      target.kind === 'time'
        ? ''
        : ` Checking every ${Math.round(w.intervalMs / 1000)}s.`;
    return `Watching ${describeWatchTarget(target)} — "${w.name}" (id ${w.id}).${every} It will start a turn when it fires, then end.`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function list(deps: WatcherToolDeps): string {
  const all = deps.store.list();
  if (all.length === 0) return 'No watchers.';
  return all
    .map((w) => {
      const when = w.lastCheckedAt ? ` · last checked ${w.lastCheckedAt}` : '';
      return `${w.id} · ${w.status} · "${w.name}" · ${describeWatchTarget(w.target)}${when}`;
    })
    .join('\n');
}

function get(deps: WatcherToolDeps, args: Record<string, unknown>): string {
  if (typeof args.id !== 'string') return 'Error: `id` is required.';
  const w = deps.store.read(args.id);
  if (!w) return `Error: no watcher with id ${args.id}.`;
  return JSON.stringify(
    {
      ...w,
      // The digest is bookkeeping and says nothing a reader can use; the id set
      // can be thousands of entries.
      snapshot: w.snapshot ? '<digest>' : undefined,
      baselineIds: w.baselineIds ? `${w.baselineIds.length} ids` : undefined,
    },
    null,
    2,
  );
}

function cancel(deps: WatcherToolDeps, args: Record<string, unknown>): string {
  if (typeof args.id !== 'string') return 'Error: `id` is required.';
  const w = deps.store.read(args.id);
  if (!w) return `Error: no watcher with id ${args.id}.`;
  if (w.status !== 'active') return `Watcher "${w.name}" was already ${w.status}.`;
  deps.store.finish(args.id, 'cancelled');
  return `Cancelled "${w.name}".`;
}

/** Builds the tool. Created watchers bind to the live session. */
export function createWatcherTool(opts: {
  tools: () => Record<string, unknown>;
  sessionId?: () => string;
}) {
  const deps: WatcherToolDeps = {
    store: new WatcherStore(),
    probeDeps: { fetch: globalThis.fetch, statFile: statFileSync, tools: opts.tools },
    sessionId: opts.sessionId ?? getSessionId,
  };

  return {
    watcher: attachActionMeta(
      tool({
        description: `Watch for something to change, then react to it. A watcher polls, and when its condition is met it starts a new turn carrying your instructions — then ends. One-shot.

Actions: create · list · get · cancel

targetKind:
  mcp   — call a READ-ONLY tool and look at the result (needs \`tool\`; \`toolArgs\` is a JSON object; \`extract\` is a $. path). This is how you watch mail, messages, issues.
  http  — fetch a URL (needs \`url\`)
  file  — watch a path's mtime/size (needs \`watchPath\`)
  time  — fire at an instant (needs \`at\`, ISO-8601). Use this for "remind me in 2 hours" / "check back after the deploy".

predicate (ignored for time):
  changed  — anything differs from when the watcher was created (default)
  appeared — a NEW item shows up (needs \`idPath\`, e.g. "$.messages.id"). Use this for "when John replies" — "changed" would also fire when something is deleted.
  matches  — the result matches \`pattern\` (a regular expression)

The baseline is taken when you create it, so "changed" means "changed since now". Only read-only tools may be watched. Default interval ${DEFAULT_INTERVAL_MS / 1000}s, minimum ${MIN_INTERVAL_MS / 1000}s.`,
        parameters: z.object({
          action: z.enum(['create', 'list', 'get', 'cancel']).describe('The operation'),
          id: z.string().optional().describe('Watcher id — required by get/cancel'),
          name: z.string().optional().describe('Short label the user will see — required by create'),
          instructions: z
            .string()
            .optional()
            .describe(
              'What to do when it fires, written as an instruction to yourself. Required by create. Anything the watcher observes is passed separately as data — do not try to interpolate it here.',
            ),
          targetKind: z.enum(['mcp', 'http', 'file', 'time']).optional().describe('What to watch'),
          tool: z.string().optional().describe('Read-only tool name, for targetKind "mcp"'),
          toolArgs: z.string().optional().describe('JSON object of arguments for that tool'),
          extract: z.string().optional().describe('$. path into the result, e.g. "$.messages"'),
          url: z.string().optional().describe('URL, for targetKind "http"'),
          // NOT `path`. `meta-coverage.test.ts` requires every write-classified
          // tool with a `path` argument to be in `WRITE_PATH_TOOLS`, so that an
          // unattended run cannot write anywhere — and it is right to: a tool
          // taking `path` looks like one that writes there. This one only READS
          // it, so the honest fix is the name, not an exemption.
          watchPath: z.string().optional().describe('Absolute path, for targetKind "file"'),
          at: z.string().optional().describe('ISO-8601 instant, for targetKind "time"'),
          predicate: z.enum(['changed', 'appeared', 'matches']).optional().describe('Default changed'),
          idPath: z.string().optional().describe('$. path to item ids, for predicate "appeared"'),
          pattern: z.string().optional().describe('Regular expression, for predicate "matches"'),
          intervalSeconds: z.number().optional().describe('How often to check'),
          ttlHours: z.number().optional().describe('Give up after this long'),
        }),
        execute: async (args): Promise<string> => {
          debugLog('watcher:execute', { action: args.action, targetKind: args.targetKind });
          const a = args as unknown as Record<string, unknown>;
          switch (args.action as Action) {
            case 'create':
              return create(deps, a);
            case 'list':
              return list(deps);
            case 'get':
              return get(deps, a);
            case 'cancel':
              return cancel(deps, a);
            default:
              // A direct `execute` bypasses zod, so an unknown action must not
              // fall through as `undefined` — which `detectResultFailure` reads
              // as success.
              return `Error: unknown action ${JSON.stringify(args.action)}.`;
          }
        },
      }),
      { name: 'watcher', readActions: READ_ACTIONS },
    ),
  };
}
