import { getMCPServer, listMCPServers, removeMCPServer } from './mcp.js';
import { mcpNameOwnedBy, serverFromCategory, toolNameFromProfileKey } from './mcp-names.js';
import { ToolProfileStore, type ToolProfile } from './tool-profiles.js';
import { SpecialistStore } from './specialists.js';
import { permissionsFor } from './specialist-authority.js';
import { getActiveSettings, loadProfiles, saveActiveSettings } from './profiles.js';
import { sanitizePermissionRules, ruleLabel, type PermissionRule } from './tool-permissions.js';
import { listGrantedApps, saveAppGrants } from './apps/app-grants.js';
import { debugLog } from './logger.js';

/**
 * Removing an MCP server, across everything keyed to the tools it exported
 * (#377).
 *
 * Its own module rather than a body for `removeMCPServer`, mirroring
 * `specialist-lifecycle.ts` beside `specialists.ts` — the flat-file precedent,
 * since `mcp.ts` is a file and has no directory of its own. `mcp.ts` owns
 * `mcp.json` and the live manager; folding the sweep into it would give a
 * module that already opens `@ai-sdk/mcp` edges to the tool-profile store, the
 * profile settings, the app grants and the specialist store, to do a job that
 * is not config work.
 *
 * It exists because `removeMCPServer` deleted one key from a JSON file and did
 * nothing else, from **both** its call sites — the `mcp_config` tool and
 * `bernard remove-mcp`. Measured on a real install: 193 tool profiles, of
 * which 5 plus 2 delegate rows belonged to `browsermcp`, a server no longer in
 * `mcp.json`. Nothing in `ToolProfileStore` could remove them; nothing in
 * `mcp.json`'s writer knew they existed.
 *
 * **`removeMCPServer` now has exactly one caller in the tree — this one — and
 * that is what makes the sweep unbypassable rather than merely applied**, the
 * property `cron/lifecycle.ts` states for `CronStore.deleteJob`. A module every
 * caller happens to use today is a convention; a function with one caller is a
 * property, and a third door that wants to drop a server has to come through
 * here.
 *
 * ## What can be attributed, and what cannot
 *
 * Cascading needs a tool→server link, and there is exactly one that survives
 * with no live registry: the name itself. Since #413 a registry key is
 * `<server>_<hash6>__<tool>` and a delegate is `delegate_<server>_<hash6>`, so
 * {@link mcpNameOwnedBy} answers from the bytes. That constraint is not
 * incidental — `bernard remove-mcp` has connected nothing, and the server being
 * removed is frequently the one that no longer starts, so *no* live surface is
 * available at the moment the decision has to be made.
 *
 * What that leaves out is the pre-#413 population: Bernard registered **bare**
 * tool names for years, and 73 of the 193 profiles on that same install still
 * carry one with no server anywhere in it. A bare `browser_click` was exported
 * by two of the five configured servers there, so guessing is not merely
 * imprecise, it deletes a live server's learned history. Those are **named,
 * never removed** — which is the same answer `makeAliasResolver` already gives
 * one layer up, where an ambiguous stored name resolves to `null` and every
 * consumer fails closed.
 *
 * The one bare name that *is* attributable is a legacy profile a namespaced
 * successor claims through {@link ToolProfile.supersedes}, and even that is
 * conditional — see {@link legacyAncestors}.
 *
 * ## Specialists are reported, never edited
 *
 * #377 sketches a confirm-and-delete flow for a specialist whose `targetTools`
 * all came from the removed server. This does not build it, and the omission is
 * the decision: deleting user-authored configuration as a side effect of a
 * config edit is not recoverable, where an orphan is, and the CLI path is
 * frequently scripted with nobody watching. The issue's own recommendation for
 * the headless case is exactly this branch — *"remove the server, leave every
 * specialist intact, and report which are now degraded"* — so taking it
 * everywhere makes the headless behaviour **defined rather than incidental**,
 * and removes the need for any prompting machinery in a path that has two call
 * sites with two different affordances.
 *
 * Measured, nothing is lost today: of the 17 specialists on that install with a
 * `targetTools` fence, **none** names an MCP tool. The report is what makes the
 * hazard visible the day one does.
 */

/** A specialist whose `targetTools` fence names a tool from the removed server. */
export interface AffectedSpecialist {
  id: string;
  /** The `targetTools` entries owned by the removed server. */
  lost: string[];
  /**
   * True when *every* entry was owned by it.
   *
   * `buildChildTools` returns an empty registry when a fence matches nothing
   * (#331) and says nothing about why, so a fully-orphaned specialist does not
   * error — it answers badly. Degraded ones keep working with less.
   */
  orphaned: boolean;
  /** Bundled records cannot be deleted or edited at all, so a fix needs a copy. */
  isProtected: boolean;
}

