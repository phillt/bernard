import * as fs from 'node:fs';
import * as path from 'node:path';
import { TOOL_PROFILES_DIR } from './paths.js';
import { atomicWriteFileSync, seedOnce } from './fs-utils.js';
import type { ToolErrorType } from './framework/tools/types.js';
import { detectResultFailure } from './tool-result-shape.js';

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
  /** Failure taxonomy category. Only correctable categories are stored. */
  category?: ToolErrorType;
}

export interface ToolProfile {
  toolName: string;
  category?: string;
  /**
   * The older profile key this one was seeded from, when a key rename carried
   * a learned history forward (#413).
   *
   * Recorded so the prompt builder can suppress the superseded profile without
   * deleting it: the legacy file stays on disk for rollback, but injecting both
   * would double-count a tool's history and spend the prompt budget twice.
   */
  supersedes?: string;
  guidelines: string[];
  goodExamples: ToolProfileExample[];
  badExamples: ToolProfileBadExample[];
  createdAt: string;
  updatedAt: string;
  errorCount: number;
  successCount: number;
  /**
   * Failures that were detected but **dismissed** as non-correctable, keyed by
   * taxonomy category (#366).
   *
   * `recordOutcome` only records a bad example — and only bumps `errorCount` —
   * when `classifyError(...).correctable`. Everything else hit a `debugLog` and
   * vanished: neither counter moved, so a tool that fails constantly in a way
   * the model cannot fix was indistinguishable from one that never fails.
   * `delegate_browser-control` read 36 successes / 0 errors across sessions
   * where its delegations demonstrably failed.
   *
   * Keyed by category rather than a bare total because the useful question is
   * *why* — a tool sitting at `{unknown: 47}` is evidence the taxonomy may be
   * too narrow for MCP-authored messages, which a single integer cannot show.
   *
   * Optional: profiles written before #366 simply lack it.
   */
  dismissed?: Record<string, number>;
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
 * Adapts the shared structural predicate (`detectResultFailure`) to the
 * `ToolErrorInfo` union.
 *
 * Every failure is decided by shape (#363): `shell`'s `{is_error}`, `file_*`'s
 * `{error}`, MCP's `CallToolResult.isError`, and the `"Error"`-prefixed string.
 * There are **no tool-name branches left** — `web_search` held the last one
 * until #364 taught it to emit the prefix, which also ended the one case where
 * this function and `augment`'s shape-only inline gate disagreed.
 *
 * `toolName` is retained for the ~30 call sites that pass it and because a
 * future convention may need it, but nothing reads it today. A follow-up could
 * reasonably inline this into `detectResultFailure`.
 */
export function detectToolError(_toolName: string, result: unknown): ToolErrorInfo {
  const snippet = detectResultFailure(result);
  return snippet === undefined ? { isError: false } : { isError: true, snippet };
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

  constructor(opts?: { seed?: boolean }) {
    this.ensureDir();
    if (opts?.seed !== false) this.seedDefaults();
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

  /**
   * The profile for `toolKey`, creating an empty one if none exists.
   *
   * `seedFrom` carries a learned history across a key rename. MCP tool keys
   * changed shape when tools were namespaced per server (#413), and the
   * profiles on disk — 109 on one real install, including `browser_click.json`
   * and `brave_search.json` — are keyed by the OLD bare name. Rather than
   * rewrite user data, a first create under the new key copies the old
   * profile's guidelines, examples and counters forward.
   *
   * The legacy file is deliberately left on disk: it costs nothing (the orphan
   * filter in {@link buildToolProfilesPrompt} keeps it out of the prompt) and
   * it makes the change rollback-safe.
   */
  getOrCreate(toolKey: string, opts: { seedFrom?: string } = {}): ToolProfile {
    const existing = this.get(toolKey);
    if (existing) return existing;
    const now = new Date().toISOString();
    const legacy = opts.seedFrom && opts.seedFrom !== toolKey ? this.get(opts.seedFrom) : undefined;
    if (legacy) {
      return {
        ...legacy,
        // Re-stamped, since `save()` derives the path from this field.
        toolName: toolKey,
        supersedes: opts.seedFrom,
        createdAt: now,
        updatedAt: now,
      };
    }
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

  /**
   * Ensures `toolKey` has a profile, seeding it from `seedFrom` the first time
   * if that legacy profile exists and this one does not yet.
   *
   * A single call rather than a `seedFrom` parameter on each of the four
   * `record*` methods: seeding is a one-shot migration concern and the record
   * methods should not each have to remember it. No-ops once the new profile
   * exists, which is after the first recorded outcome.
   */
  ensureSeeded(toolKey: string, seedFrom: string | undefined): void {
    if (!seedFrom || seedFrom === toolKey) return;
    if (this.get(toolKey)) return;
    const legacy = this.get(seedFrom);
    if (!legacy) return;
    this.save(this.getOrCreate(toolKey, { seedFrom }));
  }

  save(profile: ToolProfile): void {
    this.ensureDir();
    const updated = { ...profile, updatedAt: new Date().toISOString() };
    atomicWriteFileSync(this.filePath(profile.toolName), JSON.stringify(updated, null, 2));
  }

  recordBadExample(
    toolKey: string,
    args: string,
    errorSnippet: string,
    category?: ToolErrorType,
  ): void {
    const profile = this.getOrCreate(toolKey);
    const bad: ToolProfileBadExample = {
      summary: `Failed: ${args.slice(0, 80)}`,
      args: args.slice(0, 200),
      errorSnippet,
      fix: '(awaiting successful retry)',
      ...(category ? { category } : {}),
    };
    const updated = [...profile.badExamples, bad].slice(-MAX_PROFILE_EXAMPLES);
    this.save({ ...profile, badExamples: updated, errorCount: profile.errorCount + 1 });
  }

  /**
   * Increments `successCount` on a tool's profile without touching the
   * examples list. Called from `augment.ts` on every successful tool call so
   * the success/error ratio is observable. Distinct from `recordGoodExample`,
   * which both stores a sample and bumps the counter.
   */
  recordSuccess(toolKey: string): void {
    const profile = this.getOrCreate(toolKey);
    this.save({ ...profile, successCount: profile.successCount + 1 });
  }

  /**
   * Records a failure that was detected but is not a call-shape mistake, so
   * there is nothing for the model to learn (#366). Deliberately does NOT touch
   * `errorCount`, which is the count of failures that produced a bad example —
   * conflating them would make the learned-example ratio meaningless.
   */
  recordDismissed(toolKey: string, category: string): void {
    const profile = this.getOrCreate(toolKey);
    const dismissed = { ...(profile.dismissed ?? {}) };
    dismissed[category] = (dismissed[category] ?? 0) + 1;
    this.save({ ...profile, dismissed });
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

    try {
      seedOnce(markerPath, () => {
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
      });
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

/** Dismissed failures before a tool is called out as unreliable in the prompt. */
const UNRELIABLE_MIN_DISMISSED = 5;

/**
 * Session-frozen snapshot of each profile's dismissed totals.
 *
 * The system prompt is rebuilt **every turn** (`run.ts` calls
 * `def.systemPrompt` per dispatch) and is the Anthropic prompt-cache prefix
 * (#269). A live count would therefore change the cached prefix on every
 * dismissed failure — and dismissals are frequent, since every MCP, delegate
 * and sub-agent failure lands there — trading the ~90% cache discount for a
 * full re-bill of the whole prefix, repeatedly.
 *
 * Freezing at first use keeps the prefix byte-stable for the session while
 * still telling the model what it needs. Operators get the live numbers from
 * `bernard tool-profiles`, which reads disk directly.
 */
const dismissedSnapshot = new Map<string, number>();
let snapshotTaken = false;

/** Test seam — drops the session freeze so a suite can vary the input. */
export function _resetDismissedSnapshot(): void {
  dismissedSnapshot.clear();
  snapshotTaken = false;
}

function dismissedTotal(profile: ToolProfile): number {
  if (!snapshotTaken) return Object.values(profile.dismissed ?? {}).reduce((a, b) => a + b, 0);
  return dismissedSnapshot.get(profile.toolName) ?? 0;
}

/**
 * Renders the `## Tool Usage Profiles` block.
 *
 * A profile is included when it has a guideline, a bad example, **or** at least
 * {@link UNRELIABLE_MIN_DISMISSED} dismissed failures — that third arm is what
 * lets a tool with nothing learned about it still be reported as unreliable. At
 * most 2 bad examples are shown per tool; profiles are sorted by error count
 * (most errors first) and the block is capped at
 * {@link MAX_PROFILE_PROMPT_CHARS}.
 *
 * Filtered by `liveKeys` when the caller supplies it (#413) — see
 * {@link filterLiveProfiles}. This used to be unfiltered on the grounds that
 * telling an orphaned MCP profile from a built-in needed the `ToolMeta.category`
 * link proposed in #377, and that "the registry is not in scope here anyway".
 * The second half was simply wrong: the live call site is
 * `framework/agents/main.ts`, which has `ctx`. The first half is answered by
 * the `mcp.` key prefix, which namespacing made meaningful. Removing a server's
 * profiles from disk is still #377's job; this only stops them being injected.
 */
/**
 * Drops profiles that can no longer be acted on.
 *
 * Two kinds. A profile **superseded** by a rename (#413) is always dropped —
 * its history now lives under the new key, and injecting both would
 * double-count it. An `mcp.*` profile whose tool is not in `liveKeys` is
 * dropped when that set is supplied: after namespacing, every MCP profile
 * written under the old bare key names a tool the model can no longer call.
 *
 * This matters more than it looks. The block is NOT otherwise filtered by the
 * registry, and it sorts by `errorCount` descending — so a high-error orphan
 * outranks live tools and can crowd them out of `MAX_PROFILE_PROMPT_CHARS`.
 * Non-MCP profiles are left alone: `liveKeys` is a single dispatch's registry,
 * and a built-in absent from a worker surface is still a real tool elsewhere.
 */
function filterLiveProfiles(
  profiles: ToolProfile[],
  liveKeys?: ReadonlySet<string>,
): ToolProfile[] {
  const superseded = new Set(profiles.map((p) => p.supersedes).filter(Boolean) as string[]);
  return profiles.filter((p) => {
    if (superseded.has(p.toolName)) return false;
    if (!liveKeys || !p.toolName.startsWith('mcp.')) return true;
    return liveKeys.has(p.toolName.slice('mcp.'.length));
  });
}

export function buildToolProfilesPrompt(
  store: ToolProfileStore,
  opts: { liveKeys?: ReadonlySet<string> } = {},
): string {
  const all = filterLiveProfiles(store.list(), opts.liveKeys);
  if (!snapshotTaken) {
    for (const p of all) {
      dismissedSnapshot.set(
        p.toolName,
        Object.values(p.dismissed ?? {}).reduce((a, b) => a + b, 0),
      );
    }
    snapshotTaken = true;
  }

  const profiles = all
    .filter(
      (p) =>
        p.guidelines.length > 0 ||
        p.badExamples.length > 0 ||
        dismissedTotal(p) >= UNRELIABLE_MIN_DISMISSED,
    )
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

    const dismissed = dismissedTotal(profile);
    if (dismissed >= UNRELIABLE_MIN_DISMISSED) {
      // Actionable, unlike the raw count: the model cannot fix these calls, but
      // it can choose a different route or stop retrying the same one.
      sectionLines.push(
        `- Unreliable: ${dismissed} recent failure(s) here were environmental, not call-shape ` +
          `mistakes. Retrying the same call is unlikely to help — prefer an alternative tool or ` +
          `report the blocker.`,
      );
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
