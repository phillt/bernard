import * as https from 'node:https';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import { printInfo, printError } from './output.js';

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const CACHE_PATH = path.join(os.homedir(), '.bernard', 'update-check.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PACKAGE_NAME = 'bernard-agent';

interface CacheData {
  lastCheck: string;
  latestVersion: string;
  currentVersion: string;
}

interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string;
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
    const req = https.get(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Registry returned status ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
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
    });
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
    return JSON.parse(raw) as CacheData;
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
export function startupUpdateCheck(autoUpdate: boolean): void {
  checkForUpdate()
    .then((result) => {
      if (!result.updateAvailable) return;

      if (autoUpdate) {
        try {
          applyUpdate(result.latestVersion);
          console.log(`\n  Updated bernard to v${result.latestVersion}. Restart to use the new version.\n`);
        } catch {
          console.log(`\n  Update to v${result.latestVersion} failed. Run: bernard update\n`);
        }
      } else {
        console.log(`\n  Update available: v${result.currentVersion} → v${result.latestVersion}`);
        console.log(`  Run: bernard update\n`);
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
  console.log('\n  Checking for updates...');

  try {
    const result = await checkForUpdate(true);

    if (!result.updateAvailable) {
      console.log(`  You're on the latest version (v${result.currentVersion}).`);
      console.log(`  Tip: Run "bernard auto-update on" to enable automatic updates.\n`);
      return;
    }

    console.log(`  Update available: v${result.currentVersion} → v${result.latestVersion}`);
    console.log(`  Installing...\n`);

    applyUpdate(result.latestVersion);

    console.log(`\n  Updated to v${result.latestVersion}. Restart bernard to use the new version.\n`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  Update failed: ${message}\n`);
  }
}
