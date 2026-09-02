import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPS_DIR } from '../paths.js';
import { seedBundledJsonDir } from '../fs-utils.js';
import { parseAppManifest, type AppAction, type AppManifest } from './manifest.js';

/** Marker gating the one-time seed of the bundled example app. */
const SEED_MARKER = '.seeded-v1';

function bundledAppsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'builtin-apps');
}

/** Why a `(appId, action)` pair did not resolve. Each maps to a distinct exit code. */
export type ResolveFailure =
  | { kind: 'unknown_app'; appId: string; message: string }
  | { kind: 'unknown_action'; appId: string; action: string; message: string }
  | { kind: 'invalid_manifest'; appId: string; message: string };

export type ResolveResult =
  | { ok: true; manifest: AppManifest; actionName: string; action: AppAction }
  | { ok: false; failure: ResolveFailure };

export interface AppRegistryOptions {
  /** Set `false` to skip seeding the bundled example app (tests, cron). */
  seed?: boolean;
}

/**
 * File-backed registry of app manifests, one `<appId>.json` per app under
 * {@link APPS_DIR}.
 *
 * One file per app rather than cron's single `jobs.json`, following
 * `SPECIALISTS_DIR`: apps are installed and removed independently, and a
 * corrupt one should take out that app rather than the registry. It is also
 * the shape #420 wants for a per-app grant record.
 *
 * Read-only for now — #419 ships no create/edit surface, so manifests are
 * hand-authored or seeded. Writes, when they arrive, go through
 * {@link atomicWriteFileSync}.
 */
export class AppRegistry {
  constructor(opts: AppRegistryOptions = {}) {
    if (opts.seed !== false) this.seed();
  }

  /**
   * Copies the bundled example app in on first use.
   *
   * Seeded lazily on first registry construction rather than at REPL start:
   * the daemon and the REPL both reach this, and a startup seed is how #163
   * produced a first-run write race.
   */
  private seed(): void {
    seedBundledJsonDir(bundledAppsDir(), APPS_DIR, path.join(APPS_DIR, SEED_MARKER));
  }

  /** App ids present on disk, sorted. Does not parse the manifests. */
  listIds(): string[] {
    try {
      return fs
        .readdirSync(APPS_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * Reads and validates one manifest.
   *
   * Validation happens on **read**, not only on write. The file is
   * user-editable between runs, so trusting a write-time check is a
   * time-of-check/time-of-use gap — and #420 R6 asks for complete mediation:
   * validated at mint and again at execute.
   */
  get(appId: string): ParsedApp {
    const file = path.join(APPS_DIR, `${appId}.json`);
    if (!fs.existsSync(file)) {
      return {
        ok: false,
        failure: { kind: 'unknown_app', appId, message: `No such app: ${appId}` },
      };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (err) {
      return {
        ok: false,
        failure: {
          kind: 'invalid_manifest',
          appId,
          message: `${appId}.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
    const parsed = parseAppManifest(raw);
    if (!parsed.ok) {
      return {
        ok: false,
        failure: { kind: 'invalid_manifest', appId, message: parsed.error },
      };
    }
    // The filename is the address a caller uses, so a manifest whose `id`
    // disagrees with it is ambiguous rather than merely untidy — reject it
    // instead of silently preferring one.
    if (parsed.value.id !== appId) {
      return {
        ok: false,
        failure: {
          kind: 'invalid_manifest',
          appId,
          message: `${appId}.json declares id "${parsed.value.id}"; the filename must match the id`,
        },
      };
    }
    return { ok: true, manifest: parsed.value };
  }

  /** Resolves `(appId, action)` against the closed registry. */
  resolve(appId: string, actionName: string): ResolveResult {
    const app = this.get(appId);
    if (!app.ok) return app;
    const action = app.manifest.actions[actionName];
    if (!action) {
      const known = Object.keys(app.manifest.actions).sort().join(', ');
      return {
        ok: false,
        failure: {
          kind: 'unknown_action',
          appId,
          action: actionName,
          message: `App "${appId}" has no action "${actionName}". Known actions: ${known}`,
        },
      };
    }
    return { ok: true, manifest: app.manifest, actionName, action };
  }
}

/** Result of reading one manifest file. */
export type ParsedApp =
  | { ok: true; manifest: AppManifest }
  | { ok: false; failure: ResolveFailure };
