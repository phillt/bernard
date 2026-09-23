import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CronStore } from './store.js';
import { exitLoudlyOnFatal, restartOnRebuild } from '../build-stamp.js';
import { Scheduler } from './scheduler.js';
import { loadConfig } from '../config.js';

const MAX_LOG_SIZE = 1_000_000; // 1MB

/**
 * Creates a logger function that appends timestamped lines to the daemon log file.
 * Automatically rotates the log when it exceeds {@link MAX_LOG_SIZE}.
 */
function createLogger() {
  const logFile = CronStore.logFile;

  return (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try {
      // Rotate if log exceeds max size
      try {
        const stat = fs.statSync(logFile);
        if (stat.size > MAX_LOG_SIZE) {
          const rotated = logFile + '.old';
          try {
            fs.unlinkSync(rotated);
          } catch {}
          fs.renameSync(logFile, rotated);
        }
      } catch {
        // File doesn't exist yet, that's fine
      }
      fs.appendFileSync(logFile, line);
    } catch {
      // Can't log, nothing we can do
    }
  };
}

/**
 * Daemon entry point: loads config, initializes the scheduler, watches for
 * job changes, and handles graceful shutdown on SIGTERM/SIGINT.
 */
function main() {
  const log = createLogger();
  log('Daemon starting');

  // Load config to ensure .env is loaded for API keys
  try {
    loadConfig();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Config error: ${message}`);
    process.exit(1);
  }

  const store = new CronStore();
  const scheduler = new Scheduler(store, log);

  // Write PID file
  fs.writeFileSync(CronStore.pidFile, String(process.pid), 'utf-8');
  log(`PID ${process.pid} written`);

  // Detect stale running jobs from a previous crash
  const jobs = store.loadJobs();
  for (const job of jobs) {
    if (job.lastRunStatus === 'running') {
      log(
        `Warning: Job "${job.name}" (${job.id}) was in running state at startup — previous daemon may have crashed`,
      );
      store.updateJob(job.id, {
        lastRunStatus: 'error',
        lastResult: 'Daemon restarted while job was running',
      });
    }
  }

  // Initial reconcile
  scheduler.reconcile();
  log(`Initial reconcile done. ${scheduler.activeCount} tasks scheduled.`);

  // Watch cron directory for changes (watching the file directly breaks
  // on Linux after atomic writes replace the inode via rename)
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    fs.watch(CronStore.cronDir, (eventType, filename) => {
      if (filename !== 'jobs.json' && filename !== 'jobs.json.tmp') return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        log('jobs.json changed, reconciling');
        scheduler.reconcile();
        log(`Reconcile done. ${scheduler.activeCount} tasks scheduled.`);
      }, 500);
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log(
      `Warning: Could not watch cron directory: ${message}. Changes won't be detected until restart.`,
    );
  }

  // Graceful shutdown
  const shutdown = (signal: string) => {
    log(`Received ${signal}, shutting down`);
    scheduler.stopAll();
    try {
      fs.unlinkSync(CronStore.pidFile);
    } catch {}
    log('Daemon stopped');
    process.exit(0);
  };

  /**
   * Replace this process when Bernard is rebuilt underneath it.
   *
   * The applet host is where this was found (`src/build-stamp.ts` has the
   * incident), but the exposure is identical here and quieter: a cron job
   * reaches `createTools`, which loads nine tool modules through deferred
   * `await import()`, so the first job to build a registry after a build
   * links fresh code against this process's stale cache. With no operator
   * watching, that is a job that simply stops working.
   *
   * Jobs are drained first, with a much longer budget than the applet host
   * allows: a cron run's own ceiling is `BERNARD_CRON_JOB_TIMEOUT_MS` (30 min
   * by default), nobody is waiting on a spinner, and killing a half-finished
   * unattended job is the expensive outcome here rather than the cheap one.
   */
  restartOnRebuild({
    entry: fileURLToPath(import.meta.url),
    pidFile: CronStore.pidFile,
    log,
    inFlight: () => scheduler.inFlightCount,
    unit: 'job',
    drainTimeoutMs: 5 * 60_000,
    drainPollMs: 1_000,
    beforeExit: () => scheduler.stopAll(),
  });

  // Same reason as the applet host: spawned `stdio: 'ignore'`, so without
  // this a crash leaves nothing anywhere and has to be inferred from a job
  // that simply stopped running.
  exitLoudlyOnFatal(log);

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  log('Daemon running');
}

main();
