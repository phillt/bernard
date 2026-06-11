/**
 * Breadth ladder (#261): given a concrete tool call, produce the ordered list
 * of scope options the user can pick with ←/→ in the confirm dialog, from
 * narrowest (this exact call) to broadest (this command/tool with any args).
 *
 * Each option's `specifier` is what gets persisted into a `PermissionRule`
 * (undefined is reserved for hand-written "any invocation" rules; the ladder
 * never emits an "all shell" / no-specifier level by design).
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { primaryShellCommand } from '../tool-permissions.js';
import { stableArgsString } from './matchers.js';

export interface BreadthOption {
  /** Short label shown in the breadth selector. */
  label: string;
  /** The rule specifier this option persists. */
  specifier: string;
  /** Full "Will allow: … for this profile" preview. */
  rulePreview: string;
}

const FILE_TOOLS = new Set(['file_read_lines', 'file_edit_lines', 'file_write']);
const WEB_TOOLS = new Set(['web_read', 'web_search']);

function preview(label: string): string {
  return `Will allow: \`${label}\` for this profile`;
}

function truncate(s: string, n = 48): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function within(dir: string): boolean {
  // Only offer a directory-level grant inside cwd or home, and never the root.
  const root = path.parse(dir).root;
  if (dir === root) return false;
  const cwd = process.cwd();
  const home = os.homedir();
  return dir.startsWith(cwd) || dir.startsWith(home);
}

/**
 * Returns the breadth ladder for a call, or `[]` when no profile-scope grant
 * should be offered (complex/unparseable shell, missing args). Callers must
 * also suppress this for dangerous shell (handled at the augment layer).
 */
export function breadthOptionsFor(toolName: string, args: unknown): BreadthOption[] {
  const a = args as Record<string, unknown> | undefined;

  if (toolName === 'shell') {
    const cmd = typeof a?.command === 'string' ? (a.command as string).trim() : '';
    const primary = cmd ? primaryShellCommand(cmd) : null;
    if (!primary) return []; // complex/empty → no stable grant (legacy parity)
    const anyArgs = `${primary} *`;
    const exact: BreadthOption = {
      label: truncate(cmd),
      specifier: cmd,
      rulePreview: preview(truncate(cmd)),
    };
    if (cmd === primary || cmd === anyArgs) return [exact]; // bare command: one level
    return [exact, { label: anyArgs, specifier: anyArgs, rulePreview: preview(anyArgs) }];
  }

  if (FILE_TOOLS.has(toolName)) {
    const p = typeof a?.path === 'string' ? (a.path as string) : '';
    if (!p) return [];
    const abs = path.resolve(p);
    const out: BreadthOption[] = [
      { label: truncate(abs), specifier: abs, rulePreview: preview(`${toolName} ${truncate(abs)}`) },
    ];
    const dir = path.dirname(abs);
    if (within(dir)) {
      const glob = `${dir}/**`;
      out.push({ label: glob, specifier: glob, rulePreview: preview(`${toolName} ${truncate(glob)}`) });
      const parent = path.dirname(dir);
      if (parent !== dir && within(parent)) {
        const pglob = `${parent}/**`;
        out.push({ label: pglob, specifier: pglob, rulePreview: preview(`${toolName} ${truncate(pglob)}`) });
      }
    }
    return out;
  }

  if (WEB_TOOLS.has(toolName)) {
    const u = typeof a?.url === 'string' ? (a.url as string) : '';
    if (!u) return [];
    const exact: BreadthOption = {
      label: truncate(u),
      specifier: u,
      rulePreview: preview(`${toolName} ${truncate(u)}`),
    };
    let host = '';
    try {
      host = new URL(u).hostname;
    } catch {
      return [exact];
    }
    const dom = `domain:${host}`;
    return [exact, { label: dom, specifier: dom, rulePreview: preview(`${toolName} ${dom}`) }];
  }

  // MCP and all other tools: exact args → any args.
  const exactArgs = stableArgsString(args);
  return [
    {
      label: 'these arguments',
      specifier: exactArgs,
      rulePreview: preview(`${toolName} (these arguments)`),
    },
    { label: 'any arguments', specifier: '*', rulePreview: preview(`${toolName} (any arguments)`) },
  ];
}
