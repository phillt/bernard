/**
 * Namespaced naming for MCP tools (#413).
 *
 * Bernard used to register every server's tools in one flat, last-writer-wins
 * map, so two servers exporting `browser_click` could not coexist — measured,
 * `playwright` silently lost 7 of its 24 tools to `browsermcp`, every one of
 * them an interaction verb. Namespacing the exposed key by server makes that
 * collision unrepresentable rather than merely reported.
 *
 * ## Why its own module
 *
 * Six consumers across four layers need these strings: the manager itself, the
 * delegation surface, the augment layer's profile keys, the tool-wrapper's
 * `targetTools` filter, the reference-lookup allowlist, and `mcp_verify`'s
 * reconciliation. `mcp.ts` opens `@ai-sdk/mcp` and `node:fs` at import, so
 * making `augment.ts` depend on it to ask a pure question about a string is the
 * edge `tool-bytes.ts` and `tool-result-shape.ts` were both carved out to
 * avoid. This module imports `node:crypto` and nothing else.
 *
 * ## Shape: `<sanitizedServer>_<6hex>__<tool>`
 *
 * **Prefix, not suffix**, and that is load-bearing: `isReadOnlyMCPSuffix`
 * (`risk.ts`) is end-anchored, so a prefix is transparent to risk
 * classification while a suffix would silently reclassify every read-only MCP
 * tool as a write — turning on confirm prompts across the board.
 *
 * **The hash buys stability, not collision-avoidance.** Server names are
 * object keys in `mcp.json` and so are already unique; what is not unique is
 * their *sanitized* form (`my.server` and `my-server` both collapse to
 * `my_server`). The previous answer to that was a numeric suffix assigned in
 * iteration order, which means editing `mcp.json` could renumber a *different*
 * server's key — and that key is persisted, in permission grants and tool
 * profile filenames. A content hash of the raw name depends only on that
 * server, so no edit elsewhere can move it.
 */

import { createHash } from 'node:crypto';

/**
 * Hard ceiling on a tool name. Anthropic and OpenAI both enforce this
 * server-side and neither the `ai` SDK nor `@ai-sdk/*` validates it locally, so
 * exceeding it is a runtime API 400 on a real turn rather than an error at
 * startup. Every name this module mints is <= this by construction.
 */
export const MCP_NAME_MAX = 64;

/** Hex digits of the server hash. Kept whole at every truncation rung. */
export const MCP_HASH_LEN = 6;

/** Separator between the server segment and the tool name. */
export const MCP_NS_SEP = '__';

/** Longest human-readable server label kept before the hash takes over. */
const SERVER_LABEL_MAX = 24;

/** Hex digits of the tool hash, used only when the tool name itself is cut. */
const TOOL_HASH_LEN = 4;

function shortHash(input: string, len: number): string {
  return createHash('sha256').update(input).digest('hex').slice(0, len);
}

/** Tool-name-safe form: the AI SDK accepts only `[a-zA-Z0-9_-]`. */
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * The server half of a namespaced tool name: `<sanitized>_<6hex>`.
 *
 * Depends only on `server`, so adding, removing or reordering other servers in
 * `mcp.json` can never change it. That is the whole point — see the module
 * docstring.
 */
export function mcpServerSegment(server: string): string {
  const label = sanitize(server).slice(0, SERVER_LABEL_MAX);
  return `${label}_${shortHash(server, MCP_HASH_LEN)}`;
}

/**
 * The exposed registry key for `tool` as exported by `server`.
 *
 * Deterministic, `[a-zA-Z0-9_-]` only, and always within {@link MCP_NAME_MAX}
 * via a three-rung ladder — first rung that fits wins:
 *
 * - **R0** `<label>_<hash6>__<tool>` — the readable form.
 * - **R1** `<hash6>__<tool>` — drop the human label, keep the hash. A long
 *   server name should not cost the tool its identity, which is the half a
 *   reader actually needs to recognise the call.
 * - **R2** `<hash6>__<head>_<toolHash4>_<tail>` — the tool name itself is cut,
 *   in the *middle*, so both ends stay legible.
 *
 * Uniqueness survives every rung: the full server hash is always present, and
 * R2's tool hash is taken over the whole original tool name, so only a genuine
 * hash collision can collide. Nothing downstream may infer the raw tool name
 * back out of an R2 name — which is why risk classification reads the raw name
 * at the registration site rather than re-deriving it from the key.
 */
