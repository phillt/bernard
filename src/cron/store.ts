import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type { CronJob, CronAlert } from './types.js';

const CRON_DIR = path.join(os.homedir(), '.bernard', 'cron');
const JOBS_FILE = path.join(CRON_DIR, 'jobs.json');
const ALERTS_DIR = path.join(CRON_DIR, 'alerts');
const PID_FILE = path.join(CRON_DIR, 'daemon.pid');
const LOG_FILE = path.join(CRON_DIR, 'daemon.log');

const MAX_JOBS = 50;

/**
 * Disk-backed store for cron jobs and alerts under `~/.bernard/cron/`.
 *
 * Jobs are persisted as a single `jobs.json` array; alerts are individual
 * JSON files inside `alerts/`. All writes use atomic rename to prevent
 * partial-read corruption when the daemon `fs.watch`es for changes.
 */
export class CronStore {
  /** Ensures the cron and alerts directories and `jobs.json` exist on disk. */
  constructor() {
    fs.mkdirSync(CRON_DIR, { recursive: true });
    fs.mkdirSync(ALERTS_DIR, { recursive: true });
    // Ensure jobs.json exists so daemon can fs.watch it
    if (!fs.existsSync(JOBS_FILE)) {
      this.atomicWrite(JOBS_FILE, '[]');
    }
  }

  // --- Paths ---

  /** Absolute path to `~/.bernard/cron/`. */
  static get cronDir(): string {
    return CRON_DIR;
  }
  /** Absolute path to `~/.bernard/cron/jobs.json`. */
  static get jobsFile(): string {
    return JOBS_FILE;
  }
  /** Absolute path to `~/.bernard/cron/alerts/`. */
  static get alertsDir(): string {
    return ALERTS_DIR;
  }
  /** Absolute path to `~/.bernard/cron/daemon.pid`. */
  static get pidFile(): string {
    return PID_FILE;
  }
  /** Absolute path to `~/.bernard/cron/daemon.log`. */
  static get logFile(): string {
    return LOG_FILE;
  }

  // --- Jobs ---

  /** Reads and parses all jobs from `jobs.json`, returning an empty array on missing or corrupt file. */
  loadJobs(): CronJob[] {
    if (!fs.existsSync(JOBS_FILE)) return [];
    const raw = fs.readFileSync(JOBS_FILE, 'utf-8');
    try {
      return JSON.parse(raw) as CronJob[];
    } catch {
      return [];
    }
  }

  /** Atomically writes the full jobs array to `jobs.json`. */
  saveJobs(jobs: CronJob[]): void {
    this.atomicWrite(JOBS_FILE, JSON.stringify(jobs, null, 2));
  }

  /** Returns a single job by ID, or `undefined` if not found. */
  getJob(id: string): CronJob | undefined {
    return this.loadJobs().find((j) => j.id === id);
  }

  /**
   * Creates a new cron job and persists it.
   *
   * @throws {Error} If the maximum number of jobs ({@link MAX_JOBS}) has been reached.
   */
  createJob(name: string, schedule: string, prompt: string): CronJob {
    const jobs = this.loadJobs();
    if (jobs.length >= MAX_JOBS) {
      throw new Error(`Maximum of ${MAX_JOBS} cron jobs reached.`);
    }
    const job: CronJob = {
      id: crypto.randomUUID(),
      name,
      schedule,
      prompt,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    jobs.push(job);
    this.saveJobs(jobs);
    return job;
  }

  /**
   * Applies partial updates to an existing job and persists the result.
   *
   * @returns The updated job, or `undefined` if the ID was not found.
   */
  updateJob(
    id: string,
    updates: Partial<
      Pick<
        CronJob,
        'name' | 'schedule' | 'prompt' | 'enabled' | 'lastRun' | 'lastRunStatus' | 'lastResult'
      >
    >,
  ): CronJob | undefined {
    const jobs = this.loadJobs();
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx === -1) return undefined;
    Object.assign(jobs[idx], updates);
    this.saveJobs(jobs);
    return jobs[idx];
  }

  /** Removes a job by ID. Returns `true` if the job existed and was deleted. */
  deleteJob(id: string): boolean {
    const jobs = this.loadJobs();
    const filtered = jobs.filter((j) => j.id !== id);
    if (filtered.length === jobs.length) return false;
    this.saveJobs(filtered);
    return true;
  }

  // --- Alerts ---

  /** Creates a new alert file in the alerts directory with auto-generated ID and timestamp. */
  createAlert(alert: Omit<CronAlert, 'id' | 'timestamp' | 'acknowledged'>): CronAlert {
    const full: CronAlert = {
      ...alert,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      acknowledged: false,
    };
    const filePath = path.join(ALERTS_DIR, `${full.id}.json`);
    this.atomicWrite(filePath, JSON.stringify(full, null, 2));
    return full;
  }

  /** Returns a single alert by ID, or `undefined` if not found or corrupt. */
  getAlert(id: string): CronAlert | undefined {
    const filePath = path.join(ALERTS_DIR, `${id}.json`);
    if (!fs.existsSync(filePath)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as CronAlert;
    } catch {
      return undefined;
    }
  }

  /** Returns all alerts sorted newest-first, skipping any corrupt files. */
  listAlerts(): CronAlert[] {
    if (!fs.existsSync(ALERTS_DIR)) return [];
    const files = fs.readdirSync(ALERTS_DIR).filter((f) => f.endsWith('.json'));
    const alerts: CronAlert[] = [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(ALERTS_DIR, file), 'utf-8');
        alerts.push(JSON.parse(raw) as CronAlert);
      } catch {
        // skip corrupted alert files
      }
    }
    return alerts.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  /** Marks an alert as acknowledged. Returns `false` if the alert was not found. */
  acknowledgeAlert(id: string): boolean {
    const alert = this.getAlert(id);
    if (!alert) return false;
    alert.acknowledged = true;
    const filePath = path.join(ALERTS_DIR, `${id}.json`);
    this.atomicWrite(filePath, JSON.stringify(alert, null, 2));
    return true;
  }

  // --- Utility ---

  /** Writes data to a `.tmp` file then renames it into place for crash-safe persistence. */
  private atomicWrite(filePath: string, data: string): void {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, data, 'utf-8');
    fs.renameSync(tmp, filePath);
  }
}
