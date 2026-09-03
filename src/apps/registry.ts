import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPS_DIR, appletAssetDir } from '../paths.js';
import { atomicWriteFileSync, seedBundledJsonDir } from '../fs-utils.js';
import {
  parseAppManifest,
  parseRawAppManifest,
  type AppAction,
  type AppManifest,
} from './manifest.js';

/** Marker gating the one-time seed of the bundled example app. */
const SEED_MARKER = '.seeded-v1';

/**
 * Ceiling on installed applets, matching `MAX_SPECIALISTS`.
 *
 * Each one is a persistent HTTP listener, a port assignment that is never
 * released and a SQLite file, so the cost of an unbounded count is not just
 * disk.
 */
const MAX_APPLETS = 50;

/**
 * A plain filename — no directory separators, no `..`, no leading dot.
 *
 * Applet files are model-authored, and a key like `../evil.json` would land in
 * `APPS_DIR` beside the manifests. `resolveAsset` refuses traversal when
 * serving; this refuses it when writing.
 */
const ASSET_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/**
 * Copies a bundled applet's served files alongside its manifest (#421).
 *
 * Runs INSIDE `seedBundledJsonDir`'s `seedOnce`, so it is gated by the same
 * `.seeded-v1` marker and protected by the same cross-process lock. Called
 * outside it — as the first cut did — it re-ran a `readdir` plus a per-entry
 * `existsSync` on every `AppRegistry` construction, which is once per script
 * invocation and once per applet bootstrap request, and two concurrent
 * requests could race the `cpSync`.
 *
 * Never overwrites: an existing directory is one the user or an agent has
 * written into, the same promise the manifest half makes.
 */
