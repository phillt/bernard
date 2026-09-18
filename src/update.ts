import * as https from 'node:https';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { printInfo, printError } from './output.js';
import { UPDATE_CACHE_PATH as CACHE_PATH } from './paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PACKAGE_NAME = 'bernard-agent';
const RELEASE_NOTES_BASE = 'https://phillt.github.io/bernard';

/**
 * Build the release-notes URL for a given version.
 *
 * @param version Semantic version in `MAJOR.MINOR.PATCH` format.
 * @returns An HTTPS URL under `RELEASE_NOTES_BASE` pointing to that version's release notes.
 */
export function releaseNotesUrl(version: string): string {
  return `${RELEASE_NOTES_BASE}/releases.html#v${version}`;
}

/** Persisted update-check cache. */
interface CacheData {
  /** ISO-8601 timestamp of the last registry check. */
  lastCheck: string;
  /** Latest version reported by the npm registry. */
  latestVersion: string;
  /** Local version at the time of the check. */
  currentVersion: string;
}

/** Result of comparing local and registry versions. */
interface UpdateCheckResult {
  /** `true` when the registry version is newer than the installed version. */
  updateAvailable: boolean;
  /** Currently installed semver string. */
  currentVersion: string;
  /** Latest semver string from the npm registry. */
  latestVersion: string;
  /** `true` if the result was served from the local 24-hour cache. */
  cached: boolean;
}

/**
 * Compare two semver strings. Returns >0 if a > b, 0 if equal, <0 if a < b.
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Read the local package version from package.json.
 */
export function getLocalVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Fetch the latest published version from the npm registry.
 */
export function fetchLatestVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://registry.npmjs.org/${PACKAGE_NAME}/latest`,
      { timeout: 5000 },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Registry returned status ${res.statusCode}`));
          return;
        }
        const MAX_RESPONSE_SIZE = 1024 * 1024; // 1MB
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk;
          if (data.length > MAX_RESPONSE_SIZE) {
            res.destroy();
            reject(new Error('Registry response too large'));
          }
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.version && SEMVER_RE.test(parsed.version)) {
              resolve(parsed.version);
            } else {
              reject(new Error('No valid version field in registry response'));
            }
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Registry request timed out'));
    });
  });
}

function readCache(): CacheData | null {
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.lastCheck === 'string' &&
      typeof parsed.latestVersion === 'string' &&
      SEMVER_RE.test(parsed.latestVersion) &&
      typeof parsed.currentVersion === 'string' &&
      SEMVER_RE.test(parsed.currentVersion)
    ) {
      return parsed as CacheData;
    }
    return null;
  } catch {
    return null;
  }
}

function writeCache(data: CacheData): void {
  const dir = path.dirname(CACHE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2) + '\n');
}

function isCacheFresh(cache: CacheData): boolean {
  const age = Date.now() - new Date(cache.lastCheck).getTime();
  return age < CACHE_TTL_MS;
}

/**
 * Check whether an update is available. Uses a 24h cache unless forceCheck is true.
 */
export async function checkForUpdate(forceCheck = false): Promise<UpdateCheckResult> {
  const currentVersion = getLocalVersion();

  if (!forceCheck) {
    const cache = readCache();
    if (cache && isCacheFresh(cache)) {
      return {
        updateAvailable: compareSemver(cache.latestVersion, currentVersion) > 0,
        currentVersion,
        latestVersion: cache.latestVersion,
        cached: true,
      };
    }
  }

  const latestVersion = await fetchLatestVersion();

  writeCache({
    lastCheck: new Date().toISOString(),
    latestVersion,
    currentVersion,
  });

  return {
    updateAvailable: compareSemver(latestVersion, currentVersion) > 0,
    currentVersion,
    latestVersion,
    cached: false,
  };
}

/**
 * Install a specific version globally via npm.
 */
export function applyUpdate(version: string): void {
  if (!SEMVER_RE.test(version)) {
    throw new Error(`Invalid version format: ${version}`);
  }
  execSync(`npm install -g ${PACKAGE_NAME}@${version}`, { stdio: 'inherit' });
}

/**
 * Non-blocking startup check. Never throws, never blocks the REPL.
 */
/**
 * A version found mid-session and waiting for the session to end.
 *
 * Module-level and taken exactly once, the `providers/request-counter.ts`
 * shape: the check is fired before Ink mounts and resolves long after, so there
 * is no handle to thread an answer back through.
 */
let pendingUpdate: string | null = null;

/**
 * An update the user has NOT opted into installing, to tell them about at exit.
 *
 * The auto-install half was moved off the mid-session path because
 * `startupUpdateCheck` fires before Ink mounts and settles long after, so
 * writing there lands in the alternate screen buffer Ink owns and is painted
 * over on the next ~32 ms render — `mcp.ts`'s reconnect-notice class. The
 * `else` branch three lines below kept printing two lines from that same
 * promise, at that same moment, into that same buffer: so the notice was
 * corrupted and immediately erased for exactly the population that has to act
 * on it by hand. It is recorded and drained beside the install.
 */
let pendingUpdateNotice: string | null = null;

/**
 * The update to apply now that the REPL is down, or `null`.
 *
 * Taking it clears it, so a second caller cannot install twice.
 */
export function takePendingUpdate(): string | null {
  const v = pendingUpdate;
  pendingUpdate = null;
  return v;
}

/**
 * Installs whatever the session found, once the session is over. Never throws.
 *
 * The blocking half of the old inline path, moved to where blocking is free.
 */
/**
 * Prints the "update available" notice recorded at startup, if there is one.
 *
 * Drained beside {@link applyPendingUpdate}, after the alternate screen buffer
 * has been torn down — see {@link pendingUpdateNotice}. Clears as it reads, so
 * a second drain cannot print it twice.
 */
export function flushPendingUpdateNotice(): void {
  const version = pendingUpdateNotice;
  pendingUpdateNotice = null;
  if (version === null) return;
  printInfo(`\n  Update available: v${version}`);
  printInfo(`  What's new: ${releaseNotesUrl(version)}`);
  printInfo(`  Run: bernard update\n`);
}

