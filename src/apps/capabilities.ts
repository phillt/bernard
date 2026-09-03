import * as crypto from 'node:crypto';

/**
 * The capability table behind applet callbacks (#420).
 *
 * An applet button carries an **opaque handle to a pre-minted capability**,
 * never a string the agent interprets. `{appId, action, args}` against a
 * closed registry is the Action-Selector Pattern (arXiv:2506.08837), which
 * OWASP LLM06:2025 recommends directly: a free-form string crosses the
 * boundary as *instruction*, interpreted by a model holding the user's tool
 * authority — Hardy's confused deputy, attacker supplying the designation and
 * the agent supplying the authority. A named action crosses as *data*.
 *
 * **In-memory, and a random handle rather than macaroons.** Cryptographic
 * attenuation buys *decentralised* attenuation across trust boundaries; in one
 * process the minter, attenuator and verifier are the same code, so a CSPRNG
 * handle keyed to a server-side record has the identical property without a
 * class of caveat-parsing bugs. Per MCP's guidance the rule that matters is
 * binding, not secrecy: servers "MUST NOT treat possession of a state handle
 * as authentication".
 *
 * **An instance, not a module-level `Map`.** The two existing TTL tables
 * (`framework/tools/result-cache.ts`, `llm-cache.ts`) are module-level consts,
 * which is right for a cache and wrong here: revocation and per-app clearing
 * on a manifest change both need a handle to the table, and a server may hold
 * more than one.
 */

/** How long a minted handle stays usable. */
export const DEFAULT_CAPABILITY_TTL_MS = 60 * 60_000;

export interface CapabilityRecord {
  /**
   * A short, non-secret identifier for logging.
   *
   * Separate from the handle because the handle is a live credential: slicing
   * it for a log line writes part of an unexpired secret to disk, which is
   * what the first cut did (`handle.slice(0, 8)` at the call site). Identity
   * belongs to the capability, not to a consumer's substring.
   */
  id: string;
  appId: string;
  action: string;
  /** Present only for `frozen` handles. */
  frozenArgs?: Readonly<Record<string, string | number | boolean>>;
  /** The session this handle was issued to; a handle is bound, not bearer. */
  sessionId: string;
  expiresAt: number;
  usesRemaining: number;
}

export type ResolveFailure =
  | 'unknown_handle'
  | 'expired'
  | 'exhausted'
  | 'wrong_app'
  | 'wrong_session';

export type CapabilityResolution =
  | { ok: true; record: CapabilityRecord }
  | { ok: false; reason: ResolveFailure };

export interface MintOptions {
  appId: string;
  action: string;
  sessionId: string;
  frozenArgs?: Readonly<Record<string, string | number | boolean>>;
  ttlMs?: number;
  /** `Infinity` for a reusable action handle; `1` for a confirmed one-shot. */
  uses?: number;
}

/** What a caller must prove it is when redeeming a handle. */
export interface RedeemContext {
  appId: string;
  sessionId: string;
}

export class CapabilityTable {
  private readonly entries = new Map<string, CapabilityRecord>();
  /** `appId\0action\0sessionId` → the live reusable handle for it. */
  private readonly designations = new Map<string, string>();

  /**
   * Mints a handle. The returned string **encodes nothing** — no app id, no
   * action, no scope — so there is nothing in it to forge or to tamper with.
   * All authority lives in the record.
   */
  mint(opts: MintOptions): string {
    const handle = crypto.randomBytes(32).toString('base64url');
    this.entries.set(handle, {
      id: crypto.randomBytes(6).toString('hex'),
      appId: opts.appId,
      action: opts.action,
      frozenArgs: opts.frozenArgs,
      sessionId: opts.sessionId,
      expiresAt: Date.now() + (opts.ttlMs ?? DEFAULT_CAPABILITY_TTL_MS),
      usesRemaining: opts.uses ?? Number.POSITIVE_INFINITY,
    });
    return handle;
  }

  /**
   * The reusable handle for one `(appId, action, sessionId)` designation,
   * minting it only the first time.
   *
   * **This is a bound on the table, not a convenience.** All three parts of the
   * designation are fixed for the life of the host process, so a fresh handle
   * per page load bought nothing and cost everything: `bootstrap.json` is a
   * `GET`, which the guard does not gate on the token, so anything that can
   * open the port could mint — one entry per declared action per fetch. And
   * they were unreachable-but-live: `usesRemaining` starts at `Infinity`, and
   * `Infinity - 1` is `Infinity`, so use never evicts them, while the TTL check
   * is lazy and only runs when that exact handle is presented — which an
   * abandoned handle never is. Measured at ~2.2 GB/h for a one-action applet
   * and ~11 GB/h for five, unbounded until the process exits. On the
   * login-started service #428 builds, that is a memory-exhaustion DoS
   * reachable by anything local.
   *
   * Reuse keeps the table at O(apps × actions). Every binding property is
   * unchanged: the handle is still opaque and unforgeable, and is still checked
   * against `appId` and `sessionId` at redeem.
   */
  handleFor(appId: string, action: string, sessionId: string): string {
    const key = `${appId}\u0000${action}\u0000${sessionId}`;
    const existing = this.designations.get(key);
    if (existing) {
      const record = this.entries.get(existing);
      // Still live? Reuse. Otherwise fall through and mint a replacement.
      if (record && Date.now() <= record.expiresAt) return existing;
      this.designations.delete(key);
      if (existing) this.entries.delete(existing);
    }
    const handle = this.mint({ appId, action, sessionId });
    this.designations.set(key, handle);
    return handle;
  }

  /**
   * Resolves a handle for a caller that has proven which applet and session it
   * is, and consumes one use.
   *
   * **The binding checks are the point.** `applet-sandbox.md` §3 names the
   * residual risk of this whole design as "a capability handle that resolves
   * without checking its bound app" — a handle minted for applet B, presented
   * by applet A, is the shared-origin defect reappearing one layer up. Both
   * `appId` and `sessionId` are compared against the record, never read from
   * the request (#420 R3: no ambient authority at the boundary).
   */
  redeem(handle: string, ctx: RedeemContext): CapabilityResolution {
    const record = this.entries.get(handle);
    if (!record) return { ok: false, reason: 'unknown_handle' };

    // Evict-on-read, the idiom both existing TTL tables use — no sweeper.
    if (Date.now() > record.expiresAt) {
      this.entries.delete(handle);
      return { ok: false, reason: 'expired' };
    }
    if (record.appId !== ctx.appId) return { ok: false, reason: 'wrong_app' };
    if (record.sessionId !== ctx.sessionId) return { ok: false, reason: 'wrong_session' };
    if (record.usesRemaining <= 0) {
      this.entries.delete(handle);
      return { ok: false, reason: 'exhausted' };
    }

    record.usesRemaining -= 1;
    if (record.usesRemaining <= 0) this.entries.delete(handle);
    return { ok: true, record };
  }

  /**
   * Drops every handle for one app.
   *
   * Revocation "takes effect on the next invocation with no restart" (#420's
   * acceptance) — which for an in-memory table means deleting the entries, not
   * marking them. Called when an app's manifest changes or its grant is
   * withdrawn: the actions a handle names may no longer exist.
   */
  revokeApp(appId: string): number {
    let dropped = 0;
    for (const [handle, record] of this.entries) {
      if (record.appId !== appId) continue;
      this.entries.delete(handle);
      dropped++;
    }
    for (const [key, handle] of this.designations) {
      if (!this.entries.has(handle)) this.designations.delete(key);
    }
    return dropped;
  }

  /** Live entry count. Exposed for tests and the host's status line. */
  size(): number {
    return this.entries.size;
  }
}
