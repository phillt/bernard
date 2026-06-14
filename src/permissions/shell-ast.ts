/**
 * Shell command parsing for the permission engine (#261).
 *
 * Uses tree-sitter-bash (via `web-tree-sitter`, WASM — no native build) to
 * parse a command into an AST, then:
 *   - splits compound commands (`&&`/`||`/`;`/`|`/newline) into independent
 *     simple subcommands, each checked separately by the engine;
 *   - **fails closed** (→ `parse-error`, which the engine treats as "no
 *     specifier covers this", i.e. prompt) on any unhandled construct:
 *     subshells, command/process substitution, variable expansion, redirects,
 *     control flow, here-docs, leading variable assignments;
 *   - **never auto-approves exec wrappers** (`bash -c`, `eval`, `xargs`,
 *     `sudo`, `find -exec`, …) — they always route to `parse-error` → prompt.
 *
 * The parser loads asynchronously (`initShellParser`). Until it's ready — or if
 * loading fails — `parseShellCommand` falls back to a conservative regex split
 * (`primaryShellCommand`/`COMPLEX_RE`), so the module is always safe to call
 * synchronously and degrades to "prompt on anything non-trivial".
 */

import { createRequire } from 'node:module';
import { primaryShellCommand } from '../tool-permissions.js';

export type ParsedShell =
  | { kind: 'simple'; program: string; command: string }
  | { kind: 'compound'; subcommands: ParsedShell[] }
  | { kind: 'parse-error' };

/** Exec wrappers that can run arbitrary inner commands — never auto-approve. */
const EXEC_WRAPPERS = new Set([
  'bash',
  'sh',
  'zsh',
  'fish',
  'ksh',
  'dash',
  'eval',
  'exec',
  'xargs',
  'watch',
  'setsid',
  'sudo',
  'su',
  'env',
]);

/** Inner AST nodes that make a command's effect non-static → fail closed. */
const UNSAFE_INNER = new Set([
  'command_substitution',
  'process_substitution',
  'variable_assignment',
  'expansion',
  'simple_expansion',
  'arithmetic_expansion',
]);

/** Structural nodes the walker understands; anything else fails closed. */
const HANDLED_STRUCTURE = new Set(['program', 'list', 'pipeline', 'command']);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let parser: any = null;
let initPromise: Promise<void> | null = null;

/**
 * Best-effort async load of the tree-sitter bash parser. Safe to call multiple
 * times; resolves once. Failures are swallowed (the regex fallback covers us).
 */
export async function initShellParser(): Promise<void> {
  if (parser) return;
  initPromise ??= (async () => {
    const { Parser, Language } = await import('web-tree-sitter');
    await Parser.init();
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve('tree-sitter-wasms/out/tree-sitter-bash.wasm');
    const lang = await Language.load(wasmPath);
    const p = new Parser();
    p.setLanguage(lang);
    parser = p;
  })().catch(() => {
    parser = null;
    initPromise = null;
  });
  return initPromise ?? Promise.resolve();
}

/** True once the AST parser has loaded (else `parseShellCommand` uses regex). */
export function isShellParserReady(): boolean {
  return parser !== null;
}

export function parseShellCommand(command: string): ParsedShell {
  const trimmed = command.trim();
  if (!trimmed) return { kind: 'parse-error' };
  if (parser) {
    try {
      return parseWithAst(trimmed);
    } catch {
      // fall through to the conservative regex path
    }
  }
  return parseWithRegex(trimmed);
}

function parseWithRegex(trimmed: string): ParsedShell {
  const primary = primaryShellCommand(trimmed); // null on COMPLEX_RE / VAR= prefix
  if (!primary) return { kind: 'parse-error' };
  return { kind: 'simple', program: primary, command: trimmed };
}

interface Accum {
  simples: Array<{ program: string; command: string }>;
  unsafe: boolean;
}

function parseWithAst(command: string): ParsedShell {
  const tree = parser.parse(command);
  const root = tree.rootNode;
  if (root.hasError) return { kind: 'parse-error' };
  const acc: Accum = { simples: [], unsafe: false };
  walk(root, acc);
  if (acc.unsafe || acc.simples.length === 0) return { kind: 'parse-error' };
  if (acc.simples.length === 1) {
    return { kind: 'simple', program: acc.simples[0].program, command: acc.simples[0].command };
  }
  return {
    kind: 'compound',
    subcommands: acc.simples.map((s) => ({
      kind: 'simple' as const,
      program: s.program,
      command: s.command,
    })),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function walk(node: any, acc: Accum): void {
  if (acc.unsafe) return;
  const type = node.type as string;

  if (type === 'command') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const children: any[] = node.namedChildren;
    for (const c of children) {
      if (UNSAFE_INNER.has(c.type)) {
        acc.unsafe = true;
        return;
      }
    }
    const nameNode = children.find((c) => c.type === 'command_name');
    if (!nameNode) {
      acc.unsafe = true;
      return;
    }
    const program = String(nameNode.text).trim();
    if (EXEC_WRAPPERS.has(program)) {
      acc.unsafe = true;
      return;
    }
    if (program === 'find' && /(^|\s)-(exec|execdir|delete|ok)\b/.test(node.text)) {
      acc.unsafe = true;
      return;
    }
    acc.simples.push({ program, command: String(node.text).trim() });
    return;
  }

  if (HANDLED_STRUCTURE.has(type)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const c of node.namedChildren as any[]) walk(c, acc);
    return;
  }

  // Any other *named* construct (subshell, redirect, control flow, here-doc,
  // function def, …) is unhandled → fail closed.
  acc.unsafe = true;
}
