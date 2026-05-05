import { generateText } from 'ai';
import { getModel, getProviderOptions } from './providers/index.js';
import { debugLog } from './logger.js';
import type { BernardConfig } from './config.js';

/**
 * Pre-fallback module that runs only when the resolver returns
 * `status: 'unknown'`. Tries one read-only lookup tool to resolve a named
 * reference (e.g. "my brother" via a Google Contacts MCP) before the REPL
 * falls back to prompting the user for free-form text. Fails open at every
 * stage so any error degrades to today's user-prompt path.
 */

function extractJsonObject(text: string): unknown | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

export type ReferenceLookupResult =
  | { status: 'none' }
  | { status: 'found'; resolvedTo: string; toolName: string }
  | { status: 'ambiguous' };

const LOOKUP_TIMEOUT_MS = 5000;
const SELECT_MAX_TOKENS = 256;
const INTERPRET_MAX_TOKENS = 256;
const TOOL_RESULT_PREVIEW_CHARS = 4000;
const MAX_TOOLS_IN_PROMPT = 8;

/**
 * Suffix-based read-only allowlist. MCP tools whose name ends in any of these
 * verbs are treated as safe lookup candidates. Excludes write verbs like
 * `create`, `update`, `delete`, `send`, `post`.
 */
const READONLY_SUFFIX_RE = /(?:^|_)(search|list|find|get|query|read|lookup)$/i;

/**
 * Built-in (non-MCP) tools that are always allowed for resolver lookups.
 * Limited to read-only network tools — no shell, no file write, no memory.
 */
const ALWAYS_ALLOWED_BUILTINS = new Set(['web_search', 'web_read']);

/**
 * Returns true when the named tool is safe for the resolver lookup pass.
 *
 * An MCP tool is identified by `__` in its name (the `@ai-sdk/mcp` convention).
 * MCP tools must additionally match {@link READONLY_SUFFIX_RE}. Built-in tools
 * are restricted to {@link ALWAYS_ALLOWED_BUILTINS} unless explicitly extended
 * via `extraAllowed` (sourced from `BERNARD_LOOKUP_TOOLS`).
 */
export function isAllowedLookupTool(name: string, extraAllowed: string[] = []): boolean {
  if (extraAllowed.includes(name)) return true;
  if (ALWAYS_ALLOWED_BUILTINS.has(name)) return true;
  if (name.includes('__')) {
    return READONLY_SUFFIX_RE.test(name);
  }
  return false;
}

interface ToolDescriptor {
  name: string;
  description: string;
  schema?: unknown;
}

function describeTool(name: string, tool: any): ToolDescriptor {
  const description = typeof tool?.description === 'string' ? tool.description : '';
  let schema: unknown;
  const params = tool?.parameters;
  if (params && typeof params === 'object' && 'jsonSchema' in params) {
    schema = (params as { jsonSchema: unknown }).jsonSchema;
  }
  return { name, description, schema };
}

function collectAllowedTools(
  tools: Record<string, any>,
  extraAllowed: string[],
): ToolDescriptor[] {
  const out: ToolDescriptor[] = [];
  for (const [name, tool] of Object.entries(tools)) {
    if (!tool || typeof tool.execute !== 'function') continue;
    if (!isAllowedLookupTool(name, extraAllowed)) continue;
    out.push(describeTool(name, tool));
  }
  return out;
}

const SELECT_SYSTEM_PROMPT = `You pick at most one read-only lookup tool to resolve a named reference (e.g. "my brother", "my dentist") against the user's external systems.

Output strict JSON and nothing else. One of:
  {"status":"none"}
  {"status":"call","toolName":"...","args":{...}}

Rules:
- Pick ONE tool. If no listed tool is plausibly capable of resolving the reference, return {"status":"none"}.
- Args MUST match the tool's input schema. Common arg keys are "query", "q", "name", "search". Use whatever the schema specifies.
- The query you pass should be a short search string derived from the reference (e.g. "brother" for "my brother"). Do not invent specific names.
- Do NOT pick a tool just to be helpful — if uncertain, "none". A failed lookup costs us a round-trip; "none" is cheap.`;

