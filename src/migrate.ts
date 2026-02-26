import * as fs from 'node:fs';
import * as path from 'node:path';
import { LEGACY_DIR, CONFIG_DIR, DATA_DIR, CACHE_DIR, STATE_DIR } from './paths.js';

const MIGRATED_MARKER = path.join(LEGACY_DIR, 'MIGRATED');

/** File-to-XDG-category mapping for migration. */
const MIGRATION_MAP: Array<{ src: string; destDir: string; mode?: number }> = [
  // Config files
  { src: 'preferences.json', destDir: CONFIG_DIR },
  { src: 'keys.json', destDir: CONFIG_DIR, mode: 0o600 },
  { src: '.env', destDir: CONFIG_DIR },
  { src: 'mcp.json', destDir: CONFIG_DIR },

  // Cache files
  { src: 'update-check.json', destDir: CACHE_DIR },

  // State files
  { src: 'conversation-history.json', destDir: STATE_DIR },
];

/** Directory-to-XDG-category mapping for migration. */
const DIR_MIGRATION_MAP: Array<{ src: string; destDir: string }> = [
  // Data directories
  { src: 'memory', destDir: path.join(DATA_DIR, 'memory') },
  { src: 'rag', destDir: path.join(DATA_DIR, 'rag') },
  { src: 'cron', destDir: path.join(DATA_DIR, 'cron') },

  // Cache directories
  { src: 'models', destDir: path.join(CACHE_DIR, 'models') },

  // State directories
  { src: 'logs', destDir: path.join(STATE_DIR, 'logs') },
];

/**
 * Move a single file, falling back to copy+delete on cross-filesystem (EXDEV) errors.
 * Creates destination directory if needed.
 */
function moveFile(src: string, dest: string, mode?: number): void {
  const destDir = path.dirname(dest);
  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });

  try {
    fs.renameSync(src, dest);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } else {
      throw err;
    }
  }

  if (mode !== undefined) {
    fs.chmodSync(dest, mode);
  }
}

/**
 * Recursively move a directory's contents to a new location.
 * Creates the destination directory structure as needed.
 */
function moveDir(srcDir: string, destDir: string): void {
  if (!fs.existsSync(srcDir)) return;

  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      moveDir(srcPath, destPath);
    } else {
      moveFile(srcPath, destPath);
    }
  }

  // Remove the now-empty source directory
  try {
    fs.rmdirSync(srcDir);
  } catch {
    // May not be empty if some files failed; ignore
  }
}

/**
 * Migrate files from the legacy `~/.bernard/` layout to XDG directories.
 *
 * - No-op if `BERNARD_HOME` is set (user explicitly controls layout)
 * - No-op if `~/.bernard/` does not exist (fresh install)
 * - No-op if already migrated (MIGRATED marker exists or prefs in XDG location)
 *
 * @returns Object with `migrated` flag and any non-fatal `errors` encountered.
 */
export function migrateFromLegacy(): { migrated: boolean; errors: string[] } {
  const errors: string[] = [];

  // Skip if user explicitly controls layout
  if (process.env.BERNARD_HOME) {
    return { migrated: false, errors };
  }

  // Skip if legacy dir doesn't exist (fresh install)
  if (!fs.existsSync(LEGACY_DIR)) {
    return { migrated: false, errors };
  }

  // Skip if already migrated
  if (fs.existsSync(MIGRATED_MARKER)) {
    return { migrated: false, errors };
  }
  if (fs.existsSync(CONFIG_DIR)) {
    try {
      const entries = fs.readdirSync(CONFIG_DIR);
      if (entries.length > 0) {
        return { migrated: false, errors };
      }
    } catch {
      /* proceed with migration */
    }
  }

  // Ensure XDG base directories exist with 0700
  for (const dir of [CONFIG_DIR, DATA_DIR, CACHE_DIR, STATE_DIR]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // Migrate individual files
  for (const entry of MIGRATION_MAP) {
    const srcPath = path.join(LEGACY_DIR, entry.src);
    if (!fs.existsSync(srcPath)) continue;

    try {
      const destPath = path.join(entry.destDir, entry.src);
      moveFile(srcPath, destPath, entry.mode);
    } catch (err: unknown) {
      const msg = `Failed to migrate ${entry.src}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
    }
  }

  // Migrate directories
  for (const entry of DIR_MIGRATION_MAP) {
    const srcPath = path.join(LEGACY_DIR, entry.src);
    if (!fs.existsSync(srcPath)) continue;

    try {
      moveDir(srcPath, entry.destDir);
    } catch (err: unknown) {
      const msg = `Failed to migrate ${entry.src}/: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
    }
  }

  // Also move the daemon PID and log from cron/ to state (they lived under cron/ in legacy)
  for (const file of ['daemon.pid', 'daemon.log']) {
    const srcPath = path.join(DATA_DIR, 'cron', file);
    if (!fs.existsSync(srcPath)) continue;
    try {
      const destName = file === 'daemon.pid' ? 'cron-daemon.pid' : 'cron-daemon.log';
      moveFile(srcPath, path.join(STATE_DIR, destName));
    } catch (err: unknown) {
      const msg = `Failed to relocate cron/${file}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
    }
  }

  // Leave marker explaining the migration
  try {
    fs.writeFileSync(
      MIGRATED_MARKER,
      'Bernard files have been migrated to XDG Base Directory locations.\n' +
        'See: https://specifications.freedesktop.org/basedir/latest/\n' +
        `Config: ${CONFIG_DIR}\n` +
        `Data:   ${DATA_DIR}\n` +
        `Cache:  ${CACHE_DIR}\n` +
        `State:  ${STATE_DIR}\n`,
    );
  } catch {
    // Non-critical
  }

  // Print one-line notice to stderr
  process.stderr.write(
    `bernard: migrated data from ~/.bernard/ to XDG directories (see ~/.bernard/MIGRATED)\n`,
  );

  return { migrated: true, errors };
}