/** What the sweep removed, kept, and could not decide. */
export interface MCPRemovalResult {
  /** Whether an `mcp.json` row was there to remove. */
  existed: boolean;
  /** Tool-profile keys unlinked. */
  profilesRemoved: string[];
  /** Pre-#413 bare-name profiles unlinked alongside their only successor. */
  legacyRemoved: string[];
  /**
   * Bare-name profiles kept because a surviving profile still claims them,
   * paired with the server that claims them — which is also the command that
   * would eventually remove them.
   */
  legacyKept: Array<{ name: string; claimedBy: string }>;
  /** Permission rules dropped from the active profile, as `ruleLabel` renders them. */
  rulesRemoved: string[];
  /** Per-app rules dropped, by app id. */
  appRulesRemoved: Record<string, string[]>;
  /** Specialists that lose tools. Reported, never edited. */
  specialists: AffectedSpecialist[];
}

/** Injectable stores, so a test drives real ones and a caller reuses its own. */
export interface MCPRemovalDeps {
  profiles?: ToolProfileStore;
  specialists?: SpecialistStore;
}

/**
 * Removes `key` from `mcp.json` and sweeps everything keyed to the tools it
 * exported.
 *
 * **The artifacts are swept whether or not the row exists**, and that is
 * deliberate rather than sloppy — the rule `cron/lifecycle.ts` states for the
 * same reason. Every install that predates this has debris from servers removed
 * the old way, and a sweep gated on the row can never reach it; with the gate
 * off, `bernard remove-mcp browsermcp` against a config that no longer mentions
 * `browsermcp` is the retroactive cleanup, and `bernard tool-profiles` names
 * the keys worth running it for. `existed` is what the two call sites need to
 * say "no such server" without that costing them the sweep.
 *
 * Order is unconstrained: nothing here is held open by another process, and
 * every step is independently a no-op when there is nothing to do.
 */
export function removeMCPServerEverywhere(
  key: string,
  deps: MCPRemovalDeps = {},
): MCPRemovalResult {
  const existed = getMCPServer(key) !== undefined;
  if (existed) removeMCPServer(key);

  const profileStore = deps.profiles ?? new ToolProfileStore({ seed: false });
  const { profilesRemoved, legacyRemoved, legacyKept } = sweepProfiles(profileStore, key);
  const rulesRemoved = sweepProfileRules(key);
  const appRulesRemoved = sweepAppRules(key);
  const specialists = affectedSpecialists(key, deps.specialists);

  debugLog('mcp:remove:sweep', {
    key,
    existed,
    profiles: profilesRemoved.length,
    legacy: legacyRemoved.length,
    legacyKept: legacyKept.length,
    rules: rulesRemoved.length,
    appRules: Object.keys(appRulesRemoved).length,
    specialists: specialists.length,
  });

  return {
    existed,
    profilesRemoved,
    legacyRemoved,
    legacyKept,
    rulesRemoved,
    appRulesRemoved,
    specialists,
  };
}

/** The tool name a profile key addresses: `mcp.<name>` unwrapped, else itself. */
function profileToolName(profile: ToolProfile): string {
  return toolNameFromProfileKey(profile.toolName) ?? profile.toolName;
}

/**
 * True when this profile belongs to `key`.
 *
 * The **key** is tested first and the stored `category` second, and both are
 * needed. The key is authoritative and needs no disk field, but a profile can
 * reach disk with no category at all: `ensureSeeded` is what writes it and it
 * is called from one place, while `recordBadExample` and friends each call
 * `getOrCreate` with no category of their own. The category is the only link a
 * `delegate_*` profile written before the hash existed would carry.
 */
function ownedBy(profile: ToolProfile, key: string): boolean {
  if (mcpNameOwnedBy(profileToolName(profile), key)) return true;
  return serverFromCategory(profile.category)?.server === key;
}

/**
 * The pre-#413 profiles a removal may take with it, and the ones it may not.
 *
 * `getOrCreate`'s `seedFrom` carried a bare-keyed profile's history forward
 * under the namespaced key and **left the old file on disk** for rollback,
 * recording the link as `supersedes`. `list()` then filters the ancestor out,
 * so it costs nothing — until its successor is deleted, at which point it is no
 * longer superseded by anything and **comes back**: into `bernard
 * tool-profiles`, and into the system prompt, where `filterLiveProfiles` waves
 * it through precisely because a bare uncategorised key is indistinguishable
 * from a built-in. A cascade that deletes only the successor is therefore
 * *worse than doing nothing* — it resurrects a dead profile into the prefix.
 *
 * So an ancestor goes with its successor, unless a **surviving** profile still
 * claims it. That exception is not hypothetical: on the install this was
 * measured against, four legacy keys — `browser_click`, `browser_type`,
 * `browser_snapshot`, `browser_navigate` — are each claimed by both
 * `playwright` and `browsermcp`, because both servers export them. Removing one
 * must leave the other's history intact.
 *
 * This is `buildMCPAliasIndex`'s tombstone rule with the inputs swapped: there,
 * two live tools claiming one alias makes it unresolvable; here, two profiles
 * claiming one ancestor makes it unremovable. Same asymmetry, same direction —
 * keeping something dead costs a file, dropping something live costs history
 * nobody can rebuild.
 */
