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
import { parseShellCommand } from './shell-ast.js';
import {
  matchShellSpecifier,
  matchPathSpecifier,
  matchDomainSpecifier,
  matchMCPSpecifier,
} from './matchers.js';

export type GrantDecision = 'allow' | 'deny' | 'ask';

const FILE_TOOLS = new Set(['file_read_lines', 'file_edit_lines', 'file_write']);
const WEB_TOOLS = new Set(['web_read', 'web_search']);

/** Does a single rule cover a single simple shell command string? */
function ruleMatchesShell(rule: PermissionRule, command: string): boolean {
  if (rule.tool !== 'shell') return false;
  if (rule.specifier === undefined) return true;
  return matchShellSpecifier(rule.specifier, command);
}

/** Does a single rule cover this concrete (toolName, args) call? */
function ruleMatchesCall(rule: PermissionRule, toolName: string, args: unknown): boolean {
  if (rule.tool !== toolName) return false;
  if (rule.specifier === undefined) return true; // matches any invocation of the tool

  if (toolName === 'shell') {
    const cmd = (args as Record<string, unknown> | undefined)?.command;
    if (typeof cmd !== 'string') return false;
    const parsed = parseShellCommand(cmd);
    if (parsed.kind === 'simple') return matchShellSpecifier(rule.specifier, parsed.command);
    return false; // compound handled in resolveGrant; parse-error never matches
  }
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

export function resolveGrant(
  toolName: string,
  args: unknown,
  rules: PermissionRule[],
  isDangerousShell: boolean,
): GrantDecision {
  // Invariant: dangerous shell always re-prompts, no rule can override it.
  if (toolName === 'shell' && isDangerousShell) return 'ask';

  // Compound shell: every subcommand must independently resolve to allow, and
  // any subcommand that denies sinks the whole command (deny-first).
  if (toolName === 'shell') {
    const cmd = (args as Record<string, unknown> | undefined)?.command;
    if (typeof cmd === 'string') {
      const parsed = parseShellCommand(cmd);
      if (parsed.kind === 'compound') {
        let anyAsk = false;
        for (const sub of parsed.subcommands) {
          if (sub.kind !== 'simple') {
            anyAsk = true;
            continue;
          }
          const d = scanRules(rules, (rule) => ruleMatchesShell(rule, sub.command));
          if (d === 'deny') return 'deny';
          if (d !== 'allow') anyAsk = true;
        }
        return anyAsk ? 'ask' : 'allow';
      }
    }
  }

  return scanRules(rules, (rule) => ruleMatchesCall(rule, toolName, args));
}
