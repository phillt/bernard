import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const LOGS_DIR = path.join(os.homedir(), '.bernard', 'logs');
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const DEFAULT_KEEP = 500;

/** A single agent step captured during a cron job execution (one `generateText` iteration). */
export interface CronLogStep {
  stepIndex: number;
  timestamp: string;
  text: string;
  toolCalls: Array<{ toolName: string; toolCallId: string; args: Record<string, unknown> }>;
  toolResults: Array<{ toolName: string; toolCallId: string; result: unknown }>;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  finishReason: string;
}

/** Complete record of a single cron job run, including all agent steps and aggregate token usage. */
export interface CronLogEntry {
  runId: string;
  jobId: string;
  jobName: string;
  prompt: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  success: boolean;
  error?: string;
  finalOutput: string;
  steps: CronLogStep[];
  totalUsage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/**
 * Append-only JSONL log store for cron job execution history.
 *
 * Each job gets its own `{jobId}.jsonl` file under `~/.bernard/logs/`.
 * Files are automatically rotated when they exceed {@link MAX_FILE_SIZE}.
 */
export class CronLogStore {
  /** Ensures the logs directory exists on disk. */
  constructor() {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }

  /** Absolute path to `~/.bernard/logs/`. */
  static get logsDir(): string {
    return LOGS_DIR;
  }

  /** Returns the JSONL file path for a given job ID. */
  private logPath(jobId: string): string {
    return path.join(LOGS_DIR, `${jobId}.jsonl`);
  }

  /** Appends a log entry, auto-rotating the file if it exceeds the size limit. */
  appendEntry(entry: CronLogEntry): void {
    const filePath = this.logPath(entry.jobId);

    // Auto-rotate if file exceeds size limit
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_FILE_SIZE) {
        this.rotate(entry.jobId, DEFAULT_KEEP);
      }
    }

    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
  }

  /** Returns log entries for a job in newest-first order with pagination support. */
  getEntries(jobId: string, limit: number = 10, offset: number = 0): CronLogEntry[] {
    const filePath = this.logPath(jobId);
    if (!fs.existsSync(filePath)) return [];

    const lines = fs
      .readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim() !== '');

    // Newest first
    const reversed = lines.reverse();
    const sliced = reversed.slice(offset, offset + limit);

    return sliced
      .map((line) => {
        try {
          return JSON.parse(line) as CronLogEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is CronLogEntry => e !== null);
  }

  /** Finds a specific log entry by job ID and run ID. */
  getEntry(jobId: string, runId: string): CronLogEntry | undefined {
    const filePath = this.logPath(jobId);
    if (!fs.existsSync(filePath)) return undefined;

    const lines = fs
      .readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim() !== '');

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as CronLogEntry;
        if (entry.runId === runId) return entry;
      } catch {
        // skip corrupted lines
      }
    }

    return undefined;
  }

  /** Returns all job IDs that have log files on disk. */
  listJobIds(): string[] {
    if (!fs.existsSync(LOGS_DIR)) return [];
    return fs
      .readdirSync(LOGS_DIR)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace('.jsonl', ''));
  }

  /** Returns the total number of log entries for a job. */
  getEntryCount(jobId: string): number {
    const filePath = this.logPath(jobId);
    if (!fs.existsSync(filePath)) return 0;

    const content = fs.readFileSync(filePath, 'utf-8');
    return content.split('\n').filter((line) => line.trim() !== '').length;
  }

  /** Truncates a job's log file to the most recent `keep` entries. */
  rotate(jobId: string, keep: number = DEFAULT_KEEP): void {
    const filePath = this.logPath(jobId);
    if (!fs.existsSync(filePath)) return;

    const lines = fs
      .readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim() !== '');

    const kept = lines.slice(-keep);
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, kept.join('\n') + '\n', 'utf-8');
    fs.renameSync(tmp, filePath);
  }

  /** Deletes the entire log file for a job. Returns `false` if no log file existed. */
  deleteJobLogs(jobId: string): boolean {
    const filePath = this.logPath(jobId);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }
}
