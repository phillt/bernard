/**
 * Refresh the vendored model-catalog fallback by hitting the Vercel AI Gateway
 * models endpoint, filtering to the three built-in provider namespaces, and
 * writing the trimmed snapshot to `src/data/model-catalog-fallback.json`.
 *
 * Run manually before shipping a release so brand-new machines (offline, no
 * disk cache yet) start with a reasonably current model list.
 *
 *   npm run refresh-catalog
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { resolveGatewayOwner } from '../src/providers/types.js';

const GATEWAY_URL = 'https://ai-gateway.vercel.sh/v1/models';
const FALLBACK_PATH = path.join('src', 'data', 'model-catalog-fallback.json');

interface RawModel {
  id: string;
  type?: string;
  [key: string]: unknown;
}

interface RawResponse {
  object: string;
  data: RawModel[];
}

async function main(): Promise<void> {
  const resp = await fetch(GATEWAY_URL);
  if (!resp.ok) {
    throw new Error(`Gateway returned HTTP ${resp.status}`);
  }
  const payload = (await resp.json()) as RawResponse;
  if (!payload || !Array.isArray(payload.data)) {
    throw new Error('Gateway response missing data array.');
  }
  const filtered = payload.data.filter((entry) => {
    if (typeof entry.id !== 'string') return false;
    if (entry.type && entry.type !== 'language') return false;
    const slash = entry.id.indexOf('/');
    if (slash < 0) return false;
    const owner = entry.id.slice(0, slash);
    // Share the runtime's owner resolution so an upstream rename (e.g. the
    // gateway's `xai` → `spacexai`) can't strip a whole provider from the
    // vendored snapshot while the parser still accepts it.
    return resolveGatewayOwner(owner) !== null;
  });
  const snapshot = {
    object: 'list',
    fetchedAt: Math.floor(Date.now() / 1000),
    data: filtered,
  };
  await fs.writeFile(FALLBACK_PATH, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
  process.stdout.write(`Wrote ${filtered.length} entries to ${FALLBACK_PATH}\n`);
}

main().catch((err) => {
  process.stderr.write(`refresh-catalog failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
