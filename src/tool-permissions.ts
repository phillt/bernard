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
 * The read-only allowlist, rendered for a prompt.
 *
 * Exported so `cron.ts` can STATE the rule rather than describe it from
 * memory. It described it from memory, and had drifted into being false: it
 * promised that "dangerous commands (rm -rf, sudo, etc.)" are denied and that
 * "safe, read-oriented commands" run, while in fact `echo hello` is denied and
 * so is any line carrying a pipe, an `&&` or a redirect. A model told the old
 * sentence will reach for exactly the shapes that are refused.
 *
 * Same treatment as `APPLET_STYLED_SELECTORS`, and for the same reason: a
 * prompt that lists an artefact is a second copy of it, and copies do not fail,
 * they diverge. `cron.test.ts` pins the prompt against this.
 */
export function readOnlyShellSummary(): string {
  return [...READONLY_COMMANDS].sort().join(', ');
}

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
 * The action a call dispatches on, for tools declaring `ToolMeta.actionScoped`
 * (#322) — `null` for every other tool, and for a call whose `action` is
 * missing or not a non-empty string.
 *
 * The single reader of the discriminator: `permissionKeyFor` mints keys from
 * it, `breadthOptionsFor` mints `action:<value>` specifiers from it, and
 * `attachActionMeta`'s `isWriteAction` refines on it. Reading it off the meta
 * rather than a name list matters because the two can disagree.
 */
export function actionOf(args: unknown, meta?: { actionScoped?: boolean } | null): string | null {
  if (!meta?.actionScoped) return null;
  const value = (args as Record<string, unknown> | undefined)?.action;
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
  meta?: { actionScoped?: boolean } | null,
): string | null {
  if (meta?.actionScoped) {
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

/**
 * The `bernard cron-grant --allow` specifier that would actually clear this
 * call's gate, or `null` when no per-call grant can cover it.
 *
 * The sibling of {@link permissionKeyFor} and deliberately NOT the same string.
 * A key is an IDENTITY — what to show a user, what to store a decision under —
 * and printing one as a remedy was wrong for every shape it can take, verified
 * against the real `resolveGrant`:
 *
 * - `shell:gh` resolves to `ask`. `matchShellSpecifier` treats a specifier with
 *   no trailing `*` as an EXACT token match, so it covers a bare `gh` and not
 *   `gh issue create`, which is the only form anyone runs. `gh *` is a prefix
 *   match and covers both, so it strictly dominates the key.
 * - `cron:delete` resolves to `ask`. The engine's action arm requires the
 *   specifier itself to read `action:delete`, so through
 *   `parseGrantSpecifier`'s first-colon split the grant must be spelled
 *   `cron:action:delete`.
 * - A compound shell line has no key at all, and the message rendered that as
 *   `--allow this tool` — two bare words that word-split into grants for two
 *   tools that do not exist.
 *
 * `null` is therefore a real answer rather than a gap: `shellSubcommands`
 * returns `null` for a pipe, a redirect or an `&&`, so no SPECIFIER can ever
 * match one. The only grant that reaches such a call is the whole tool, which
 * is a broader thing to hand out and has to be named as one — see
 * {@link unattendedDenialMessage}, which is what puts this in front of a user.
 *
 * Every row above is pinned by `grant-spec.test.ts` driving the real engine,
 * because a remedy is a claim about what another module will do and the four
 * defects here were all of the form "looks right, resolves to `ask`".
 */
export function grantSpecFor(
  toolName: string,
  args: unknown,
  meta?: { actionScoped?: boolean } | null,
): string | null {
  if (meta?.actionScoped) {
    const action = actionOf(args, meta);
    return action ? `${toolName}:action:${action}` : null;
  }
  if (toolName === 'shell') {
    const cmd = (args as Record<string, unknown> | undefined)?.command;
    if (typeof cmd !== 'string') return null;
    const primary = primaryShellCommand(cmd);
    // Trailing `*` is the prefix form: it covers the bare command and every
    // invocation carrying arguments, which is what a job actually runs.
    return primary ? `shell:${primary} *` : null;
  }
  return toolName;
}

/**
 * The inverse of {@link grantSpecFor}: a typed `<tool>[:<specifier>]` argument
 * back into a rule, or `null` when it is not one.
 *
 * Here rather than in either CLI because it is the round trip's other half and
 * a `PermissionRule` is this module's type — and because the copy that lived in
 * `cron/cli.ts` had already dropped the validation: it minted `{tool: ''}` for
 * `:foo` and `{tool: 'gh'}` for `gh:`, persisting a rule that matches nothing
 * on the one path with no operator watching. Importing the app CLI's copy
 * instead would have pulled `AppRegistry` onto `bernard cron-grant`, measured
 * at 59 ms against 0 for this leaf.
 *
 * Only the FIRST colon splits, because an action-scoped specifier is itself
 * `action:<value>`. Deliberately NOT validated against the live registry: MCP
 * tool names depend on which servers happen to be connected, and refusing a
 * grant for one that is merely offline is worse than storing a rule that
 * matches nothing today.
 */
export function parseGrantSpec(spec: string, effect: ToolPermissionEffect): PermissionRule | null {
  const trimmed = spec.trim();
  if (trimmed === '') return null;
  const colon = trimmed.indexOf(':');
  if (colon === -1) return { effect, tool: trimmed, _v: 2 };
  const tool = trimmed.slice(0, colon);
  const specifier = trimmed.slice(colon + 1);
  if (tool === '' || specifier === '') return null;
  return { effect, tool, specifier, _v: 2 };
}