function buildSelectUserMessage(reference: string, candidates: ToolDescriptor[]): string {
  const lines: string[] = [`## Reference to resolve\n"${reference}"`];
  lines.push('## Available read-only lookup tools');
  const limited = candidates.slice(0, MAX_TOOLS_IN_PROMPT);
  for (const t of limited) {
    const desc = t.description ? ` — ${t.description}` : '';
    lines.push(`- ${t.name}${desc}`);
    if (t.schema) {
      try {
        lines.push(`  schema: ${JSON.stringify(t.schema).slice(0, 600)}`);
      } catch {
        /* ignore */
      }
    }
  }
  if (candidates.length > limited.length) {
    lines.push(`- … ${candidates.length - limited.length} more omitted for brevity`);
  }
  return lines.join('\n');
}

interface SelectResult {
  toolName: string;
  args: unknown;
}

function parseSelectResponse(text: string): SelectResult | null {
  const parsed = extractJsonObject(text) as
    | { status?: string; toolName?: unknown; args?: unknown }
    | null;
  if (!parsed || parsed.status === 'none') return null;
  if (parsed.status === 'call' && typeof parsed.toolName === 'string') {
    return { toolName: parsed.toolName, args: parsed.args ?? {} };
  }
  return null;
}

export async function selectLookupTool(
  reference: string,
  candidates: ToolDescriptor[],
  config: BernardConfig,
  abortSignal?: AbortSignal,
): Promise<SelectResult | null> {
  if (candidates.length === 0) return null;
  try {
    const result = await generateText({
      model: getModel(config.provider, config.model),
      providerOptions: getProviderOptions(config.provider),
      system: SELECT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildSelectUserMessage(reference, candidates) }],
      maxSteps: 1,
      maxTokens: SELECT_MAX_TOKENS,
      temperature: 0,
      abortSignal,
    });
    if (!result.text) return null;
    const parsed = parseSelectResponse(result.text);
    if (!parsed) {
      debugLog('reference-tool-lookup:select-parse-failed', result.text.slice(0, 200));
      return null;
    }
    // The LLM may hallucinate a tool name not in the candidate list.
    if (!candidates.some((c) => c.name === parsed.toolName)) {
      debugLog('reference-tool-lookup:select-unknown-tool', parsed.toolName);
      return null;
    }
    return parsed;
  } catch (err) {
    debugLog('reference-tool-lookup:select-error', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Composes a 5 s timeout with the caller's abort signal so a slow MCP can't
 * stall the turn. `AbortSignal.any` is available on Node ≥20.3.
 */
function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
  if (!signal) return timeoutSignal;
  return AbortSignal.any([signal, timeoutSignal]);
}

export async function executeLookupTool(
  toolName: string,
  args: unknown,
  tools: Record<string, any>,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  const tool = tools[toolName];
  if (!tool || typeof tool.execute !== 'function') return null;
  try {
    const result = await tool.execute(args, {
      toolCallId: `resolver-lookup-${Date.now()}`,
      abortSignal: withTimeout(abortSignal),
      messages: [],
    });
    if (result === undefined || result === null) return null;
    if (typeof result === 'string') return result.slice(0, TOOL_RESULT_PREVIEW_CHARS);
    try {
      return JSON.stringify(result).slice(0, TOOL_RESULT_PREVIEW_CHARS);
    } catch {
      return String(result).slice(0, TOOL_RESULT_PREVIEW_CHARS);
    }
  } catch (err) {
    debugLog('reference-tool-lookup:execute-error', err instanceof Error ? err.message : String(err));
    return null;
  }
}

const INTERPRET_SYSTEM_PROMPT = `You interpret a tool's JSON result against a user-named reference and decide whether the tool found a unique match.

Output strict JSON and nothing else. One of:
  {"status":"none"}
  {"status":"found","resolvedTo":"..."}
  {"status":"ambiguous"}

Rules:
- "found" only when ONE specific entity in the result clearly matches the reference. \`resolvedTo\` is a short human-readable string (~120 chars) drawn from the result that identifies that entity (e.g. "Tom Smith <tom@example.com>"). Do not invent fields the result does not contain.
- "ambiguous" when 2+ entities plausibly match and we cannot pick.
- "none" when the result is empty, an error, or contains no plausible match for the reference.
- Be conservative. When in doubt, prefer "none" or "ambiguous" over a wrong "found".`;

function parseInterpretResponse(text: string): ReferenceLookupResult | null {
  const parsed = extractJsonObject(text) as
    | { status?: string; resolvedTo?: unknown }
    | null;
  if (!parsed) return null;
  if (parsed.status === 'none') return { status: 'none' };
  if (parsed.status === 'ambiguous') return { status: 'ambiguous' };
  if (
    parsed.status === 'found' &&
    typeof parsed.resolvedTo === 'string' &&
    parsed.resolvedTo.trim().length > 0
  ) {
    return { status: 'found', resolvedTo: parsed.resolvedTo.trim(), toolName: '' };
  }
  return null;
}

export async function interpretLookupResult(
  reference: string,
  toolName: string,
  toolResult: string,
  config: BernardConfig,
  abortSignal?: AbortSignal,
): Promise<ReferenceLookupResult> {
  try {
    const result = await generateText({
      model: getModel(config.provider, config.model),
      providerOptions: getProviderOptions(config.provider),
      system: INTERPRET_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `## Reference\n"${reference}"\n\n## Tool used\n${toolName}\n\n## Tool result\n${toolResult}`,
        },
      ],
      maxSteps: 1,
      maxTokens: INTERPRET_MAX_TOKENS,
      temperature: 0,
      abortSignal,
    });
    if (!result.text) return { status: 'none' };
    const parsed = parseInterpretResponse(result.text);
    if (!parsed) {
      debugLog('reference-tool-lookup:interpret-parse-failed', result.text.slice(0, 200));
      return { status: 'none' };
    }
    if (parsed.status === 'found') {
      return { status: 'found', resolvedTo: parsed.resolvedTo, toolName };
    }
    return parsed;
  } catch (err) {
    debugLog(
      'reference-tool-lookup:interpret-error',
      err instanceof Error ? err.message : String(err),
    );
    return { status: 'none' };
  }
}

