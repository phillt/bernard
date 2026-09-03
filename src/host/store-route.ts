import { AppletStore } from '../apps/store.js';

/**
 * The applet page's door onto its own key-value store (#422).
 *
 * A tiny, closed request vocabulary — `get` / `set` / `list` / `delete`, with
 * a key and a JSON value — and not one byte of it is interpretable. That is
 * the same reason the store is key-value rather than SQL: the caller here is a
 * browser page, and handing it a query language would re-open exactly what the
 * action-selector design closed.
 *
 * The `appId` is supplied by the server's own closure. It is never read from
 * the request, so a page cannot name another applet's store.
 *
 * Connections are cached per app for the life of the host process. SQLite
 * connections are cheap but not free, and opening one per request under WAL is
 * how a busy page finds `SQLITE_BUSY` — the failure the busy timeout exists to
 * absorb, not one to manufacture.
 */
const connections = new Map<string, AppletStore>();

function storeFor(appId: string): AppletStore {
  let store = connections.get(appId);
  if (!store) {
    store = new AppletStore(appId);
    connections.set(appId, store);
  }
  return store;
}

/** Drops an app's connection — called when the host stops serving it. */
export function closeAppletStore(appId: string): void {
  const store = connections.get(appId);
  if (!store) return;
  connections.delete(appId);
  try {
    store.close();
  } catch {
    // Already closed, or the file went away. Nothing left to do.
  }
}

export type StoreResponse = { ok: true; result: unknown } | { ok: false; error: string };

export function handleStoreRequest(appId: string, body: unknown): StoreResponse {
  const req = (body ?? {}) as Record<string, unknown>;
  const op = req.op;
  try {
    const store = storeFor(appId);
    switch (op) {
      case 'get': {
        const key = requireString(req.key, 'key');
        return { ok: true, result: store.get(key) };
      }
      case 'set': {
        const key = requireString(req.key, 'key');
        // `value` is whatever JSON the page sent, stored as-is. It is never
        // parsed as anything but JSON and never reaches a tool.
        return { ok: true, result: store.set(key, req.value ?? null) };
      }
      case 'delete': {
        const key = requireString(req.key, 'key');
        return { ok: true, result: { deleted: store.delete(key) } };
      }
      case 'list': {
        return {
          ok: true,
          result: store.list({
            ...(typeof req.prefix === 'string' ? { prefix: req.prefix } : {}),
            ...(typeof req.limit === 'number' ? { limit: req.limit } : {}),
            ...(typeof req.after === 'string' ? { after: req.after } : {}),
          }),
        };
      }
      default:
        return { ok: false, error: `Unknown op: ${String(op)}. Use get, set, list or delete.` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`\`${name}\` must be a string.`);
  return value;
}
