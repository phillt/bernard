/**
 * MCP registry primitives: namespaced naming, alias resolution, and the one
 * flatten that derives a flat tool bag from the per-server map (#413).
 *
 * Bernard used to register every server's tools in one flat, last-writer-wins
 * map, so two servers exporting `browser_click` could not coexist — measured,
 * `playwright` silently lost 7 of its 24 tools to `browsermcp`, every one of
 * them an interaction verb. Namespacing the exposed key by server makes that
 * collision unrepresentable rather than merely reported.
 *
 * ## Why its own module
 *
 * Five consumers across four layers need these strings: the manager itself, the
 * delegation surface, the augment layer's profile keys, the tool-wrapper's
 * `targetTools` filter, and `mcp_verify`'s reconciliation. `mcp.ts` opens `@ai-sdk/mcp` and `node:fs` at import, so
 * making `augment.ts` depend on it to ask a pure question about a string is the
 * edge `tool-bytes.ts` and `tool-result-shape.ts` were both carved out to
 * avoid. This module imports `node:crypto` and nothing else.
 *
 * ## Shape: `<sanitizedServer>_<6hex>__<tool>`
 *
 * **Prefix, not suffix**, and that is load-bearing: `isReadOnlyMCPToolName`
 * (`risk.ts`) segments the name and matches a read verb at either END, so a
 * suffix would silently reclassify every read-only MCP tool as a write —
 * turning on confirm prompts across the board. A prefix would be transparent
 * even to that, but only because the classifier strips the namespace first,
 * which is exactly the coupling this note exists to keep visible.
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
const MCP_NS_SEP = '__';

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
  return `${serverLabel(server)}_${shortHash(server, MCP_HASH_LEN)}`;
}

/**
 * The human half of a server segment — what {@link stripHash} recovers, and
 * therefore what every un-hashed legacy spelling is built from.
 *
 * Extracted so {@link mcpNameOwnedBy} derives the legacy forms it must match
 * rather than re-spelling `sanitize(...).slice(...)`: the two would then be one
 * `SERVER_LABEL_MAX` edit away from disagreeing, and the disagreement is
 * silent — a sweep that stops matching simply leaves debris.
 */
