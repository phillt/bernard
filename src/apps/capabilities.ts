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

export type CapabilityKind =
  /**
   * Binds `(appId, action)` and the action's **arg schema**, minted at serve
   * time — before any untrusted data is in scope. Values are validated against
   * that schema at invoke.
   *
   * This is the honest answer to R2's "minted before untrusted data is in
   * scope, and immutable". An applet's arguments come from user interaction,
   * so they cannot all be frozen at mint; what *is* frozen is the designation
   * — which action, with which shape — and that is the property the
   * Action-Selector Pattern actually rests on. Only the data varies.
   */
  | 'action'
  /**
   * Binds specific argument **values**, minted after a human confirmation.
   * The shape R8's confirmation flow needs — the user approved *this* call,
   * not this kind of call.
   */
  | 'frozen';

export interface CapabilityRecord {
  kind: CapabilityKind;
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
  kind?: CapabilityKind;
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

  /**
   * Mints a handle. The returned string **encodes nothing** — no app id, no
   * action, no scope — so there is nothing in it to forge or to tamper with.
   * All authority lives in the record.
   */
  mint(opts: MintOptions): string {
    const handle = crypto.randomBytes(32).toString('base64url');
    this.entries.set(handle, {
      kind: opts.kind ?? 'action',
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
      if (record.appId === appId) {
        this.entries.delete(handle);
        dropped++;
      }
    }
    return dropped;
  }

  /** Drops every handle issued to one session — used when a host restarts. */
  revokeSession(sessionId: string): number {
    let dropped = 0;
    for (const [handle, record] of this.entries) {
      if (record.sessionId === sessionId) {
        this.entries.delete(handle);
        dropped++;
      }
    }
    return dropped;
  }

  /** Live entry count. Exposed for tests and the host's status line. */
  size(): number {
    return this.entries.size;
  }
}
