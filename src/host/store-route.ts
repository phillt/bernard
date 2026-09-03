import { applyStoreOp, appletStoreFor, type StoreOp } from '../apps/store.js';

export { closeAllAppletStores, closeAppletStore } from '../apps/store.js';

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
 * The connection comes from `appletStoreFor`, the one per-app cache the
 * `applet_store` tool also uses. Opening one per request — or one per agent
 * dispatch — under WAL is how a busy page finds `SQLITE_BUSY`, the failure the
 * busy timeout exists to absorb rather than to manufacture.
 */
export type StoreResponse = { ok: true; result: unknown } | { ok: false; error: string };

/**
 * Turns a request body into a {@link StoreOp} and answers with JSON.
 *
 * The op vocabulary lives in `src/apps/store.ts` and is shared with the
 * `applet_store` tool; what stays here is this door's own encoding — `value`
 * arrives as an already-decoded JSON value, where the tool receives JSON text.
 */
export function handleStoreRequest(appId: string, body: unknown): StoreResponse {
  const req = (body ?? {}) as Record<string, unknown>;
  try {
    const op = parseStoreOp(req);
    const result = applyStoreOp(appletStoreFor(appId), op);
    // Unwrapped to the shape the page's JavaScript reads: an entry, a list, or
    // a `{deleted}` flag.
    switch (result.kind) {
      case 'entry':
        return { ok: true, result: result.entry };
      case 'written':
        return { ok: true, result: result.entry };
      case 'deleted':
        return { ok: true, result: { deleted: result.deleted } };
      case 'entries':
        return { ok: true, result: result.entries };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function parseStoreOp(req: Record<string, unknown>): StoreOp {
  switch (req.op) {
    case 'get':
    case 'delete':
      return { op: req.op, key: requireString(req.key, 'key') };
    case 'set':
      // Stored as-is. It is never parsed as anything but JSON and never
      // reaches a tool.
      return { op: 'set', key: requireString(req.key, 'key'), value: req.value ?? null };
    case 'list':
      return {
        op: 'list',
        ...(typeof req.prefix === 'string' ? { prefix: req.prefix } : {}),
        ...(typeof req.limit === 'number' ? { limit: req.limit } : {}),
        ...(typeof req.after === 'string' ? { after: req.after } : {}),
      };
    default:
      throw new Error(`Unknown op: ${String(req.op)}. Use get, set, list or delete.`);
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`\`${name}\` must be a string.`);
  return value;
}
