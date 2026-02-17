import * as fs from 'node:fs';
import { CronStore } from './store.js';
import { Scheduler } from './scheduler.js';
import { loadConfig } from '../config.js';

const MAX_LOG_SIZE = 1_000_000; // 1MB

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

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  log('Daemon running');
}

main();