export function mcpToolName(server: string, tool: string): string {
  const safeTool = sanitize(tool);
  const hash = shortHash(server, MCP_HASH_LEN);

  const r0 = `${mcpServerSegment(server)}${MCP_NS_SEP}${safeTool}`;
  if (r0.length <= MCP_NAME_MAX) return r0;

  const r1 = `${hash}${MCP_NS_SEP}${safeTool}`;
  if (r1.length <= MCP_NAME_MAX) return r1;

  // R2: budget what remains for the tool name after the fixed prefix and the
  // tool hash, then split it head/tail so both ends of a long name survive.
  const toolHash = shortHash(tool, TOOL_HASH_LEN);
  const fixed = hash.length + MCP_NS_SEP.length + 1 + toolHash.length + 1;
  const budget = MCP_NAME_MAX - fixed;
  const head = Math.ceil(budget / 2);
  const tail = budget - head;
  const cut = `${safeTool.slice(0, head)}_${toolHash}_${safeTool.slice(safeTool.length - tail)}`;
  return `${hash}${MCP_NS_SEP}${cut}`;
}

/**
 * Splits a namespaced name back into its parts, or `null` when `name` carries
 * no namespace (a bare tool name, or a Bernard built-in).
 *
 * Splits on the **first** separator: a tool whose own name contains `__` keeps
 * it intact in `tool`, which matters because some servers really do export
 * such names and re-splitting them would invent a server that does not exist.
 */
export function parseMCPToolName(name: string): { serverSegment: string; tool: string } | null {
  const i = name.indexOf(MCP_NS_SEP);
  if (i <= 0) return null;
  const tool = name.slice(i + MCP_NS_SEP.length);
  if (!tool) return null;
  return { serverSegment: name.slice(0, i), tool };
}

/**
 * Alias index over the live tool surface: `alias -> canonical live name`, or
 * `null` when the alias is ambiguous.
 *
 * `null` is a *recorded* ambiguity rather than an absent key, so a caller can
 * tell "two servers claim this" from "nobody does" — both fail closed, but
 * only the first is worth logging.
 */
export type MCPAliasIndex = ReadonlyMap<string, string | null>;

/**
 * The older names a live registry key should still answer to.
 *
 * Bernard shipped for a long time registering MCP tools under their bare names,
 * and those bare names are persisted in permission grants, tool-profile
 * filenames, specialist `targetTools` and `BERNARD_LOOKUP_TOOLS`. Rather than
 * rewrite user data, a stored name is resolved through this at match time.
 *
 * Three forms are recognised: the bare tool tail, the unhashed
 * `<server>__<tool>` form (what the `@ai-sdk/mcp` convention would have
 * produced), and — for a `delegate_<server>` key — the unhashed delegate name.
 */
export function aliasesOf(name: string): string[] {
  const out: string[] = [];
  const parsed = parseMCPToolName(name);
  if (parsed) {
    out.push(parsed.tool);
    // `<label>_<hash6>` -> `<label>`: the pre-hash namespaced form.
    const unhashed = stripHash(parsed.serverSegment);
    if (unhashed) out.push(`${unhashed}${MCP_NS_SEP}${parsed.tool}`);
  } else if (name.startsWith('delegate_')) {
    const unhashed = stripHash(name.slice('delegate_'.length));
    if (unhashed) out.push(`delegate_${unhashed}`);
  }
  return out;
}

/** `<label>_<6hex>` -> `<label>`, or `null` when there is no hash to strip. */
function stripHash(segment: string): string | null {
  const m = new RegExp(`^(.*)_[0-9a-f]{${MCP_HASH_LEN}}$`).exec(segment);
  return m && m[1] ? m[1] : null;
}

/**
 * Builds the alias index for a whole live tool surface.
 *
 * **Pass every live name, not one dispatch's registry.** Inside a
 * `delegate_<server>` helper the registry holds a single server, so an index
 * built there would resolve a stored bare `browser_click` *uniquely* — and
 * silently honour a permission grant the user made while a different server
 * owned that name. Ambiguity is only visible from the global view.
 *
 * A live name is never shadowed by an alias: if some tool is literally called
 * `browser_click`, that mapping wins and is not marked ambiguous.
 */
export function buildMCPAliasIndex(liveNames: Iterable<string>): MCPAliasIndex {
  const names = [...liveNames];
  const live = new Set(names);
  const index = new Map<string, string | null>();
  for (const name of names) {
    for (const alias of aliasesOf(name)) {
      if (live.has(alias)) continue; // a real tool owns this name outright
      index.set(alias, index.has(alias) && index.get(alias) !== name ? null : name);
    }
  }
  return index;
}

/**
 * Resolves a stored tool name against the live surface.
 *
 * Exact match first — a name that is live is always itself. Otherwise a unique
 * alias. Otherwise `null`, which every caller treats as "no match": the
 * permission engine re-prompts, `buildChildTools` drops the entry. Failing
 * closed on ambiguity is deliberate; the alternative is honouring a grant
 * against a tool the user never meant.
 */
export function resolveMCPName(
  stored: string,
  live: ReadonlySet<string>,
  index: MCPAliasIndex,
): string | null {
  if (live.has(stored)) return stored;
  return index.get(stored) ?? null;
}
