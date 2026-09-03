import { tool } from 'ai';
import { z } from 'zod';
import { attachMeta } from '../framework/tools/adapter.js';
import { debugLog } from '../logger.js';
import { AppletStore, MAX_KEY_LENGTH, MAX_LIST_LIMIT } from './store.js';

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

export function createAppletStoreTool(appId: string, store?: AppletStore) {
  // Constructed lazily so building the registry does not open a database for a
  // dispatch that never touches it — the same reason `runHeadless` builds a
  // RAG store only when a query was supplied.
  let db = store ?? null;
  const open = (): AppletStore => (db ??= new AppletStore(appId));

  return attachMeta(
    tool({
      description:
        "This applet's persistent key-value store. Values are JSON text. " +
        'Data written here survives restarts and is visible to the applet page.',
      parameters: PARAMETERS,
      execute: async (args: StoreArgs): Promise<string> => {
        debugLog('applet_store:execute', { appId, action: args.action });
        try {
          return run(open(), args);
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
      // An applet page reaches this through the host's own endpoint, not
      // through a manifest tool action: the page already has a store door, and
      // a second one whose `appId` came from a manifest would be the ambient
      // authority this tool is scoped to avoid.
      directInvocable: false,
    },
  );
}

function run(store: AppletStore, args: StoreArgs): string {
  switch (args.action) {
    case 'get': {
      const key = require_(args.key, 'key', 'get');
      const entry = store.get(key);
      return entry ? JSON.stringify(entry) : `No value stored for "${key}".`;
    }
    case 'set': {
      const key = require_(args.key, 'key', 'set');
      const raw = require_(args.value, 'value', 'set');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // A bare string is a reasonable thing to want to store, and demanding
        // the model quote it correctly is a round trip for nothing.
        parsed = raw;
      }
      const entry = store.set(key, parsed);
      return `Stored "${entry.key}" at ${entry.updatedAt}.`;
    }
    case 'delete': {
      const key = require_(args.key, 'key', 'delete');
      return store.delete(key) ? `Deleted "${key}".` : `No value stored for "${key}".`;
    }
    case 'list': {
      const entries = store.list({
        ...(args.prefix !== undefined ? { prefix: args.prefix } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.after !== undefined ? { after: args.after } : {}),
      });
      return entries.length === 0 ? 'The store is empty.' : JSON.stringify(entries);
    }
  }
}

/**
 * Per-action argument requirements, enforced here rather than in the schema.
 *
 * One zod schema cannot say "key is required, but only for three of four
 * actions" — the same reason the cron family checks in its handler (#253).
 */
function require_(value: string | undefined, name: string, action: string): string {
  if (value === undefined) throw new Error(`\`${name}\` is required for action "${action}".`);
  return value;
}
