import type { z } from 'zod';
import { readToolMeta } from '../framework/tools/adapter.js';

/**
 * Which tools an applet action may call **directly, with no model** (#445).
 *
 * The tier this enables is the middle one: pure computation belongs in the
 * applet's own JavaScript, judgment needs an agent, and everything between —
 * effects on the machine with a known shape — is a function call. Paying for a
 * model to move a file is not only waste, it is *nondeterministic*: an agent
 * may skip a file or invent a path, where a loop does neither.
 *
 * Eligibility is an opt-in flag on the tool (`ToolMeta.directInvocable`), not
 * a list kept here — a list can disagree with the tool it describes, and the
 * disagreement is fail-open. This module is the *reader* of that flag plus the
 * two structural checks a flag cannot make on its own.
 */

/** Zod nodes an {@link ArgSpec} can produce a value for. */
const SCALAR_TYPES = new Set(['ZodString', 'ZodNumber', 'ZodBoolean', 'ZodEnum', 'ZodLiteral']);
/** Wrappers that do not change whether the value underneath is a scalar. */
const TRANSPARENT_TYPES = new Set([
  'ZodOptional',
  'ZodNullable',
  'ZodDefault',
  'ZodEffects',
  'ZodBranded',
]);

function typeNameOf(node: unknown): string {
  return (node as { _def?: { typeName?: string } })?._def?.typeName ?? '';
}

function innerOf(node: unknown): unknown {
  const def = (node as { _def?: Record<string, unknown> })?._def ?? {};
  return def.innerType ?? def.schema ?? def.type;
}

/**
 * True when a manifest could supply this parameter.
 *
 * `ArgSpec` produces `string | number | boolean` and nothing else, so an
 * array, an object or a union of them is not something a declared arg can
 * become. Bounded by depth rather than trusting the schema to be shallow.
 */
export function isRepresentableParam(node: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  const t = typeNameOf(node);
  if (SCALAR_TYPES.has(t)) return true;
  if (TRANSPARENT_TYPES.has(t)) return isRepresentableParam(innerOf(node), depth + 1);
  return false;
}

/** Parameter names of `tool` that a manifest could not supply a value for. */
export function unrepresentableParams(tool: unknown): string[] {
  const shape = (tool as { parameters?: { shape?: Record<string, unknown> } })?.parameters?.shape;
  if (!shape) return [];
  return Object.entries(shape)
    .filter(([, node]) => !isRepresentableParam(node))
    .map(([name]) => name);
}

/**
 * Why `toolName` may not back a `kind: 'tool'` action, or `null` if it may.
 *
 * Three refusals, in the order a manifest author hits them.
 *
 * The flag is the deliberate one. The `dangerous` check is what actually keeps
 * `shell` out and is stated as an invariant rather than a name: its parameters
 * are `{command: string}` — a *representable* scalar, so the shape check alone
 * would let it through — and a free-form command line reachable from a web
 * page is arbitrary host code execution, the hole this whole design closes.
 * A tool classified `dangerous` is by definition not something a caller may
 * reach without a person in the loop.
 *
 * Representability is last because it is about what a manifest can *express*,
 * not about trust: `file_edit_lines` and `time_range_total` take nested
 * arrays, which `ArgSpec` cannot produce. Excluding them is honest — a
 * template layer for nested args is its own change.
 */
export function directInvocableRefusal(toolName: string, tool: unknown): string | null {
  if (!tool) {
    return `Action names tool "${toolName}", which is not in this action's tool allowlist or does not exist.`;
  }
  const meta = readToolMeta(tool as never);
  if (!meta?.directInvocable) {
    return `Tool "${toolName}" cannot be called directly by an app action. Back this action with a specialist instead.`;
  }
  if (meta.kind === 'dangerous') {
    return `Tool "${toolName}" is classified dangerous and can never be called without a person in the loop.`;
  }
  const unrepresentable = unrepresentableParams(tool);
  if (unrepresentable.length > 0) {
    return `Tool "${toolName}" takes arguments an app manifest cannot express: ${unrepresentable.join(', ')}.`;
  }
  return null;
}

/** Narrow alias so callers do not have to import zod to name the schema. */
export type ToolParameters = z.ZodTypeAny;