function seedAssets(bundledDir: string, destDir: string): void {
  for (const entry of fs.readdirSync(bundledDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dest = path.join(destDir, entry.name);
    if (fs.existsSync(dest)) continue;
    fs.cpSync(path.join(bundledDir, entry.name), dest, { recursive: true });
  }
}

/**
 * The applet ids Bernard ships, read from what is actually bundled.
 *
 * Derived from the shipped directory, never from a field on the manifest —
 * the same rule `specialist-authority.ts` follows for `SpecialistRole`, and
 * for the same reason: a manifest is user-editable, so a record that could
 * *declare* itself bundled would let a tampered file claim provenance it does
 * not have. Here that only mislabels a listing rather than bypassing a
 * permission, but the cheap habit is worth keeping.
 *
 * Unlike a bundled specialist, a bundled applet is **not protected**: it is
 * copied on first run and the copy is the user's to edit or delete. So this
 * answers "where did this come from", not "may I touch it".
 */
export function bundledAppIds(): Set<string> {
  try {
    return new Set(
      fs
        .readdirSync(bundledAppsDir(), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name),
    );
  } catch {
    // A build without `builtin-apps/` copied in: everything reads as the
    // user's, which is the safer way to be wrong — it hides nothing.
    return new Set();
  }
}

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
 * Writable since the authoring flow landed. Every write goes through
 * `atomicWriteFileSync` and is validated against {@link RawAppManifestSchema}
 * — the RAW schema, not the reader's: `AppManifestSchema` lifts a v1 action
 * into the `dispatch` union, so validating with it and then serializing the
 * result produces a manifest its own `schemaVersion` refinement rejects.
 *
 * The manifest and the served assets are written **together**. They are one
 * artifact: a manifest with no page is an applet that 404s, and a page with no
 * manifest is invisible to {@link AppRegistry.listIds}.
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
    seedBundledJsonDir(bundledAppsDir(), APPS_DIR, path.join(APPS_DIR, SEED_MARKER), seedAssets);
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

  /**
   * Writes a manifest and its page.
   *
   * Order follows `SpecialistStore.createFull`: validate → exists → limit →
   * write. The assets land BEFORE the manifest, because the manifest is what
   * `listIds()` sees and therefore what makes the applet real to the host's
   * reconcile loop — writing it first would briefly serve an applet whose page
   * does not exist yet.
   */
  create(manifest: unknown, files: Record<string, string>): AppManifest {
    const parsed = parseRawAppManifest(manifest);
    if (!parsed.ok) throw new Error(`Invalid manifest: ${parsed.error}`);
    const raw = parsed.value;
    if (this.exists(raw.id)) throw new Error(`App "${raw.id}" already exists.`);
    if (this.listIds().length >= MAX_APPLETS) {
      throw new Error(`Maximum of ${MAX_APPLETS} applets reached.`);
    }
    if (!files['index.html']) {
      throw new Error('An applet needs an `index.html` — a manifest with no page serves a 404.');
    }
    this.writeAssets(raw.id, files);
    atomicWriteFileSync(path.join(APPS_DIR, `${raw.id}.json`), JSON.stringify(raw, null, 2) + '\n');
    const read = this.get(raw.id);
    if (!read.ok) throw new Error(read.failure.message);
    return read.manifest;
  }

  /**
   * Replaces a manifest, and any files supplied alongside it.
   *
   * Whole-manifest replacement rather than a deep merge: `actions` is a record
   * and "merge" has no single obvious meaning for it — the caller reads, edits
   * and writes back, which keeps that decision where a person can see it.
   */
  update(appId: string, manifest: unknown, files: Record<string, string> = {}): AppManifest {
    if (!this.exists(appId)) throw new Error(`No such app: ${appId}`);
    const parsed = parseRawAppManifest(manifest);
    if (!parsed.ok) throw new Error(`Invalid manifest: ${parsed.error}`);
    if (parsed.value.id !== appId) {
      throw new Error(
        `Manifest declares id "${parsed.value.id}" but is being written as ${appId}.`,
      );
    }
    if (Object.keys(files).length > 0) this.writeAssets(appId, files);
    atomicWriteFileSync(
      path.join(APPS_DIR, `${appId}.json`),
      JSON.stringify(parsed.value, null, 2) + '\n',
    );
    const read = this.get(appId);
    if (!read.ok) throw new Error(read.failure.message);
    return read.manifest;
  }

  /**
   * Removes the manifest and the served assets, and nothing else.
   *
   * Deliberately NOT the whole sweep — see `deleteApplet` in `lifecycle.ts`,
   * which owns the cross-store cleanup. Keeping this narrow means the registry
   * stays a registry rather than acquiring edges to the specialist store, the
   * profile settings and SQLite.
   */
  remove(appId: string): boolean {
    if (!this.exists(appId)) return false;
    fs.rmSync(path.join(APPS_DIR, `${appId}.json`), { force: true });
    fs.rmSync(appletAssetDir(appId), { recursive: true, force: true });
    return true;
  }

  /** True when a manifest exists for this id. */
  exists(appId: string): boolean {
    return fs.existsSync(path.join(APPS_DIR, `${appId}.json`));
  }

  /**
   * Reads one of an applet's page files back.
   *
   * The same filename rule `writeAssets` enforces on the way in, for the same
   * reason: the name reaches here from a tool call, and `../` would read a
   * sibling applet's manifest out of `APPS_DIR`. Returns `null` rather than
   * throwing for a missing file — an applet without the asset is a state a
   * caller has to handle either way.
   */
  readAsset(appId: string, name: string): string | null {
    if (!ASSET_NAME_RE.test(name)) return null;
    const file = path.join(appletAssetDir(appId), name);
    try {
      return fs.readFileSync(file, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Writes page files under `appletAssetDir`.
   *
   * Every name is checked against a plain filename pattern rather than joined
   * blind: these come from a model, and `../` in a key would escape the applet
   * into `APPS_DIR` where the sibling manifests live. `resolveAsset` refuses
   * traversal on the way OUT; this is the same rule on the way in.
   */
  private writeAssets(appId: string, files: Record<string, string>): void {
    const dir = appletAssetDir(appId);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, contents] of Object.entries(files)) {
      if (!ASSET_NAME_RE.test(name)) {
        throw new Error(
          `Not a valid applet file name: "${name}". Use a plain name like index.html.`,
        );
      }
      atomicWriteFileSync(path.join(dir, name), contents);
    }
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
