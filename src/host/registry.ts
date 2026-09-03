import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { APPLET_HOSTS_FILE } from '../paths.js';
import { atomicWriteFileSync } from '../fs-utils.js';

/**
 * Which port each applet is served from, and the session token for it (#421).
 *
 * **The port must be stable and persisted.** An applet's browser storage is
 * keyed to its origin, so a port that changes silently destroys that applet's
 * data with no error anywhere. That makes this a data-integrity record, not an
 * allocation cache — which is why a collision fails loudly rather than
 * quietly re-assigning.
 *
 * Kept out of the manifest deliberately: `AppManifestSchema` is `.strict()`
 * with `schemaVersion: z.literal(1)`, so a field here would make an older
 * binary reject the whole app; the manifest is bundle-seeded and user-editable,
 * so a token in it is settable by any local process; and it is validated on
 * read, i.e. trusted at exactly the wrong moment.
 */

/** The loopback range this allocates from — high, and outside IANA's registered block. */
export const PORT_RANGE_START = 45000;
export const PORT_RANGE_END = 45999;

export interface AppletHostRecord {
  port: number;
  /**
   * Regenerated every host start. It authenticates "this page was served by
   * this host process", so it should not outlive the process that served it.
   */
  token: string;
}

type HostsFile = Record<string, { port: number }>;

export class HostRegistry {
  /** Tokens live only in memory — see {@link AppletHostRecord.token}. */
  private readonly tokens = new Map<string, string>();

  /** Reads the persisted port assignments. Missing or corrupt reads as empty. */
  private loadPorts(): HostsFile {
    try {
      const raw = fs.readFileSync(APPLET_HOSTS_FILE, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out: HostsFile = {};
      for (const [appId, v] of Object.entries(parsed as Record<string, unknown>)) {
        const port = (v as { port?: unknown })?.port;
        if (typeof port === 'number' && Number.isInteger(port)) out[appId] = { port };
      }
      return out;
    } catch {
      return {};
    }
  }

  private savePorts(ports: HostsFile): void {
    fs.mkdirSync(path.dirname(APPLET_HOSTS_FILE), { recursive: true });
    // Atomic, like every other JSON store in the repo — and here it is not
    // hygiene. `loadPorts` fails open to `{}`, so a torn write means every
    // applet is reassigned a port, which silently destroys all of their
    // browser storage. That is the exact outcome this record exists to
    // prevent.
    //
    // `mode` on the temp file rather than a `chmod` afterwards: the latter
    // leaves a window at the default umask.
    atomicWriteFileSync(APPLET_HOSTS_FILE, JSON.stringify(ports, null, 2) + '\n', { mode: 0o600 });
  }

  /** The port this applet has been assigned, or `undefined` if it has none yet. */
  portFor(appId: string): number | undefined {
    return this.loadPorts()[appId]?.port;
  }

  /**
   * Assigns a stable port to an applet that has none, keeping any it already
   * has.
   *
   * Deterministic first choice — a hash of the app id — so a fresh install
   * that seeds the same apps lands on the same ports, and two machines agree.
   * Linear probing from there on collision within the file.
   */
  assignPort(appId: string): number {
    const ports = this.loadPorts();
    const existing = ports[appId]?.port;
    if (existing !== undefined) return existing;

    const taken = new Set(Object.values(ports).map((p) => p.port));
    const span = PORT_RANGE_END - PORT_RANGE_START + 1;
    const hash = crypto.createHash('sha256').update(appId).digest();
    const start = hash.readUInt32BE(0) % span;

    for (let i = 0; i < span; i++) {
      const candidate = PORT_RANGE_START + ((start + i) % span);
      if (!taken.has(candidate)) {
        ports[appId] = { port: candidate };
        this.savePorts(ports);
        return candidate;
      }
    }
    throw new Error(
      `No free applet port in ${PORT_RANGE_START}-${PORT_RANGE_END}; ${taken.size} already assigned.`,
    );
  }

  /**
   * The session token for an applet, minted on first ask for this process.
   *
   * Per-process rather than persisted: it says "this page came from the host
   * that is running now". A restart invalidates every page still open, which
   * is the correct outcome — those pages hold handles the new process's
   * capability table has never heard of.
   */
  tokenFor(appId: string): string {
    let token = this.tokens.get(appId);
    if (!token) {
      token = crypto.randomBytes(32).toString('base64url');
      this.tokens.set(appId, token);
    }
    return token;
  }

  /**
   * Port + token together, assigning and minting as needed.
   *
   * There is deliberately no `release`. An assignment is kept even after an
   * applet is removed, so re-adding it restores the same origin and therefore
   * the browser storage that origin still holds. The file grows by one small
   * entry per applet ever seen, which is the cheaper side of that trade.
   */
  recordFor(appId: string): AppletHostRecord {
    return { port: this.assignPort(appId), token: this.tokenFor(appId) };
  }
}
