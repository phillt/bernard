import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CronStore } from './store.js';
import { CronLogStore } from './log-store.js';
import { deleteCronJob } from './lifecycle.js';
import { runJob } from './runner.js';
import { isDaemonRunning, startDaemon, stopDaemon } from './client.js';
import { printInfo, printError } from '../output.js';
import { runWorkspace, WORKSPACE_MAX_AGE_MS } from '../paths.js';
import { parseGrantSpec, type PermissionRule } from '../tool-permissions.js';

/** Stops the daemon automatically when no enabled jobs remain. */
function stopIfNoEnabledJobs(store: CronStore): void {
  const remaining = store.loadJobs().filter((j) => j.enabled);
  if (remaining.length === 0 && isDaemonRunning()) {
    stopDaemon();
    printInfo('No enabled jobs remain — daemon stopped.');
  }
}

/** Prompts the user for a yes/no confirmation via readline. Resolves `true` on "y". */
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

/** Lists all cron jobs with their status, schedule, and last-run info. */
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

  const enabled = jobs.filter((j) => j.enabled).length;
  const disabled = jobs.length - enabled;
  printInfo('');
  printInfo(`${jobs.length} job(s): ${enabled} enabled, ${disabled} disabled`);
}

/** Manually triggers an immediate execution of a cron job by ID, printing the result. */
export async function cronRun(id: string): Promise<void> {
  const store = new CronStore();
  const job = store.getJob(id);

  if (!job) {
    printError(`Job not found: ${id}`);
    process.exit(1);
    return;
  }

  if (job.lastRunStatus === 'running') {
    printError(
      `Job "${job.name}" is already running. Wait for it to finish or check status with cron-list.`,
    );
    process.exit(1);
    return;
  }

  if (!job.enabled) {
    printInfo('Note: this job is currently disabled.');
  }

  printInfo(`Running job "${job.name}" (${job.id})...`);

  const startTime = new Date().toISOString();
  store.updateJob(id, {
    lastRun: startTime,
    lastRunStatus: 'running',
  });

  try {
    const result = await runJob(job, (msg) => printInfo(`  ${msg}`));

    store.updateJob(id, {
      lastRunStatus: result.success ? 'success' : 'error',
      lastResult: result.output.slice(0, 2000),
    });

    if (result.success) {
      printInfo(`Job "${job.name}" completed successfully.`);
      printInfo(result.output);
    } else {
      printError(`Job "${job.name}" failed.`);
      printError(result.output);
      // A failed job must exit non-zero. Both this branch and the catch below
      // used to report the failure and then return normally, so `bernard
      // cron-run <id>` exited 0 for a job that did not run — invisible to any
      // script or CI step checking `$?`. `process.exitCode` rather than
      // `process.exit()` so the messages just written are flushed first.
      process.exitCode = 1;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    store.updateJob(id, {
      lastRunStatus: 'error',
      lastResult: message.slice(0, 2000),
    });
    printError(`Job "${job.name}" threw: ${message}`);
    process.exitCode = 1;
  }
}

/** Deletes one or more cron jobs (and their logs) after user confirmation. */
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
    deleteCronJob(job.id, { store, logStore });
    printInfo(`Deleted: ${job.name}`);
  }

  stopIfNoEnabledJobs(store);
}

/** Deletes all cron jobs and their logs after user confirmation, stopping the daemon if running. */
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

  const confirmed = await confirm(
    `Delete ALL ${jobs.length} job(s) and their logs? This cannot be undone. (y/N): `,
  );
  if (!confirmed) {
    printInfo('Cancelled.');
    return;
  }

  for (const job of jobs) {
    deleteCronJob(job.id, { store, logStore });
  }

  if (isDaemonRunning()) {
    stopDaemon();
    printInfo('Daemon stopped.');
  }

  printInfo(`Deleted ${jobs.length} job(s).`);
}

/** Stops the daemon (no args) or disables specific jobs by ID. Auto-stops the daemon if no enabled jobs remain. */
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

