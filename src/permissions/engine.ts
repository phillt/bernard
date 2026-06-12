/**
 * Deterministic permission rule engine (#261).
 *
 * `resolveGrant` evaluates an ordered `PermissionRule[]` against one concrete
 * tool call and returns `allow | deny | ask`, following the Claude-Code model:
 *
 *   1. Dangerous shell ALWAYS re-prompts (`ask`) before any rule is consulted —
 *      a breadth grant can never silence a genuinely dangerous invocation.
 *   2. Across all matching rules: any `deny` wins → `deny`; else any `ask`
 *      wins → `ask`; else any `allow` → `allow`; else (no match) → `ask`.
 *
 * Specifier matching is dispatched per tool family (shell / file / web / MCP).
 */

import type { PermissionRule } from '../tool-permissions.js';
import { parseShellCommand, type ParsedShell } from './shell-ast.js';
import {
  matchShellSpecifier,
  matchPathSpecifier,
  matchDomainSpecifier,
  matchMCPSpecifier,
  FILE_TOOLS,
  WEB_TOOLS,
} from './matchers.js';

export type GrantDecision = 'allow' | 'deny' | 'ask';

/** Does a rule cover a single simple shell command string? */
function ruleMatchesShell(rule: PermissionRule, command: string): boolean {
  if (rule.tool !== 'shell') return false;
  return rule.specifier === undefined || matchShellSpecifier(rule.specifier, command);
}

/** Does a rule cover a non-shell (toolName, args) call? */
function ruleMatchesNonShell(rule: PermissionRule, toolName: string, args: unknown): boolean {
  if (rule.tool !== toolName) return false;
  if (rule.specifier === undefined) return true; // matches any invocation of the tool
  if (FILE_TOOLS.has(toolName)) {
    const p = (args as Record<string, unknown> | undefined)?.path;
    return typeof p === 'string' && matchPathSpecifier(rule.specifier, p);
  }
  if (WEB_TOOLS.has(toolName)) {
    const u = (args as Record<string, unknown> | undefined)?.url;
    return typeof u === 'string' && matchDomainSpecifier(rule.specifier, u);
  }
  return matchMCPSpecifier(rule.specifier, args);
}

/** Scan rules for a single call; deny > ask > allow > (default) ask. */
function scanRules(
  rules: PermissionRule[],
  matchFn: (rule: PermissionRule) => boolean,
): GrantDecision {
  let hasAsk = false;
  let hasAllow = false;
  for (const rule of rules) {
    if (!matchFn(rule)) continue;
    if (rule.effect === 'deny') return 'deny'; // deny always wins
    if (rule.effect === 'ask') hasAsk = true;
    else if (rule.effect === 'allow') hasAllow = true;
  }
  if (hasAsk) return 'ask';
  if (hasAllow) return 'allow';
  return 'ask';
}

/**
 * Flattens a parsed shell command into its simple-subcommand strings, or `null`
 * when no specifier can safely cover it (parse-error / unhandled construct). A
 * simple command is the degenerate 1-element case, so the engine resolves
 * simple and compound commands through the same path.
 */
function shellSubcommands(parsed: ParsedShell): string[] | null {
  if (parsed.kind === 'simple') return [parsed.command];
  if (parsed.kind === 'compound') {
    const out: string[] = [];
    for (const sub of parsed.subcommands) {
      if (sub.kind !== 'simple') return null;
      out.push(sub.command);
    }
    return out;
  }
  return null; // parse-error
}

export function resolveGrant(
  toolName: string,
  args: unknown,
  rules: PermissionRule[],
  isDangerousShell: boolean,
): GrantDecision {
  if (toolName !== 'shell') {
    return scanRules(rules, (rule) => ruleMatchesNonShell(rule, toolName, args));
  }

  // Invariant: dangerous shell always re-prompts, no rule can override it.
  if (isDangerousShell) return 'ask';

  const cmd = (args as Record<string, unknown> | undefined)?.command;
  // Parse once. Each subcommand (simple = 1 element) is resolved independently;
  // the compound is allowed only when every subcommand allows, and any denied
  // subcommand sinks the whole command (deny-first). Parse-error / non-string
  // commands can only be covered by a no-specifier `shell` rule.
  const subs = typeof cmd === 'string' ? shellSubcommands(parseShellCommand(cmd)) : null;
  if (!subs) {
    return scanRules(rules, (rule) => rule.tool === 'shell' && rule.specifier === undefined);
  }
  let anyAsk = false;
  for (const sub of subs) {
    const d = scanRules(rules, (rule) => ruleMatchesShell(rule, sub));
    if (d === 'deny') return 'deny';
    if (d !== 'allow') anyAsk = true;
  }
  return anyAsk ? 'ask' : 'allow';
}
