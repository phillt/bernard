/**
 * Profile-scoped tool-permission keys and read-only shell classification
 * (issue #212).
 *
 * Two related concerns live here because they share the same minimal shell
 * parser:
 *
 * 1. **Permission keys** — the stable identifier a profile grant is stored
 *    under (`toolPermissions` in the active profile's settings). Plain tools
 *    (including MCP `server__tool` names — stable per server config) key by
 *    tool name; `shell` keys by primary command (`shell:ls`) so a grant on
 *    `ls` doesn't silently allow `rm`. Complex command lines (pipes,
 *    redirects, subshells, newlines) have no stable key → `null`, and the
 *    confirmation dialogs hide the "always allow" option for them.
 *
 * 2. **Read-only shell classification** — a conservative allowlist of
 *    commands whose simple invocations are read-shaped. The shell tool's
 *    `meta.isWriteAction` delegates here so `ls`/`git status` drop to low
 *    risk (no confirm prompt) and pass the read-only-mode block gate, while
 *    anything complex or unknown keeps the historic dangerous/high behavior.
 *
 * This module must not import from `src/tools/shell.ts` — shell.ts imports
 * from here, and the dependency must stay one-way.
 */

export type ToolPermissionValue = 'allow' | 'deny';

/** Permission key → grant. Legacy v1 shape (still read from disk + migrated). */
export type ToolPermissions = Record<string, ToolPermissionValue>;

/**
 * Permission-rule effects (#261). `allow`/`deny` mirror the legacy grant
 * values; `ask` forces a prompt even when a broader allow would otherwise
 * match (used for the dangerous-command floor and explicit user "ask" rules).
 */
export type ToolPermissionEffect = 'allow' | 'deny' | 'ask';

/**
 * A single profile-scoped permission rule (#261) — the deterministic,
 * Claude-Code-style grant unit that carries both axes: which tool (and how
 * broadly, via `specifier`) and what effect.
 */
export interface PermissionRule {
  effect: ToolPermissionEffect;
  /** Tool name: `shell`, `web_read`, `server__tool`, etc. */
  tool: string;
  /**
   * Scope/breadth pattern. **Absent** = matches ANY invocation of the tool.
   * - `shell`: a glob like `git` (exact, no args) or `git *` (any args)
   * - `file_*`: a gitignore-style path pattern (`*` = one segment, `**` = recursive)
   * - `web_*`: `domain:example.com` or an exact URL
   * - MCP / other: `*` (any args) or an exact-args JSON string
   */
  specifier?: string;
  /** Schema-version discriminant so migration can tell v2 rules from a v1 blob. */
  _v: 2;
}

/** Ordered rule list. Persisted per-profile (`ProfileSettings.toolPermissions`). */
export type ToolPermissionRules = PermissionRule[];

/**
 * Prototype-pollution keys: no legitimate tool name is named `__proto__` /
 * `constructor` / `prototype`, and assigning them onto a plain object can
 * rewire its prototype.
 */
export const FORBIDDEN_PERMISSION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isValidRule(r: unknown): r is PermissionRule {
  if (!r || typeof r !== 'object') return false;
  const rule = r as Record<string, unknown>;
  if (rule.effect !== 'allow' && rule.effect !== 'deny' && rule.effect !== 'ask') return false;
  if (typeof rule.tool !== 'string' || rule.tool.length === 0) return false;
  if (FORBIDDEN_PERMISSION_KEYS.has(rule.tool)) return false;
  if (rule.specifier !== undefined) {
    // Reject empty/whitespace specifiers: they never match yet would render as
    // "(any args)", a misleading persisted rule. Drop them during sanitization.
    if (typeof rule.specifier !== 'string' || rule.specifier.trim() === '') return false;
  }
  return true;
}

function normalizeRule(r: PermissionRule): PermissionRule {
  // Drop any extra fields a hand-edited file may carry; re-stamp `_v`.
  return r.specifier === undefined
    ? { effect: r.effect, tool: r.tool, _v: 2 }
    : { effect: r.effect, tool: r.tool, specifier: r.specifier, _v: 2 };
}

/**
 * Converts a legacy v1 key (`shell:ls` or a bare tool name) into a v2 rule.
 * `shell:<primary>` becomes `{ tool: 'shell', specifier: '<primary> *' }` to
 * preserve the legacy "any args to that command" semantics (the v1 key matched
 * regardless of the command's arguments).
 */
function ruleFromLegacyKey(key: string, effect: ToolPermissionValue): PermissionRule {
  if (key.startsWith('shell:')) {
    const primary = key.slice('shell:'.length);
    return { effect, tool: 'shell', specifier: `${primary} *`, _v: 2 };
  }
  return { effect, tool: key, _v: 2 };
}

/**
 * Lazily migrates a stored `toolPermissions` value (v1 object or v2 array)
 * into a `PermissionRule[]`. Non-destructive — callers persist the v2 form on
 * the next save, so a v1 file remains readable for rollback until then.
 */
export function migrateToolPermissions(
  raw: ToolPermissions | ToolPermissionRules | undefined | null,
): PermissionRule[] {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return raw.filter(isValidRule).map(normalizeRule);
  if (typeof raw !== 'object') return [];
  const out: PermissionRule[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (FORBIDDEN_PERMISSION_KEYS.has(key)) continue;
    if (value !== 'allow' && value !== 'deny') continue;
    out.push(ruleFromLegacyKey(key, value));
  }
  return out;
}

/**
 * Validates + migrates an untrusted stored value into a `PermissionRule[]`.
 * Accepts both the legacy v1 object and the v2 array shape; drops malformed
 * entries so a hand-edited profiles.json can't smuggle garbage into the gates.
 */