function legacyAncestors(
  all: ToolProfile[],
  doomed: ToolProfile[],
): { remove: string[]; keep: Array<{ name: string; claimedBy: string }> } {
  const onDisk = new Set(all.map((p) => p.toolName));
  const doomedKeys = new Set(doomed.map((p) => p.toolName));
  const remove: string[] = [];
  const keep: Array<{ name: string; claimedBy: string }> = [];

  for (const ancestor of new Set(doomed.map((p) => p.supersedes).filter(Boolean) as string[])) {
    if (!onDisk.has(ancestor)) continue; // claimed but never written, or already gone
    const survivor = all.find((p) => p.supersedes === ancestor && !doomedKeys.has(p.toolName));
    if (survivor) keep.push({ name: ancestor, claimedBy: survivor.toolName });
    else remove.push(ancestor);
  }
  return { remove, keep };
}

function sweepProfiles(
  store: ToolProfileStore,
  key: string,
): Pick<MCPRemovalResult, 'profilesRemoved' | 'legacyRemoved' | 'legacyKept'> {
  // `listAll`, not `list`: a superseded ancestor is exactly what this has to
  // reason about, and `list` is the reader that hides it.
  const all = store.listAll();
  const doomed = all.filter((p) => ownedBy(p, key));
  const { remove, keep } = legacyAncestors(all, doomed);

  const profilesRemoved = doomed.map((p) => p.toolName).filter((name) => store.remove(name));
  const legacyRemoved = remove.filter((name) => store.remove(name));
  return { profilesRemoved, legacyRemoved, legacyKept: keep };
}

/**
 * Drops the user's own grants for this server's tools.
 *
 * Whole-list replacement through `saveActiveSettings`, the one writer, so the
 * rules stay an ordered list the engine scans rather than a set something here
 * has re-derived an order for. Read through `sanitizePermissionRules` first
 * because `profiles.json` is hand-editable and a malformed rule that survived
 * to the engine would be matched against, not ignored — the same reason
 * `app-grants.ts` gives.
 */
function sweepProfileRules(key: string): string[] {
  const rules = sanitizePermissionRules(getActiveSettings(loadProfiles().file).toolPermissions);
  const { kept, dropped } = partitionRules(rules, key);
  if (dropped.length > 0) saveActiveSettings({ toolPermissions: kept });
  return dropped.map(ruleLabel);
}

/** The same, per app (#420). An app's grants are the user's too, just narrower. */
function sweepAppRules(key: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [appId, rules] of Object.entries(listGrantedApps())) {
    const { kept, dropped } = partitionRules(rules, key);
    if (dropped.length === 0) continue;
    saveAppGrants(appId, kept);
    out[appId] = dropped.map(ruleLabel);
  }
  return out;
}

function partitionRules(
  rules: PermissionRule[],
  key: string,
): { kept: PermissionRule[]; dropped: PermissionRule[] } {
  const kept: PermissionRule[] = [];
  const dropped: PermissionRule[] = [];
  for (const rule of rules) (mcpNameOwnedBy(rule.tool, key) ? dropped : kept).push(rule);
  return { kept, dropped };
}

/** Classifies every specialist whose fence names a tool from `key`. See the header. */
function affectedSpecialists(key: string, store?: SpecialistStore): AffectedSpecialist[] {
  const specialists = store ?? new SpecialistStore({ seed: false });
  const out: AffectedSpecialist[] = [];
  for (const record of specialists.list()) {
    const fence = record.targetTools;
    // Absent means "everything the surface allows" (#507), which names no
    // server and cannot be filtered.
    if (!fence) continue;
    const lost = fence.filter((tool) => mcpNameOwnedBy(tool, key));
    // A deny-all `[]` fence (#511) needs no case of its own and deliberately
    // does not get one: it names no tool, so it loses none, and it falls out
    // here with every other specialist that does not depend on this server.
    if (lost.length === 0) continue;
    out.push({
      id: record.id,
      lost,
      orphaned: lost.length === fence.length,
      isProtected: !permissionsFor(record.id).canDelete,
    });
  }
  return out;
}

