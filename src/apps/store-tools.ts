import { tool } from 'ai';
import { z } from 'zod';
import { attachMeta } from '../framework/tools/adapter.js';
import { debugLog } from '../logger.js';
import {
  applyStoreOp,
  appletStoreFor,
  MAX_KEY_LENGTH,
  MAX_LIST_LIMIT,
  type AppletStore,
  type StoreOp,
} from './store.js';

/**
 * `applet_store`, pre-scoped to one applet (#422).
 *
 * **Bound to an `appId` at construction, never taken from an argument.** The
 * agent side of an applet's store is reached from a dispatch that is already
 * running as that app; letting the call name the app would make the store
 * ambient authority — one action reading another applet's data — which is the
 * same designation-from-the-caller mistake `bernard script` exists to close.
 * Modelled on `createScopedCronNotesTools`, which scopes to a job for exactly
 * this reason.
 *
 * Action-enum rather than four tools, matching `memory` / `scratch` / the cron
 * family, so a permission grant can key per action (`applet_store:action:set`)
 * and an "always allow" granted while reading cannot authorise a delete.
 */
const PARAMETERS = z.object({
  action: z.enum(['get', 'set', 'list', 'delete']).describe('The operation to perform'),
  key: z.string().max(MAX_KEY_LENGTH).optional().describe('Required for get / set / delete'),
  value: z.string().optional().describe('JSON text to store. Required for set.'),
  prefix: z.string().optional().describe('Only for list: restrict to keys starting with this'),
  limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional().describe('Only for list'),
  after: z.string().optional().describe('Only for list: continue after this key'),
});

type StoreArgs = z.infer<typeof PARAMETERS>;

/** True iff THIS call mutates — so a read passes the read-only block gate. */
function isWriteAction(args: unknown): boolean {
  const action = (args as StoreArgs | undefined)?.action;
  return action === 'set' || action === 'delete';
}

export function createAppletStoreTool(appId: string) {
  return attachMeta(
    tool({
      description:
        "This applet's persistent key-value store. Values are JSON text. " +
        'Data written here survives restarts and is visible to the applet page.',
      parameters: PARAMETERS,
      execute: async (args: StoreArgs): Promise<string> => {
        debugLog('applet_store:execute', { appId, action: args.action });
        try {
          // Resolved per call, from the process-wide per-app cache: building
          // the registry must not open a database for a dispatch that never
          // touches it, and a dispatch must not open a SECOND connection to a
          // file the host's HTTP route already holds — this runs inside a
          // long-lived daemon, where that leaks per invocation.
          return run(appletStoreFor(appId), args);
        } catch (err) {
          // The `Error: ` prefix is the convention `detectToolError` reads
          // (#364) — without it a failed call registers as a success.
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
    {
      name: 'applet_store',
      kind: 'write',
      deterministic: false,
      sideEffect: 'local',
      cacheable: false,
      isWriteAction,
      actionScoped: true,
      // Deliberately NOT `directInvocable`: absence is what marks a tool
      // ineligible, and stating `false` on one tool would imply absence
      // elsewhere is an oversight. The reason it is ineligible is that an
      // applet page already reaches its store through the host's own endpoint;
      // a second door whose `appId` came from a manifest would be the ambient
      // authority this tool is scoped to avoid.
    },
  );
}

/**
 * Turns the tool's validated arguments into a {@link StoreOp} and renders the
 * result for a model.
 *
 * The op vocabulary itself lives in `store.ts` and is shared with the HTTP
 * door; what stays here is the tool's own encoding — `value` arrives as JSON
 * TEXT, because a tool parameter is a scalar — and the prose the model reads.
 */
function run(store: AppletStore, args: StoreArgs): string {
  const need = (value: string | undefined, name: string): string => {
    // One zod schema cannot say "key is required, but only for three of four
    // actions", so per-action requirements are enforced here — the same reason
    // the cron family checks in its handler (#253).
    if (value === undefined)
      throw new Error(`\`${name}\` is required for action "${args.action}".`);
    return value;
  };

  const op: StoreOp =
    args.action === 'list'
      ? { op: 'list', prefix: args.prefix, limit: args.limit, after: args.after }
      : args.action === 'set'
        ? { op: 'set', key: need(args.key, 'key'), value: parseValue(need(args.value, 'value')) }
        : { op: args.action, key: need(args.key, 'key') };

  const result = applyStoreOp(store, op);
  switch (result.kind) {
    case 'entry':
      return result.entry ? JSON.stringify(result.entry) : `No value stored for "${args.key}".`;
    case 'written':
      return `Stored "${result.entry.key}" at ${result.entry.updatedAt}.`;
    case 'deleted':
      return result.deleted ? `Deleted "${args.key}".` : `No value stored for "${args.key}".`;
    case 'entries':
      return result.entries.length === 0 ? 'The store is empty.' : JSON.stringify(result.entries);
  }
}

/**
 * A bare string is a reasonable thing to want to store, and demanding the
 * model quote it correctly is a round trip for nothing.
 */
function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