export function sanitizePermissionRules(raw: unknown): PermissionRule[] {
  return migrateToolPermissions(raw as ToolPermissions | ToolPermissionRules | undefined);
}

/** Human label for a rule in `/tool-permissions` and dialogs. */
export function ruleLabel(rule: PermissionRule): string {
  // Explicit undefined check: only a truly absent specifier is "(any args)".
  return rule.specifier !== undefined
    ? `${rule.tool} ${rule.specifier}`
    : `${rule.tool} (any args)`;
}

/**
 * Characters that make a command line "complex": pipes, separators,
 * redirects (both directions), backticks, `$` (subshells AND variable
 * expansion — `echo $TOKEN` must not classify as read-only or earn a
 * stable grant, since expansion can exfiltrate env secrets), and newlines.
 * Mirrors shell.ts `META_RE` and deliberately adds `<`, `$`, and `\r\n` —
 * a multi-line payload like `ls\nrm -rf /` must never classify as
 * read-only `ls` or earn an `ls`-keyed grant.
 */
const COMPLEX_RE = /[;&|`><$\r\n]/;

/**
 * Commands whose simple invocations only read. Deliberately conservative:
 * - no `find`/`sed`/`awk`/`xargs`/`sort` (write-capable via flags/exec)
 * - no `env`/`printenv` (dump secrets into model context)
 * - no `echo`/`printf` (expansion printers — `echo $TOKEN` is env
 *   exfiltration, not filesystem inspection)
 * - no pagers (`less`, `more`) — they hang a non-interactive shell
 */
const READONLY_COMMANDS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'pwd',
  'wc',
  'stat',
  'du',
  'df',
  'file',
  'which',
  'whoami',
  'uname',
  'date',
  'id',
  'hostname',
  'uptime',
  'ps',
  'free',
  'grep',
  'rg',
  'tree',
  'realpath',
  'dirname',
  'basename',
  'readlink',
  'diff',
  'cmp',
  'nl',
  'md5sum',
  'sha256sum',
]);

/**
 * Read-only git subcommands. Excludes bare `branch`/`tag`/`remote`/`stash` —
 * each lists when bare but writes with args, and a first-two-token check
 * can't tell the difference safely.
 */
const GIT_READ_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'shortlog',
  'describe',
  'rev-parse',
  'ls-files',
  'reflog',
]);

/**
 * Extracts the primary command (first whitespace token) from a shell command
 * line, or `null` when no stable primary exists: empty input, complex lines
 * (see {@link COMPLEX_RE}), or a leading `VAR=value` env-assignment prefix.
 */
export function primaryShellCommand(command: string): string | null {
  if (!command) return null;
  const trimmed = command.trim();
  if (!trimmed || COMPLEX_RE.test(trimmed)) return null;
  const first = trimmed.split(/\s+/)[0];
  if (!first || first.includes('=')) return null;
  return first;
}

/**
 * The action a call dispatches on, for tools that declare a discriminator via
 * `ToolMeta.actionArg` (#322) — `null` for every other tool, and for a call
 * whose discriminator is missing or not a string.
 *
 * Reading it off the meta rather than a name list matters because the two can
 * disagree: the meta is what the tool itself declares, and it is the same field
 * `isWriteAction` already refines on.
 */
export function actionOf(args: unknown, meta?: { actionArg?: string } | null): string | null {
  if (!meta?.actionArg) return null;
  const value = (args as Record<string, unknown> | undefined)?.[meta.actionArg];
  return typeof value === 'string' && value ? value : null;
}

/**
 * The profile-permission key for a tool call, or `null` when no stable key
 * exists. `shell` keys per primary command (`shell:ls`); a tool that declares
 * `ToolMeta.actionArg` keys per action (`cron:delete`), so an "always allow"
 * granted while listing jobs cannot authorise deleting them; everything else
 * keys by tool name. A `null` key means "always allow" cannot be offered for
 * this call (the once/session options still apply).
 *
 * `meta` is the tool's own {@link ToolMeta}. Callers already hold it — both
 * augment gates call `readToolMeta(toolDef)` on the line above — so passing it
 * costs no new plumbing. Omitting it degrades to name keying, which is the
 * correct answer for every tool that declares no discriminator.
 */
export function permissionKeyFor(
  toolName: string,
  args: unknown,
  meta?: { actionArg?: string } | null,
): string | null {
  if (meta?.actionArg) {
    const action = actionOf(args, meta);
    // No readable action → no stable key, so no profile grant is offered.
    // Fail-closed: the user is asked rather than handed an over-broad option.
    return action ? `${toolName}:${action}` : null;
  }
  if (toolName === 'shell') {
    if (args && typeof args === 'object') {
      const cmd = (args as Record<string, unknown>).command;
      if (typeof cmd === 'string') {
        const primary = primaryShellCommand(cmd);
        return primary ? `shell:${primary}` : null;
      }
    }
    return null;
  }
  return toolName;
}

/**
 * True when `command` is a simple invocation of a known read-only command.
 * Complex lines are never read-only — `COMPLEX_RE` rejects pipes/redirects/
 * subshells/newlines before the allowlist is consulted.
 */
export function isReadOnlyShellInvocation(command: string): boolean {
  const primary = primaryShellCommand(command);
  if (!primary) return false;
  if (primary === 'git') {
    const sub = command.trim().split(/\s+/)[1];
    return sub !== undefined && GIT_READ_SUBCOMMANDS.has(sub);
  }
  return READONLY_COMMANDS.has(primary);
}

/**
 * Human label for a permission key in dialogs/menus: `shell:ls` → `ls`,
 * anything else verbatim.
 */
export function permissionKeyLabel(key: string): string {
  return key.startsWith('shell:') ? key.slice('shell:'.length) : key;
}
