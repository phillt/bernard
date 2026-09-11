/**
 * @module hash
 *
 * Content digests. A pure leaf: `node:crypto` and nothing else.
 *
 * It exists because there were already two hashers in two feature modules with
 * no shared home — `hashContent` in `tools/file.ts` (16 hex chars, for the
 * declared-hash guard on a write) and `contentHash` in `knowledge/ingest.ts`
 * (full digest, over normalised text). Watcher snapshots are the third caller,
 * and importing either would drag a feature module's graph in to answer a
 * question whose only real dependency is `createHash` — the edge `tool-bytes.ts`
 * and `mcp-names.ts` exist to refuse. `fs-utils.ts:41-44` records the same
 * lesson about `atomicWriteFileSyncUnique`, which `tools/file.ts` had hand-rolled
 * before it was lifted.
 *
 * Both existing callers keep their own names and lengths; this is where a
 * fourth should come, not a migration of the first two.
 */
import { createHash } from 'node:crypto';

/**
 * Full sha256, hex.
 *
 * Full length rather than truncated: a snapshot digest is compared for
 * INEQUALITY to decide whether something changed, so a collision is a missed
 * event — the failure mode a watcher exists to prevent, and one that would be
 * invisible. Truncation is an affordance for display, and nothing here displays.
 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}
