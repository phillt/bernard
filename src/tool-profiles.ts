import * as fs from 'node:fs';
import * as path from 'node:path';
import { TOOL_PROFILES_DIR } from './paths.js';
import { atomicWriteFileSync } from './fs-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolProfileExample {
  summary: string;
  args: string;
  note?: string;
}

export interface ToolProfileBadExample {
  summary: string;
  args: string;
  errorSnippet: string;
  fix: string;
  note?: string;
}

export interface ToolProfile {
  toolName: string;
  category?: string;
  guidelines: string[];
  goodExamples: ToolProfileExample[];
  badExamples: ToolProfileBadExample[];
  createdAt: string;
  updatedAt: string;
  errorCount: number;
  successCount: number;
}

export const MAX_PROFILE_EXAMPLES = 5;

const SEED_MARKER = '.seeded-v1';

// ---------------------------------------------------------------------------
// Shell command classification
// ---------------------------------------------------------------------------

const SHELL_CATEGORIES: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /^\s*git\b/, category: 'git' },
  { pattern: /^\s*gh\b/, category: 'gh' },
  { pattern: /^\s*(docker|docker-compose)\b/, category: 'docker' },
  { pattern: /^\s*(npm|yarn|pnpm|bun)\b/, category: 'npm' },
  {
    pattern: /^\s*(ls|find|cp|mv|mkdir|rm|cat|head|tail|stat|chmod|chown|ln|du|df|wc)\b/,
    category: 'fs',
  },
  { pattern: /^\s*(curl|wget)\b/, category: 'http' },
  { pattern: /^\s*(systemctl|service|journalctl)\b/, category: 'systemd' },
  { pattern: /^\s*(python3?|node|ruby|perl|tsx|ts-node)\b/, category: 'runtime' },
];

/** Classifies a shell command string into a sub-category for profile lookup. */
export function classifyShellCommand(command: string): string {
  for (const { pattern, category } of SHELL_CATEGORIES) {
    if (pattern.test(command)) return category;
  }
  return 'general';
}

// ---------------------------------------------------------------------------
// Error detection
// ---------------------------------------------------------------------------

export type ToolErrorInfo = { isError: true; snippet: string } | { isError: false };

/**
 * Detects whether a tool's return value indicates an error. Each tool has a
 * different error shape so we normalize them into a single discriminated union.
 */
export function detectToolError(toolName: string, result: unknown): ToolErrorInfo {
  if (result === null || result === undefined) return { isError: false };

  // shell: { output: string, is_error: boolean }
  if (toolName === 'shell' && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (r.is_error === true) {
      return { isError: true, snippet: String(r.output ?? '').slice(0, 200) };
    }
    return { isError: false };
  }

  // web_read: returns string starting with "Error:"
  if (toolName === 'web_read' && typeof result === 'string') {
    if (result.startsWith('Error:')) {
      return { isError: true, snippet: result.slice(0, 200) };
    }
    return { isError: false };
  }

  // web_search: provider failures / no-result diagnostics are returned as strings
  if (toolName === 'web_search' && typeof result === 'string') {
    if (result.startsWith('web_search returned no results')) {
      return { isError: true, snippet: result.slice(0, 200) };
    }
    return { isError: false };
  }

  // file_read_lines, file_edit_lines: { error: string }
  if (
    (toolName === 'file_read_lines' || toolName === 'file_edit_lines') &&
    typeof result === 'object'
  ) {
    const r = result as Record<string, unknown>;
    if (typeof r.error === 'string') {
      return { isError: true, snippet: r.error.slice(0, 200) };
    }
    return { isError: false };
  }

  // Generic fallback for MCP and unknown tools: string starting with "Error"
  if (typeof result === 'string' && result.startsWith('Error')) {
    return { isError: true, snippet: result.slice(0, 200) };
  }

  return { isError: false };
}

// ---------------------------------------------------------------------------
// Seeded profiles
// ---------------------------------------------------------------------------