/** Restarts the daemon (no args) or bounces specific jobs by disabling then re-enabling them. */
export async function cronBounce(ids?: string[]): Promise<void> {
  if (!ids || ids.length === 0) {
    // Bounce the daemon
    const store = new CronStore();
    const enabled = store.loadJobs().filter((j) => j.enabled);

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

    // Brief delay to let the daemon process fully shut down before restarting
    await new Promise((resolve) => setTimeout(resolve, 500));

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

  // Brief delay to let the daemon pick up the disabled state before re-enabling
  await new Promise((resolve) => setTimeout(resolve, 500));

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

/**
 * Shows or sets the extra locations a job may write to (#340).
 *
 * **User-driven on purpose, and deliberately absent from the `cron` tool.**
 * Every job already gets its own workspace with no configuration; this grants
 * a location outside it. Exposing that to the model would let an agent widen
 * its own write scope, which is the escalation the whole gate exists to
 * prevent — a grant has to come from the person, not the process.
 */

export async function cronGrant(
  id: string,
  paths: string[],
  opts: { clear?: boolean; allow?: string[] } = {},
): Promise<void> {
  const store = new CronStore();
  const job = store.getJob(id);
  if (!job) {
    printError(`Job not found: ${id}`);
    process.exitCode = 1;
    return;
  }

  if (opts.clear) {
    store.updateJob(id, { writePaths: [], toolPermissions: [] });
    printInfo(`Cleared extra write paths and tool grants for "${job.name}".`);
    printInfo('It keeps its own workspace and the read-only shell allowlist.');
    return;
  }

  // `--allow shell:gh` — the precise lever, and the one that was missing.
  //
  // Cron denies every write-shaped shell command, so a job that needed
  // `gh issue create` could not be expressed: one real job spent ten scheduled
  // runs and 934,805 tokens discovering that, and there was no way to fix it
  // short of editing `jobs.json` by hand. `runGate` opens with
  // `if (grant === 'allow') return true`, so a rule scoped to one command
  // clears the confirm gate for THAT command only — where `confirmMode: 'off'`,
  // the other reachable knob, would dissolve every confirmation including
  // `rm -rf`.
  if (opts.allow && opts.allow.length > 0) {
    // `parseGrantSpec`, not a local copy. The copy dropped the validation
    // half — it minted `{tool: ''}` for `:foo` and `{tool:'gh'}` for `gh:` —
    // so a typo persisted a rule that matches nothing, unattended, which is
    // the shape of the very deny-loop `--allow` exists to end. The shared one
    // returns `null` for all three and the caller refuses.
    const parsed = opts.allow.map((a) => [a, parseGrantSpec(a, 'allow')] as const);
    const bad = parsed.filter(([, r]) => r === null).map(([a]) => a);
    if (bad.length > 0) {
      printError(`Not a tool spec: ${bad.join(', ')}`);
      printInfo("Expected `<tool>` or `<tool>:<specifier>`, e.g. 'shell:gh *'.");
      process.exitCode = 1;
      return;
    }
    const rules: PermissionRule[] = parsed.map(([, r]) => r as PermissionRule);
    store.updateJob(id, { toolPermissions: [...(job.toolPermissions ?? []), ...rules] });
    printInfo(`Job "${job.name}" may now run:`);
    for (const a of opts.allow) printInfo(`  ${a}`);
    printInfo('Nothing else changed — every other tool keeps its usual gate.');
    return;
  }

  if (paths.length === 0) {
    const current = job.writePaths ?? [];
    printInfo(`Job "${job.name}" (${job.id})`);
    // Says the retention out loud (#585): this is the one screen where a user
    // is told the workspace is theirs to write to, so it is where they have to
    // learn it is not permanent. A month idle and it goes — which for a live
    // job never happens, since every run stamps it.
    printInfo(`  Workspace: ${runWorkspace('cron', job.id)} (always writable)`);
    printInfo(
      `             removed after ${WORKSPACE_MAX_AGE_MS / 86_400_000} days without a run — grant a path below for anything durable`,
    );
    printInfo(
      current.length > 0
        ? `  Also granted:\n${current.map((p) => `    ${p}`).join('\n')}`
        : '  No extra write paths granted.',
    );
    // Printed beside the write paths because they answer one question — what
    // may this job do that it could not by default — and a grant the user
    // cannot see is one they cannot revoke.
    const tools = job.toolPermissions ?? [];
    printInfo(
      tools.length > 0
        ? `  Tools allowed:\n${tools.map((r) => `    ${r.tool}${r.specifier ? `:${r.specifier}` : ''}`).join('\n')}`
        : '  No extra tool grants.',
    );
    return;
  }

  // Stored resolved, so a grant made from one working directory still means
  // the same place later. A relative grant that silently re-anchors is the
  // kind of allowlist that reads as scoped and is not.
  const resolved = paths.map((p) => path.resolve(p));
  const missing = resolved.filter((p) => !fs.existsSync(p));
  for (const p of missing) {
    printInfo(`Note: ${p} does not exist yet — the grant still applies once it does.`);
  }

  store.updateJob(id, { writePaths: resolved });
  printInfo(`Job "${job.name}" may now also write to:`);
  for (const p of resolved) printInfo(`  ${p}`);
}
