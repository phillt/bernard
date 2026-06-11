/**
 * Shell command parsing for the permission engine (#261).
 *
 * Phase 1B ships a deliberately conservative REGEX STUB: a command is either a
 * single simple invocation (no shell metacharacters) or `parse-error`. Anything
 * with pipes / separators / redirects / subshells / `$` expansion / newlines
 * (`COMPLEX_RE`) is `parse-error`, which the engine treats as "no specifier can
 * safely cover this" — matching the legacy behavior where complex commands got
 * a null permission key and always prompted.
 *
 * Phase 5 replaces this with a real tree-sitter-bash AST: compound-command
 * splitting (each subcommand checked independently), fail-closed on unhandled
 * node types, and exec-wrapper blocking.
 */

import { primaryShellCommand } from '../tool-permissions.js';

export type ParsedShell =
  | { kind: 'simple'; program: string; command: string }
  | { kind: 'compound'; subcommands: ParsedShell[] }
  | { kind: 'parse-error' };

export function parseShellCommand(command: string): ParsedShell {
  const trimmed = command.trim();
  if (!trimmed) return { kind: 'parse-error' };
  const primary = primaryShellCommand(trimmed); // null on COMPLEX_RE or VAR= prefix
  if (!primary) return { kind: 'parse-error' };
  return { kind: 'simple', program: primary, command: trimmed };
}