export function applyPendingUpdate(): void {
  const version = takePendingUpdate();
  if (version === null) return;
  try {
    printInfo(`\n  Applying update to v${version}...`);
    applyUpdate(version);
    printInfo(`  Updated bernard to v${version}.`);
    printInfo(`  What's new: ${releaseNotesUrl(version)}\n`);
  } catch {
    printInfo(`\n  Update to v${version} failed. Run: bernard update\n`);
  }
}

export function startupUpdateCheck(autoUpdate: boolean): void {
  checkForUpdate()
    .then((result) => {
      if (!result.updateAvailable) return;

      if (autoUpdate) {
        // Recorded, NOT applied. `applyUpdate` is an `execSync` of a global npm
        // install with `stdio: 'inherit'` — so applying it here would block the
        // event loop for the length of that install and write npm's output
        // straight into the alternate screen buffer Ink owns, which is the
        // exact class of bug `mcp.ts`'s reconnect notice was fixed for. This
        // check is fired before Ink mounts and its promise settles well after,
        // so "here" is always mid-session.
        //
        // The message was already "Restart to use the new version", so applying
        // at exit costs the user nothing and removes the freeze. `index.ts`
        // drains it after `fullScreen.teardown()`, where output lands on the
        // restored normal screen.
        pendingUpdate = result.latestVersion;
      } else {
        pendingUpdateNotice = result.latestVersion;
      }
    })
    .catch(() => {
      // Silent — never block startup
    });
}

/**
 * Interactive update flow for /update and `bernard update`.
 */
export async function interactiveUpdate(): Promise<void> {
  printInfo('\n  Checking for updates...');

  try {
    const result = await checkForUpdate(true);

    if (!result.updateAvailable) {
      printInfo(`  You're on the latest version (v${result.currentVersion}).`);
      printInfo(`  Tip: Run "bernard auto-update on" to enable automatic updates.\n`);
      return;
    }

    printInfo(`  Update available: v${result.currentVersion} → v${result.latestVersion}`);
    printInfo(`  Installing...\n`);

    applyUpdate(result.latestVersion);

    printInfo(`\n  Updated to v${result.latestVersion}. Restart bernard to use the new version.`);
    printInfo(`  What's new: ${releaseNotesUrl(result.latestVersion)}\n`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    printError(`  Update failed: ${message}\n`);
  }
}
