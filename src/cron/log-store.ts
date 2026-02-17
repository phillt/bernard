import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const LOGS_DIR = path.join(os.homedir(), '.bernard', 'logs');
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const DEFAULT_KEEP = 500;

export interface CronLogStep {
  stepIndex: number;
  timestamp: string;
  text: string;
  toolCalls: Array<{ toolName: string; toolCallId: string; args: Record<string, unknown> }>;
  toolResults: Array<{ toolName: string; toolCallId: string; result: unknown }>;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  finishReason: string;
}

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

export class CronLogStore {
  constructor() {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }

  static get logsDir(): string {
    return LOGS_DIR;
  }

  private logPath(jobId: string): string {
    return path.join(LOGS_DIR, `${jobId}.jsonl`);
  }

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

  listJobIds(): string[] {
    if (!fs.existsSync(LOGS_DIR)) return [];
    return fs
      .readdirSync(LOGS_DIR)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace('.jsonl', ''));
  }

  getEntryCount(jobId: string): number {
    const filePath = this.logPath(jobId);
    if (!fs.existsSync(filePath)) return 0;

    const content = fs.readFileSync(filePath, 'utf-8');
    return content.split('\n').filter((line) => line.trim() !== '').length;
  }

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

  deleteJobLogs(jobId: string): boolean {
    const filePath = this.logPath(jobId);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }
}