/**
 * True when the sweep found nothing at all keyed to this server.
 *
 * Lives beside the result rather than at the one call site that asks, because
 * it has to enumerate every field that counts as "something" — a seventh field
 * added later and forgotten here would make `bernard remove-mcp` report a typo
 * for a run that had just deleted a grant. `specialists` deliberately does not
 * count: nothing was done to them, so a report about them is not work.
 *
 * The `legacyKept` term is **insurance and currently unobservable**: an
 * ancestor can only be kept because a doomed profile claimed it, and a doomed
 * profile that was on disk is always unlinked, so a non-empty `legacyKept`
 * implies a non-empty `profilesRemoved`. Its test asserts that implication
 * rather than pretending to cover the term — the `argSpecsSince` precedent. It
 * stays because it is true of what the field MEANS, and the implication is a
 * property of two other functions rather than of this one.
 */
export function sweptNothing(result: MCPRemovalResult): boolean {
  return (
    result.profilesRemoved.length === 0 &&
    result.legacyRemoved.length === 0 &&
    result.legacyKept.length === 0 &&
    result.rulesRemoved.length === 0 &&
    Object.keys(result.appRulesRemoved).length === 0
  );
}

/**
 * The sweep as lines, for whoever is going to say it.
 *
 * Lines rather than one string, and here rather than at either call site: the
 * `mcp_config` tool joins them into its return value and `bernard remove-mcp`
 * prints them one at a time, which is the `apps/manage.ts`-returns /
 * `app-cli.ts`-prints split. Written twice they drift, and the half that drifts
 * is the specialist warning — the one nobody can currently trigger, so nobody
 * would notice.
 *
 * Silent about everything that swept cleanly. A removal that leaves nothing
 * behind should read as a removal, not as a report with six zeroes in it.
 */
export function describeMCPRemoval(key: string, result: MCPRemovalResult): string[] {
  const lines: string[] = [headline(key, result)];

  const swept = result.profilesRemoved.length + result.legacyRemoved.length;
  if (swept > 0) lines.push(`  Tool profiles removed: ${swept}`);
  for (const rule of result.rulesRemoved) lines.push(`  Permission rule removed: ${rule}`);
  for (const [appId, rules] of Object.entries(result.appRulesRemoved)) {
    for (const rule of rules) lines.push(`  App "${appId}" rule removed: ${rule}`);
  }

  // Named, never removed — and named with the thing that WOULD remove them,
  // since "kept" without that reads as an unexplained leftover.
  for (const { name, claimedBy } of result.legacyKept) {
    lines.push(`  Kept legacy profile "${name}" — still claimed by ${claimedBy}.`);
  }

  for (const s of result.specialists) {
    const what = s.orphaned
      ? `has no tools left (it targeted only ${s.lost.join(', ')})`
      : `loses ${s.lost.join(', ')}`;
    const fix = s.isProtected
      ? ' It is bundled and cannot be edited; copy it to change the fence.'
      : ' Nothing was changed — edit its targetTools or delete it yourself.';
    lines.push(`  Specialist "${s.id}" ${what}.${fix}`);
  }

  return lines;
}

/**
 * The opening line — three cases, not two.
 *
 * A key with no row and no debris is a **typo**, and saying "swept anything
 * left behind" for one is both untrue and unhelpful. `removeMCPServer` used to
 * catch typos by throwing with the configured keys attached, and that hint is
 * worth keeping now that the sweep no longer requires a row: the caller is
 * frequently a model inventing a name. It lives here rather than at the call
 * sites so the CLI's non-zero exit and the tool's return string say the same
 * thing.
 */
function headline(key: string, result: MCPRemovalResult): string {
  if (result.existed) {
    return `MCP server "${key}" removed. Restart Bernard for changes to take effect.`;
  }
  if (!sweptNothing(result)) {
    return `MCP server "${key}" was not configured; swept what it left behind.`;
  }
  const configured = listMCPServers().map((s) => s.key);
  return (
    `MCP server "${key}" not found, and nothing on disk belongs to it.` +
    (configured.length > 0 ? ` Valid keys: ${configured.join(', ')}` : ' No servers configured.')
  );
}

/**
 * Server keys that still own tool profiles but no longer appear in `mcp.json`.
 *
 * The standing report behind `bernard tool-profiles`, and the reason the sweep
 * runs for an absent row: a user cannot run `bernard remove-mcp <key>` for
 * debris unless something tells them which keys are worth naming. Read from the
 * stored `category`, which is the only place a *removed* server's name still
 * appears in full — the key carries a six-hex hash of it, which identifies the
 * server but cannot be turned back into a name to print.
 */
export function orphanedMCPServers(profiles: ToolProfile[]): string[] {
  const configured = new Set(listMCPServers().map((s) => s.key));
  const seen = new Set<string>();
  for (const profile of profiles) {
    // Both kinds count: a delegate profile is frequently the only one a server
    // leaves behind, since with delegation on the per-tool profiles are written
    // by the helper and the delegate's is written on every call.
    const owner = serverFromCategory(profile.category);
    if (owner && !configured.has(owner.server)) seen.add(owner.server);
  }
  return [...seen].sort();
}
