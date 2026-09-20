import { getMCPServer, listMCPServers, removeMCPServer } from './mcp.js';
import { mcpNameOwnedBy, serverFromCategory, toolNameFromProfileKey } from './mcp-names.js';
import { ToolProfileStore, type ToolProfile } from './tool-profiles.js';
import { SpecialistStore } from './specialists.js';
import { permissionsFor } from './specialist-authority.js';
import { loadProfiles, updateAllProfileSettings } from './profiles.js';
import { sanitizePermissionRules, ruleLabel, type PermissionRule } from './tool-permissions.js';
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
 * tool names for years. Over `list()`'s 144 live profiles on that install: 71
 * namespaced, 11 `delegate_*` — which ARE attributable, since both delegate
 * rungs match — and **62** carrying a bare tool name with no server anywhere in
 * it. A bare `browser_click` was exported by two of the five configured servers
 * there, so guessing is not merely imprecise, it deletes a live server's
 * learned history.
 *
 * Those 62 are **left alone**, which is not the same as reported: nothing in
 * {@link MCPRemovalResult} names them and {@link describeMCPRemoval} never
 * mentions them, because naming them on a *particular* server's removal would
 * be the guess this refuses to make. `bernard tool-profiles` lists them like
 * any other profile, and that is the whole of their visibility. It is the same
 * answer `makeAliasResolver` gives one layer up, where an ambiguous stored name
 * resolves to `null` and every consumer fails closed.
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

/** One permission rule the sweep dropped, and where it was stored. */
export interface DroppedRule {
  /** The rule as `ruleLabel` renders it. */
  label: string;
  /** The profile that held it — not necessarily the active one. */
  profile: string;
  /** The app it was scoped to, when it was a per-app grant (#420). */
  app?: string;
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
  /**
   * Permission rules dropped, across every profile — the user's own and each
   * app's, in one flat list rather than two nested maps keyed by profile and
   * app. Flat because every consumer wants a count or a line per rule, and a
   * shape a reader has to walk twice to answer "how many" is one `sweptNothing`
   * can get wrong.
   */
  rulesRemoved: DroppedRule[];
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
  const rulesRemoved = sweepGrants(key);
  const specialists = affectedSpecialists(key, deps.specialists);

  debugLog('mcp:remove:sweep', {
    key,
    existed,
    profiles: profilesRemoved.length,
    legacy: legacyRemoved.length,
    legacyKept: legacyKept.length,
    rules: rulesRemoved.length,
    profilesTouched: new Set(rulesRemoved.map((r) => r.profile)).size,
    specialists: specialists.length,
  });

  return {
    existed,
    profilesRemoved,
    legacyRemoved,
    legacyKept,
    rulesRemoved,
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
 * **This is a refcount, and deliberately not `buildMCPAliasIndex`'s tombstone.**
 * The comparison is tempting and wrong in the direction that matters: a
 * tombstone's defining property is that it *persists* — that module says so in
 * as many words, because an entry that stopped saying "no" would let a third
 * claimant silently un-ambiguate the alias. Here the opposite is wanted. The
 * ancestor is kept while a claimant survives and removed the moment the last
 * one goes, which is what makes `remove-mcp browsermcp` after
 * `remove-mcp playwright` finish the job instead of leaving a file nothing can
 * ever collect. A reader who takes the analogy literally and makes it
 * persistent reintroduces exactly the debris this exists to remove.
 *
 * **The residual, stated because the asymmetry above would otherwise claim more
 * than it delivers.** A survivor is a profile that *claims* the ancestor
 * through `supersedes`, and that link only exists once the other server has
 * actually recorded an outcome for that tool. So a configured, live server
 * exporting the same bare name that has simply never been called for it is not
 * a survivor, and the shared pre-#413 history goes with the removed server —
 * the very cost this paragraph says it is avoiding. It cannot be closed from
 * here: knowing that server exports the name needs the live registry no CLI
 * path has. Checked on the reference install, it does not occur: every ancestor
 * that would be deleted is exported only by the server being removed.
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
 * Drops every grant for this server's tools, in **every** profile.
 *
 * `saveActiveSettings` is the right writer for a preference and the wrong one
 * here, and the asymmetry is the whole reason this crosses profiles: there is
 * one `mcp.json`, so removing a server removes it for every profile, while its
 * grants sit in each profile's own settings. Swept only in the active one, a
 * grant survives in every profile that happened not to be live — reachable by
 * switching and by nothing else, since `/tool-permissions` shows only the
 * active profile. And it is not inert debris: `mcpServerSegment` hashes the
 * server name **alone**, which is the stability property `mcp-names.ts` was
 * built for, so re-adding the server under the same key re-arms a grant the
 * user believes they revoked when they removed it.
 *
 * Editing a profile the user is not looking at is acceptable **here and not in
 * general**, which is why `updateAllProfileSettings` says so at its own
 * declaration: this only ever removes an entry addressing a tool that no longer
 * exists anywhere. It never widens a grant and never adds one.
 *
 * Both maps go in one pass rather than through `saveAppGrants`, which is
 * correctly active-profile-only — so a failure cannot leave a profile's own
 * rules swept and its app grants not.
 */
function sweepGrants(key: string): DroppedRule[] {
  const dropped: DroppedRule[] = [];

  updateAllProfileSettings((settings, profile) => {
    // Sanitized on the way in for the reason `app-grants.ts` gives: this file
    // is hand-editable, and a malformed rule that survived to the engine would
    // be matched against rather than ignored.
    const own = partitionRules(sanitizePermissionRules(settings.toolPermissions), key);
    for (const rule of own.dropped) dropped.push({ label: ruleLabel(rule), profile });

    const apps: Record<string, PermissionRule[]> = {};
    let appsChanged = false;
    for (const [appId, raw] of Object.entries(settings.appToolGrants ?? {})) {
      const split = partitionRules(sanitizePermissionRules(raw), key);
      for (const rule of split.dropped) {
        dropped.push({ label: ruleLabel(rule), profile, app: appId });
        appsChanged = true;
      }
      // `[]` removes the entry rather than leaving an empty one behind for a
      // future app to inherit by id collision — `deleteApplet`'s rule.
      if (split.kept.length > 0) apps[appId] = split.kept;
    }

    if (own.dropped.length === 0 && !appsChanged) return null;
    return {
      ...settings,
      toolPermissions: own.kept,
      ...(appsChanged ? { appToolGrants: apps } : {}),
    };
  });

  return dropped;
}

/**
 * The active profile's id, for the report alone.
 *
 * Read at render rather than carried on every {@link DroppedRule}: the profile
 * a rule was stored in is a fact about the sweep, while which profile is active
 * is a fact about right now, and folding them would make the record claim
 * something it cannot know once it is read back.
 */
function activeProfileId(): string {
  try {
    return loadProfiles().file.activeProfileId;
  } catch {
    // A profiles file that cannot be read is not a reason to lose the report;
    // every line simply gets its profile named.
    return '';
  }
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
    result.rulesRemoved.length === 0
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
  // The profile is named only when it is not the one in use: qualifying every
  // line with the active profile's own name is noise on the common path, and
  // silence on the uncommon one is what this sweep exists to end.
  const active = activeProfileId();
  for (const rule of result.rulesRemoved) {
    const where = rule.app ? `App "${rule.app}" rule` : 'Permission rule';
    const whose = rule.profile === active ? '' : ` (profile "${rule.profile}")`;
    lines.push(`  ${where} removed${whose}: ${rule.label}`);
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