const SEEDED_PROFILES: Record<string, Pick<ToolProfile, 'guidelines' | 'goodExamples'>> = {
  'shell.git': {
    guidelines: [
      'Always check `git status` before destructive operations.',
      'Use `--oneline` for compact log output.',
      'Prefer `git log main..HEAD` to see branch-only commits.',
    ],
    goodExamples: [
      {
        summary: 'Log branch commits vs main',
        args: '{"command":"git log --oneline main..HEAD"}',
      },
    ],
  },
  'shell.gh': {
    guidelines: [
      'Use `gh issue list --json` for machine-parseable output.',
      'Always pass `--repo owner/repo` when context is ambiguous.',
    ],
    goodExamples: [],
  },
  'shell.docker': {
    guidelines: [
      'Prefer `docker compose` (v2) over `docker-compose` (v1).',
      'Use `--format json` with inspect commands for reliable parsing.',
    ],
    goodExamples: [],
  },
  'shell.npm': {
    guidelines: [
      'Use `--json` flag where available for structured output.',
      'Prefer `npm ci` over `npm install` in CI/scripts for reproducibility.',
    ],
    goodExamples: [],
  },
  'shell.fs': {
    guidelines: [
      'Quote all paths to handle spaces.',
      'Use `find -print0 | xargs -0` for filenames with spaces/newlines.',
      'Prefer `file_read_lines`/`file_edit_lines` over `cat`/`sed` for reading and editing files.',
    ],
    goodExamples: [],
  },
  'shell.http': {
    guidelines: [
      'Use `-s` (silent) with curl to suppress progress bars.',
      'Always set a timeout with `-m` or `--max-time` to avoid hangs.',
    ],
    goodExamples: [],
  },
  web_read: {
    guidelines: [
      'Always pass a CSS selector to scope large pages.',
      'URL must start with http:// or https://.',
    ],
    goodExamples: [
      {
        summary: 'Fetch docs with article selector',
        args: '{"url":"https://example.com/docs","selector":"article"}',
      },
    ],
  },
  file_read_lines: {
    guidelines: [
      'Use offset+limit to paginate files larger than ~200 lines.',
      'Always read before editing to get current line numbers.',
    ],
    goodExamples: [],
  },
  file_edit_lines: {
    guidelines: [
      'Read first with file_read_lines to get exact line numbers — they shift after edits.',
      'Edits are atomic: all operations succeed or all revert.',
    ],
    goodExamples: [],
  },
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class ToolProfileStore {
  private dirReady = false;

  constructor() {
    this.ensureDir();
    this.seedDefaults();
  }

  private ensureDir(): void {
    if (this.dirReady) return;
    fs.mkdirSync(TOOL_PROFILES_DIR, { recursive: true });
    this.dirReady = true;
  }

  private filePath(toolKey: string): string {
    const safe = toolKey.replace(/[^a-zA-Z0-9._-]/g, '-');
    return path.join(TOOL_PROFILES_DIR, `${safe}.json`);
  }

  get(toolKey: string): ToolProfile | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.filePath(toolKey), 'utf-8')) as ToolProfile;
    } catch {
      return undefined;
    }
  }

  getOrCreate(toolKey: string): ToolProfile {
    const existing = this.get(toolKey);
    if (existing) return existing;
    const now = new Date().toISOString();
    return {
      toolName: toolKey,
      guidelines: [],
      goodExamples: [],
      badExamples: [],
      createdAt: now,
      updatedAt: now,
      errorCount: 0,
      successCount: 0,
    };
  }

  save(profile: ToolProfile): void {
    this.ensureDir();
    const updated = { ...profile, updatedAt: new Date().toISOString() };
    atomicWriteFileSync(this.filePath(profile.toolName), JSON.stringify(updated, null, 2));
  }

  recordBadExample(toolKey: string, args: string, errorSnippet: string): void {
    const profile = this.getOrCreate(toolKey);
    const bad: ToolProfileBadExample = {
      summary: `Failed: ${args.slice(0, 80)}`,
      args: args.slice(0, 200),
      errorSnippet,
      fix: '(awaiting successful retry)',
    };
    const updated = [...profile.badExamples, bad].slice(-MAX_PROFILE_EXAMPLES);
    this.save({ ...profile, badExamples: updated, errorCount: profile.errorCount + 1 });
  }

  recordGoodExample(toolKey: string, args: string, note?: string): void {
    const profile = this.getOrCreate(toolKey);
    const good: ToolProfileExample = {
      summary: 'Successful call',
      args: args.slice(0, 200),
      note,
    };
    const updated = [...profile.goodExamples, good].slice(-MAX_PROFILE_EXAMPLES);
    this.save({ ...profile, goodExamples: updated, successCount: profile.successCount + 1 });
  }

  /**
   * After a bad example with `fix === '(awaiting successful retry)'`, if the
   * same tool key succeeds, patch the most recent unfixed bad example with the
   * working args.
   */
  patchLastBadWithFix(toolKey: string, workingArgs: string): void {
    const profile = this.get(toolKey);
    if (!profile || profile.badExamples.length === 0) return;
    const bads = [...profile.badExamples];
    const last = bads[bads.length - 1];
    if (last.fix === '(awaiting successful retry)') {
      bads[bads.length - 1] = { ...last, fix: `Use instead: ${workingArgs.slice(0, 200)}` };
      this.save({ ...profile, badExamples: bads });
    }
  }

  list(): ToolProfile[] {
    try {
      return fs
        .readdirSync(TOOL_PROFILES_DIR)
        .filter((f) => f.endsWith('.json'))
        .flatMap((f) => {
          try {
            return [
              JSON.parse(fs.readFileSync(path.join(TOOL_PROFILES_DIR, f), 'utf-8')) as ToolProfile,
            ];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }

  private seedDefaults(): void {
    const markerPath = path.join(TOOL_PROFILES_DIR, SEED_MARKER);
    if (fs.existsSync(markerPath)) return;

    try {
      const now = new Date().toISOString();
      for (const [toolKey, seed] of Object.entries(SEEDED_PROFILES)) {
        if (this.get(toolKey)) continue;
        const profile: ToolProfile = {
          toolName: toolKey,
          guidelines: seed.guidelines,
          goodExamples: seed.goodExamples,
          badExamples: [],
          createdAt: now,
          updatedAt: now,
          errorCount: 0,
          successCount: 0,
        };
        this.save(profile);
      }
      fs.writeFileSync(markerPath, now, 'utf-8');
    } catch {
      // best-effort; never block startup
    }
  }
}

// ---------------------------------------------------------------------------
// System prompt rendering
// ---------------------------------------------------------------------------

/**
 * Approximate character budget for the rendered profiles block. At ~4 chars/token
 * this gives ~1000 tokens — enough for guidance without crowding the context.
 * Profiles are sorted by error count (highest first) so the most valuable
 * guidance survives when the budget is tight.
 */
export const MAX_PROFILE_PROMPT_CHARS = 4000;

/**
 * Renders tool profiles into a compact system-prompt block. Only profiles with
 * at least one guideline or bad example are included. At most 2 bad examples
 * shown per tool. Profiles are sorted by error count (most errors first) and
 * the total output is capped at {@link MAX_PROFILE_PROMPT_CHARS}.
 */
export function buildToolProfilesPrompt(store: ToolProfileStore): string {
  const profiles = store
    .list()
    .filter((p) => p.guidelines.length > 0 || p.badExamples.length > 0)
    .sort((a, b) => b.errorCount - a.errorCount);

  if (profiles.length === 0) return '';

  const header = '## Tool Usage Profiles\n\nThe following notes apply when calling these tools:\n';
  let totalChars = header.length;
  const sections: string[] = [header];

  for (const profile of profiles) {
    const label = profile.toolName.startsWith('shell.')
      ? `shell (${profile.toolName.slice(6)} commands)`
      : profile.toolName;
    const sectionLines: string[] = [`### ${label}`];

    for (const g of profile.guidelines) {
      sectionLines.push(`- ${g}`);
    }

    const shownBad = profile.badExamples.slice(-2);
    if (shownBad.length > 0) {
      sectionLines.push('');
      sectionLines.push('Avoid these patterns (observed errors):');
      for (const b of shownBad) {
        sectionLines.push(`- BAD: ${b.args} -> Error: ${b.errorSnippet}`);
        if (b.fix && b.fix !== '(awaiting successful retry)') {
          sectionLines.push(`  FIX: ${b.fix}`);
        }
      }
    }
    sectionLines.push('');

    const section = sectionLines.join('\n');
    if (totalChars + section.length > MAX_PROFILE_PROMPT_CHARS) break;
    totalChars += section.length;
    sections.push(section);
  }

  // Only the header — nothing fit the budget (unlikely but safe)
  if (sections.length <= 1) return '';

  return sections.join('\n');
}
