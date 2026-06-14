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
import { truncate } from '../text.js';
import { stableArgsString, FILE_TOOLS, WEB_TOOLS } from './matchers.js';

export interface BreadthOption {
  /** Short label shown in the breadth selector. */
  label: string;
  /** The rule specifier this option persists. */
  specifier: string;
  /** Full "Will allow: … for this profile" preview. */
  rulePreview: string;
}

const LABEL_MAX = 48;

function preview(label: string): string {
  return `Will allow: \`${label}\` for this profile`;
}

function within(dir: string): boolean {
  // Only offer a directory-level grant inside cwd or home, and never the root.
  const root = path.parse(dir).root;
  if (dir === root) return false;
  // Separator-aware containment so a sibling like `/home/me/proj2` is not
  // treated as "within" `/home/me/proj`.
  const under = (base: string): boolean => dir === base || dir.startsWith(base + path.sep);
  return under(process.cwd()) || under(os.homedir());
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
    const shortCmd = truncate(cmd, LABEL_MAX);
    const exact: BreadthOption = {
      label: shortCmd,
      specifier: cmd,
      rulePreview: preview(shortCmd),
    };
    if (cmd === primary || cmd === anyArgs) return [exact]; // bare command: one level
    return [exact, { label: anyArgs, specifier: anyArgs, rulePreview: preview(anyArgs) }];
  }

  if (FILE_TOOLS.has(toolName)) {
    const p = typeof a?.path === 'string' ? (a.path as string) : '';
    if (!p) return [];
    const abs = path.resolve(p);
    // One construction shape for every path level (exact file, dir/**, parent/**).
    const pathOption = (spec: string): BreadthOption => ({
      label: truncate(spec, LABEL_MAX),
      specifier: spec,
      rulePreview: preview(`${toolName} ${truncate(spec, LABEL_MAX)}`),
    });
    const out: BreadthOption[] = [pathOption(abs)];
    const dir = path.dirname(abs);
    if (within(dir)) {
      out.push(pathOption(`${dir}/**`));
      const parent = path.dirname(dir);
      if (parent !== dir && within(parent)) out.push(pathOption(`${parent}/**`));
    }
    return out;
  }

  if (WEB_TOOLS.has(toolName)) {
    const u = typeof a?.url === 'string' ? (a.url as string) : '';
    if (!u) return [];
    const shortUrl = truncate(u, LABEL_MAX);
    const exact: BreadthOption = {
      label: shortUrl,
      specifier: u,
      rulePreview: preview(`${toolName} ${shortUrl}`),
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