function isEmptyToolResult(toolResult: string): boolean {
  const trimmed = toolResult.trim();
  return (
    trimmed === '' ||
    trimmed === '[]' ||
    trimmed === '{}' ||
    trimmed === 'null' ||
    trimmed === '""'
  );
}

/**
 * Runs select → execute → interpret. Fail-open: any error yields
 * `{ status: 'none' }` so the caller falls through to the user-prompt path.
 */
export async function runReferenceLookup(
  reference: string,
  tools: Record<string, any>,
  config: BernardConfig,
  abortSignal?: AbortSignal,
): Promise<ReferenceLookupResult> {
  if (!config.referenceLookup) {
    return { status: 'none' };
  }
  const candidates = collectAllowedTools(tools, config.referenceLookupTools);
  debugLog('reference-tool-lookup:candidates', {
    reference,
    count: candidates.length,
    names: candidates.map((c) => c.name),
  });
  if (candidates.length === 0) return { status: 'none' };

  const selected = await selectLookupTool(reference, candidates, config, abortSignal);
  if (!selected) return { status: 'none' };
  debugLog('reference-tool-lookup:selected', selected);

  const toolResult = await executeLookupTool(selected.toolName, selected.args, tools, abortSignal);
  if (toolResult === null) return { status: 'none' };
  debugLog('reference-tool-lookup:executed', {
    toolName: selected.toolName,
    resultChars: toolResult.length,
  });

  if (isEmptyToolResult(toolResult)) {
    debugLog('reference-tool-lookup:empty-result-shortcircuit', selected.toolName);
    return { status: 'none' };
  }

  const interpreted = await interpretLookupResult(
    reference,
    selected.toolName,
    toolResult,
    config,
    abortSignal,
  );
  debugLog('reference-tool-lookup:interpreted', interpreted);
  return interpreted;
}