function serverLabel(server: string): string {
  return sanitize(server).slice(0, SERVER_LABEL_MAX);
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
 * `null` is a **tombstone**, not a convenience. Deleting the key on the second
 * claimant instead would let a *third* matching name re-insert the alias as
 * unique, silently un-ambiguating a three-way collision and honouring a grant
 * against whichever server happened to be listed last. The entry has to
 * survive to keep saying "no".
 */
export type MCPAliasIndex = ReadonlyMap<string, string | null>;

/**
 * The older names a live registry key should still answer to.
 *
 * Bernard shipped for a long time registering MCP tools under their bare names,
 * and those bare names are persisted in permission grants, tool-profile
 * filenames and specialist `targetTools`. Rather than rewrite user data, a
 * stored name is resolved through this at match time.
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

/**
 * True when `name` is a registry key or delegate name Bernard minted **for
 * `server`** — the inverse of {@link mcpToolName}, and the only tool→server
 * attribution available with no live registry.
 *
 * That constraint is what the removal sweep (#377) is built on: `mcp.json` is
 * edited from a CLI that has connected nothing, and the server being removed is
 * frequently the one that no longer starts. A name is therefore attributed from
 * its own bytes or not at all.
 *
 * Four spellings, all of them ones Bernard has actually written:
 *
 * - `<label>_<hash6>__<tool>` — the R0 registry key.
 * - `<hash6>__<tool>` — R1/R2, where a long server name cost the label.
 * - `delegate_<label>_<hash6>` — the delegate tool since #413.
 * - `delegate_<server>` — the delegate tool before it, under the raw key.
 *
 * **The un-hashed `<label>__<tool>` form is deliberately NOT matched**, though
 * {@link aliasesOf} answers to it. Bernard never minted it — pre-#413 it
 * registered bare tool names, and that alias exists only because the
 * `@ai-sdk/mcp` convention would have produced it — so matching it can only
 * ever fire on a hand-written record, while costing a real false positive: the
 * label is lossy (`my.server` and `my-server` both collapse to `my_server`), so
 * one such name belongs to two servers and removing either would take the
 * other's grant with it. The hash is what makes every other rung safe.
 *
 * A **bare** tool name is never owned by anybody here, and that is the whole
 * shape of what this cannot do: `browser_click` was exported by two of the
 * servers on the install this was measured against, so attributing it needs the
 * live surface `makeAliasResolver` reads and fails closed on.
 */
export function mcpNameOwnedBy(name: string, server: string): boolean {
  const parsed = parseMCPToolName(name);
  if (parsed) {
    return (
      parsed.serverSegment === mcpServerSegment(server) ||
      parsed.serverSegment === shortHash(server, MCP_HASH_LEN)
    );
  }
  return name === `delegate_${mcpServerSegment(server)}` || name === `delegate_${server}`;
}

/**
 * The names in `names` that are shaped like an MCP registry key or delegate
 * name and belong to **none** of `servers`.
 *
 * The standing counterpart to {@link mcpNameOwnedBy}: that one answers "is this
 * this server's?", this one answers "is there any server left that could
 * answer it?". Its consumer is a specialist's `targetTools` fence, which names
 * tools by string and drops silently when one matches nothing (#331) — so a
 * fence entry left behind by a removed server is the quietest failure in this
 * area, and asking for it needs no live registry, only `mcp.json`.
 *
 * A **bare** name is never reported, for the reason it is never attributed:
 * `browser_click` is indistinguishable from a Bernard built-in from here, and
 * flagging every built-in in every fence would bury the one entry that matters.
 * So this is strictly the population the namespace made legible.
 *
 * In this leaf rather than beside the sweep so the caller supplies its own
 * server list: a consumer that already knows the configured keys should not
 * acquire an edge to `mcp.ts` to have them read again.
 */
export function unownedMCPNames(names: readonly string[], servers: readonly string[]): string[] {
  return names.filter((name) => {
    if (!parseMCPToolName(name) && !name.startsWith('delegate_')) return false;
    return !servers.some((server) => mcpNameOwnedBy(name, server));
  });
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
 * owned that name. Ambiguity is only visible from the global view, which is
 * why `MCPManager.snapshot()` is the only thing that calls this.
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

/**
 * Flattens the per-server registry into one name-keyed bag.
 *
 * The flat form is genuinely needed in three places — a delegation-off
 * dispatch, the tool-wrapper's `targetTools` registry, and `augmentTools`'
 * iteration — but it is always DERIVED here, never authored. That is what makes
 * it impossible for the flat bag and the per-server map to disagree about a
 * key: there is only one place a key is written.
 *
 * Lives in this leaf rather than beside `MCPManager` for the reason given at
 * the top of this file; fixtures deriving `tools` through this same function is
 * what stops them encoding a state the real assembler could never produce.
 */
export function flattenServerTools<T>(
  serverTools: Record<string, Record<string, T>>,
): Record<string, T> {
  const flat: Record<string, T> = {};
  for (const tools of Object.values(serverTools)) Object.assign(flat, tools);
  return flat;
}

/** Prefix marking a tool profile as belonging to an MCP tool. */
const MCP_PROFILE_PREFIX = 'mcp.';

/**
 * The tool-profile key for an MCP tool, and its inverse.
 *
 * Minted and parsed here rather than spelled literally at both ends: the
 * producer (`tools/augment.ts`) and the consumer (`tool-profiles.ts`) sit in
 * different layers, and a prefix change would otherwise leave the reader
 * silently dropping every MCP profile or keeping every orphan, with no type
 * error — the same mint/parse join this issue removed from `MCPManager`.
 */
export function mcpProfileKey(toolName: string): string {
  return `${MCP_PROFILE_PREFIX}${toolName}`;
}

/** `mcp.<name>` -> `<name>`, or `null` when `key` is not an MCP profile key. */
export function toolNameFromProfileKey(key: string): string | null {
  return key.startsWith(MCP_PROFILE_PREFIX) ? key.slice(MCP_PROFILE_PREFIX.length) : null;
}

/** `ToolMeta.category` prefix for a tool a server exports. */
const MCP_CATEGORY_PREFIX = 'mcp.';

/** `ToolMeta.category` prefix for a server's `delegate_<server>` tool. */
const MCP_DELEGATE_CATEGORY_PREFIX = 'mcp-delegate.';

/**
 * `ToolMeta.category` for an MCP tool, and for a delegate — plus the inverse.
 *
 * Same mint/parse join as {@link mcpProfileKey} one field over, and it was
 * spelled out in **six** places across five files before #377: minted in
 * `mcp.ts` and `tools/delegate.ts`, parsed in `tool-profiles.ts`,
 * `tools/in-flight.ts` (as a bare `slice(4)`) and twice in the removal sweep.
 * The category is the only place a removed server's name survives in full —
 * the registry key carries a six-hex hash of it — so a prefix that drifted
 * would leave the sweep silently attributing nothing, with no type error.
 *
 * Neither prefix is a prefix of the other (`mcp-` against `mcp.`), so the two
 * tests are independent and their order carries no meaning.
 */
export function mcpToolCategory(server: string): string {
  return `${MCP_CATEGORY_PREFIX}${server}`;
}

/** @see mcpToolCategory */
export function mcpDelegateCategory(server: string): string {
  return `${MCP_DELEGATE_CATEGORY_PREFIX}${server}`;
}

/**
 * The server a `ToolMeta.category` names, or `null` for anything else — a
 * shell sub-category, a failure taxonomy value, or nothing at all.
 *
 * `kind` is reported rather than collapsed because the two are not
 * interchangeable at every reader: `filterLiveProfiles` matches its candidates
 * against the live *tool* surface, which contains no delegate names, so
 * widening it to delegates would drop every live delegate profile from the
 * prompt rather than only the orphaned ones.
 */
export function serverFromCategory(
  category: string | undefined,
): { server: string; kind: 'tool' | 'delegate' } | null {
  if (!category) return null;
  if (category.startsWith(MCP_DELEGATE_CATEGORY_PREFIX)) {
    return { server: category.slice(MCP_DELEGATE_CATEGORY_PREFIX.length), kind: 'delegate' };
  }
  if (category.startsWith(MCP_CATEGORY_PREFIX)) {
    return { server: category.slice(MCP_CATEGORY_PREFIX.length), kind: 'tool' };
  }
  return null;
}

/**
 * Resolves a stored tool name onto the live name it refers to, or `null` when
 * it refers to nothing resolvable — unknown, or exported by more than one
 * server. Both cases fail closed at every consumer.
 *
 * Declared here, in the leaf every consumer already imports, rather than in
 * `permissions/engine.ts`: the tool-wrapper consumer has no other reason to
 * reach into the permissions layer, and hand-respelling the
 * signature inline loses the `null`-means-ambiguous contract the whole
 * fail-closed design rests on.
 */
export type ToolNameAliasResolver = (storedName: string) => string | null;

/** Builds a {@link ToolNameAliasResolver} over a whole live tool surface. */
export function makeAliasResolver(liveNames: Iterable<string>): ToolNameAliasResolver {
  const names = [...liveNames];
  const live = new Set(names);
  const index = buildMCPAliasIndex(names);
  return (stored) => resolveMCPName(stored, live, index);
}
