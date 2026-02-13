import * as readline from 'node:readline';
import { CronStore } from './store.js';
import { CronLogStore } from './log-store.js';
import { isDaemonRunning, startDaemon, stopDaemon } from './client.js';
import { printInfo, printError } from '../output.js';

function stopIfNoEnabledJobs(store: CronStore): void {
  const remaining = store.loadJobs().filter(j => j.enabled);
  if (remaining.length === 0 && isDaemonRunning()) {
    stopDaemon();
    printInfo('No enabled jobs remain — daemon stopped.');
  }
}

function confirm(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

export async function cronList(): Promise<void> {
  const store = new CronStore();
  const jobs = store.loadJobs();

  if (jobs.length === 0) {
    printInfo('No cron jobs configured.');
    return;
  }

  const running = isDaemonRunning();
  printInfo(`Daemon: ${running ? 'running' : 'stopped'}`);
  printInfo('');

  for (const job of jobs) {
    const indicator = job.enabled ? '\u2713' : '\u2717';
    const lastRun = job.lastRun
      ? `last run: ${job.lastRun} (${job.lastRunStatus || 'unknown'})`
      : 'never run';
    printInfo(`  ${indicator} ${job.name} (${job.id})`);
    printInfo(`    Schedule: ${job.schedule} | ${lastRun}`);
  }

  const enabled = jobs.filter(j => j.enabled).length;
  const disabled = jobs.length - enabled;
  printInfo('');
  printInfo(`${jobs.length} job(s): ${enabled} enabled, ${disabled} disabled`);
}

export async function cronDelete(ids: string[]): Promise<void> {
  const store = new CronStore();
  const logStore = new CronLogStore();

  // Validate all IDs first
  const found: Array<{ id: string; name: string }> = [];
  const notFound: string[] = [];
  for (const id of ids) {
    const job = store.getJob(id);
    if (job) {
      found.push({ id: job.id, name: job.name });
    } else {
      notFound.push(id);
    }
  }

  if (notFound.length > 0) {
    printError(`Job(s) not found: ${notFound.join(', ')}`);
    process.exit(1);
    return;
  }

  printInfo('Jobs to delete:');
  for (const job of found) {
    printInfo(`  - ${job.name} (${job.id})`);
  }

  const confirmed = await confirm(`Delete ${found.length} job(s)? This cannot be undone. (y/N): `);
  if (!confirmed) {
    printInfo('Cancelled.');
    return;
  }

  for (const job of found) {
    store.deleteJob(job.id);
    logStore.deleteJobLogs(job.id);
    printInfo(`Deleted: ${job.name}`);
  }

  stopIfNoEnabledJobs(store);
}

export async function cronDeleteAll(): Promise<void> {
  const store = new CronStore();
  const logStore = new CronLogStore();
  const jobs = store.loadJobs();

  if (jobs.length === 0) {
    printInfo('No cron jobs to delete.');
    return;
  }

  printInfo(`${jobs.length} job(s):`);
  for (const job of jobs) {
    printInfo(`  - ${job.name}`);
  }

  const confirmed = await confirm(`Delete ALL ${jobs.length} job(s) and their logs? This cannot be undone. (y/N): `);
  if (!confirmed) {
    printInfo('Cancelled.');
    return;
  }

  for (const job of jobs) {
    store.deleteJob(job.id);
    logStore.deleteJobLogs(job.id);
  }

  if (isDaemonRunning()) {
    stopDaemon();
    printInfo('Daemon stopped.');
  }

  printInfo(`Deleted ${jobs.length} job(s).`);
}

export async function cronStop(ids?: string[]): Promise<void> {
  if (!ids || ids.length === 0) {
    // Stop the daemon
    if (!isDaemonRunning()) {
      printInfo('Daemon is not running.');
      return;
    }
    stopDaemon();
    printInfo('Daemon stopped.');
    return;
  }

  // Disable specific jobs
  const store = new CronStore();
  for (const id of ids) {
    const job = store.getJob(id);
    if (!job) {
      printError(`Job not found: ${id}`);
      process.exit(1);
      return;
    }
    store.updateJob(id, { enabled: false });
    printInfo(`Disabled: ${job.name} (${id})`);
  }

  stopIfNoEnabledJobs(store);
}

export async function cronBounce(ids?: string[]): Promise<void> {
  if (!ids || ids.length === 0) {
    // Bounce the daemon
    const store = new CronStore();
    const enabled = store.loadJobs().filter(j => j.enabled);

    if (enabled.length === 0) {
      if (isDaemonRunning()) {
        stopDaemon();
        printInfo('Daemon stopped. No enabled jobs — not restarting.');
      } else {
        printInfo('No enabled jobs. Nothing to do.');
      }
      return;
    }

    const wasRunning = isDaemonRunning();
    if (wasRunning) {
      stopDaemon();
    }

    await new Promise(resolve => setTimeout(resolve, 500));

    startDaemon();
    printInfo(`Daemon ${wasRunning ? 'restarted' : 'started'}. ${enabled.length} enabled job(s).`);
    return;
  }

  // Bounce specific jobs
  const store = new CronStore();
  const toBounce: Array<{ id: string; name: string }> = [];

  for (const id of ids) {
    const job = store.getJob(id);
    if (!job) {
      printError(`Job not found: ${id}`);
      process.exit(1);
      return;
    }
    if (!job.enabled) {
      printInfo(`Skipping ${job.name} (${id}) — already disabled.`);
      continue;
    }
    toBounce.push({ id: job.id, name: job.name });
  }

  // Disable
  for (const job of toBounce) {
    store.updateJob(job.id, { enabled: false });
    printInfo(`Disabled: ${job.name}`);
  }

  await new Promise(resolve => setTimeout(resolve, 500));

  // Re-enable
  for (const job of toBounce) {
    store.updateJob(job.id, { enabled: true });
    printInfo(`Enabled: ${job.name}`);
  }

  // Ensure daemon is running
  if (!isDaemonRunning()) {
    startDaemon();
    printInfo('Daemon started.');
  }
}
