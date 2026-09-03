import { CAPABILITY_LOG_FILE } from '../paths.js';
import { appendJsonl, rotateJsonlByCount } from '../jsonl.js';
import type { CapabilityRecord } from './capabilities.js';

/**
 * The mint half of the applet audit trail (#420 R9).
 *
 * Written here rather than in `CapabilityTable` so that module stays a
 * `node:crypto`-only leaf; the table takes a `MintObserver` and this is the
 * one the host passes.
 *
 * Correlated with `SCRIPT_LOG_FILE`'s invocation rows on `capabilityId`, which
 * `invokeAction` already carries — the field was written as an always-null
 * placeholder in #419 exactly so this would be a value fill rather than a
 * schema migration.
 */

/** Its own budget, since it is its own file — see `CAPABILITY_LOG_FILE`. */
const CAPABILITY_LOG_KEEP = 2000;

export function recordCapabilityMint(record: CapabilityRecord): void {
  try {
    appendJsonl(CAPABILITY_LOG_FILE, {
      event: 'capability:mint',
      at: new Date().toISOString(),
      // The record's own non-secret id, never a slice of the handle: the
      // handle is a live credential and part of one on disk is still part of
      // one.
      capabilityId: record.id,
      appId: record.appId,
      action: record.action,
      sessionId: record.sessionId,
      expiresAt: new Date(record.expiresAt).toISOString(),
      // `Infinity` does not survive JSON — it serialises as `null`, which
      // reads as "unknown" rather than "unlimited".
      uses: Number.isFinite(record.usesRemaining) ? record.usesRemaining : 'unlimited',
      // Keys only, never values, exactly as the invocation log does: a frozen
      // handle's values are the caller's data.
      frozenArgKeys: record.frozenArgs ? Object.keys(record.frozenArgs) : [],
    });
    rotateJsonlByCount(CAPABILITY_LOG_FILE, CAPABILITY_LOG_KEEP);
  } catch {
    // The audit trail must never take down the mint it is recording.
  }
}
