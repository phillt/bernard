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

/** Permission key → grant. Persisted per-profile (`ProfileSettings.toolPermissions`). */
export type ToolPermissions = Record<string, ToolPermissionValue>;

/**
 * Characters that make a command line "complex": pipes, separators,
 * redirects (both directions), backticks, subshells, and newlines. Mirrors
 * shell.ts `META_RE` and deliberately adds `<` and `\r\n` — a multi-line
 * payload like `ls\nrm -rf /` must never classify as read-only `ls` or earn
 * an `ls`-keyed grant.
 */
const COMPLEX_RE = /[;&|`><\r\n]|\$\(/;

/**
 * Commands whose simple invocations only read. Deliberately conservative:
 * - no `find`/`sed`/`awk`/`xargs`/`sort` (write-capable via flags/exec)
 * - no `env`/`printenv` (dump secrets into model context)
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
  'echo',
  'printf',
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
 * The profile-permission key for a tool call, or `null` when no stable key
 * exists. `shell` keys per primary command (`shell:ls`); everything else
 * keys by tool name. A `null` key means "always allow" cannot be offered
 * for this call (the once/session options still apply).
 */
export function permissionKeyFor(toolName: string, args: unknown): string | null {
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
