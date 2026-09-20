/**
 * @module lineups
 *
 * Disk-backed registry of **lineups**. A lineup is a user-named 2D matrix
 * binding `(role, cost-tier) → (provider, model)` (#264). The *cost tier*
 * (`premium / mid / cheap`) is how much model to spend; the *role*
 * (orchestrator, executor, function-caller, summarizer, classifier, coder —
 * see {@link module:model-roles}) is what kind of work the call site does.
 * Each role carries its own `{premium, mid, cheap}` ladder, so a user can give
 * e.g. their `coder` role a top-tier model in performance mode and a cheaper
 * one in token-saving mode.
 *
 * The active profile (`ProfileSettings.activeLineupId`) selects which lineup
 * `resolveSiteModel` consults: `site → role` (static) → `tier`
 * (via `config.modelMode`) → `lineup.roles[role][tier]`.
 *
 * Lineups may freely mix providers — built-in or custom — for any (role, tier)
 * cell. This dissolves the previous "active provider" concept.
 *
 * Storage: `~/.config/bernard/lineups.json`.
 *
 * Lineups themselves are **global**, shared across profiles, just like
 * `custom-providers.json` and `keys.json`. Only the *selection* is profile-
 * scoped.
 *
 * Pre-#264 lineups stored flat top-level `{premium, mid, cheap}` slots; those
 * are auto-migrated on load by replicating each cost slot across all roles
 * (see {@link migrateLineupShape}), so behavior is identical until a user
 * customizes a role.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { LINEUPS_PATH } from './paths.js';
import { atomicWriteFileSync } from './fs-utils.js';
import { debugLog } from './logger.js';
import { getCatalogForProvider } from './providers/catalog.js';
import { deriveTiers, type DerivedTiers } from './providers/tiers.js';
import { BUILTIN_PROVIDERS, type BuiltinProvider } from './providers/types.js';
import type { ModelParams } from './providers/model-params.js';
import { ALL_ROLE_IDS, type RoleId } from './model-roles.js';

/** The three cost-tier slots every role defines. */
export const LINEUP_TIERS = ['premium', 'mid', 'cheap'] as const;
export type LineupTier = (typeof LINEUP_TIERS)[number];

/** One (provider, model) binding for a single tier slot. */
export interface LineupSlot {
  provider: string;
  model: string;
  /**
   * Optional generation parameters for this slot (issue #286). Absent =
   * provider/model defaults (today's behavior, byte-for-byte). Keyed by
   * {@link ParamDescriptor.id}; serialized into the AI-SDK call by
   * `serializeModelParams` (`src/providers/model-params.ts`).
   */
  params?: ModelParams;
}

/** The `{premium, mid, cheap}` cost ladder for one role. */
export type RoleSlots = Record<LineupTier, LineupSlot>;

/** A single named lineup: a `role → {premium, mid, cheap}` matrix. */
export interface Lineup {
  /** Stable id used for `activeLineupId` lookups. Lowercase slug. */
  id: string;
  /** User-editable display name. */
  name: string;
  /** Per-role cost ladders. Always covers every {@link RoleId}. */
  roles: Record<RoleId, RoleSlots>;
  createdAt: string;
  updatedAt: string;
}

interface LineupsFile {
  lineups: Record<string, Lineup>;
}

const ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
const ID_MAX_LENGTH = 32;
const NAME_MAX_LENGTH = 64;

export const PROVIDER_DISPLAY_NAMES: Record<BuiltinProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  xai: 'xAI',
};

/**
 * The seeded `(tier → model)` ladder for each built-in provider.
 *
 * **This is a curated table on purpose, and it replaced a derivation.** Until
 * #447 the seed came from `deriveTiers(getCatalogForProvider(provider))`, which
 * ranks the **Vercel AI Gateway** catalog by output price and takes the
 * extremes: top = premium, median = mid, bottom = cheap. That is unsound, and
 * not marginally so — the gateway serves models the direct provider's own API
 * does not, and price extremes are exactly where those live. Measured against
 * the shipped catalog, the derivation seeded `claude-opus-4` as Anthropic's
 * premium: a RETIRED model whose entry still carries its legacy $75/MTok output
 * price, the highest of all 15 Anthropic entries where every current Opus is
 * $25. It won the slot *because* it was retired — its price was never cut — and
 * it is not a dispatchable id. With `modelMode` defaulting to `balanced` and
 * `main → orchestrator → premium`, every turn of every fresh Anthropic install
 * resolved to it. The same derivation seeded `gpt-oss-20b` and
 * `gpt-5.1-thinking` for OpenAI and `grok-4.20-multi-agent` /
 * `grok-4.1-fast-reasoning` for xAI, all four of which fail a live probe.
 *
 * No filter over THIS catalog can fix that, which is why the answer is a table
 * rather than a better heuristic: the gateway metadata carries no deprecation
 * field, a `tool-use` tag filter excludes exactly one of 84 entries (and
 * `gpt-oss-20b` carries the tag), and a recency window that drops
 * `claude-opus-4` leaves `gpt-oss-20b` (11 months) and `gpt-5.4-pro` (4) in
 * place. Nothing in the *gateway* listing says "the direct provider serves
 * this" — which is a fact about the source, not about catalogues in general.
 * The deeper fix, deliberately out of scope for a release-blocking bug, is a
 * serving dimension on `ModelCatalogEntry` populated from each provider's own
 * `GET /v1/models` under the same stale-while-revalidate contract
 * `loadCatalog` already has. That would serve seeding, repair, the `/model`
 * picker and `getDefaultModel` at once instead of one of the four.
 *
 * **Catalog membership is NOT the test, in either direction**, and this is the
 * trap to avoid when editing the rows below. Probed 2026-09-14: `grok-3-mini`
 * and `grok-4-fast-non-reasoning` dispatch fine and appear in NO catalog
 * snapshot, while `grok-4.1-fast-reasoning` IS in the catalog and returns
 * `not_found`. A catalog lookup only decides whether pricing and the context
 * window resolve (`getModelMeta` falls soft to 128k / `n/a` on a miss), which is
 * what `lineups.test.ts` asserts — it cannot tell you whether a call will land.
 * Only a probe does that: `bernard validate-lineup <id>`.
 *
 * **xAI id punctuation is inconsistent BY FAMILY**, so neither of the two
 * comments in `providers/catalog.ts` is right. `gatewayIdToModel` (`:83`)
 * asserts xAI "uses dots in both places" and `normalizeModelId` (`:351`)
 * asserts the opposite by example. Measured: `grok-4.6` OK / `grok-4-6`
 * not_found, but `grok-4-1-fast-reasoning` OK / `grok-4.1-fast-reasoning`
 * not_found. Both spellings below are deliberate; do not "normalize" them.
 *
 * Rows are probe-verified except Anthropic's — see the note there.
 *
 * Also the single source of truth for offline model names: `config.ts` derives
 * its `FALLBACK_PROVIDER_MODELS` lists from this table, so a new model name only
 * ever needs to land here.
 */
export const DEFAULT_TIERS: Record<
  BuiltinProvider,
  { premium: string; mid: string; cheap: string }
> = {
  // Verified 2026-09-14 against `GET /v1/models/{id}`, which is NOT billed and
  // needs only a valid key — so it answers where a `generateText` probe cannot,
  // on an account with no credit. All three return HTTP 200; `claude-opus-4`
  // returns 404 `not_found_error`, which is the whole premise of #447 measured
  // rather than taken from the field report.
  anthropic: {
    premium: 'claude-opus-5',
    mid: 'claude-sonnet-5',
    cheap: 'claude-haiku-4-5-20251001',
  },
  // Probed 2026-09-14. OpenAI resolves the model before billing, so a dead id
  // returns `not_found` while a live one returns a credit error — which is what
  // distinguishes these from `gpt-oss-20b` / `gpt-5.1-thinking`.
  openai: {
    premium: 'gpt-5.5',
    mid: 'gpt-5.2',
    cheap: 'gpt-5.4-nano',
  },
  // Probed 2026-09-14, all three OK. Note the mixed punctuation is real.
  xai: {
    premium: 'grok-4.6',
    mid: 'grok-4.3',
    cheap: 'grok-4-1-fast-reasoning',
  },
};

export function validateLineupId(id: string): string | null {
  if (!id) return 'Lineup id cannot be empty.';
  if (id.length > ID_MAX_LENGTH) return `Lineup id must be ${ID_MAX_LENGTH} characters or fewer.`;
  if (!ID_PATTERN.test(id))
    return 'Lineup id must start with a lowercase letter and contain only lowercase letters, digits, hyphens, and underscores.';
  return null;
}

export function validateLineupName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Lineup name cannot be empty.';
  if (trimmed.length > NAME_MAX_LENGTH)
    return `Lineup name must be ${NAME_MAX_LENGTH} characters or fewer.`;
  return null;
}

export function slugifyLineupName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ID_MAX_LENGTH);
  if (!slug) return '';
  if (/^[0-9]/.test(slug)) return `l-${slug}`.slice(0, ID_MAX_LENGTH);
  return slug;
}

export function uniqueLineupId(name: string, existing: Record<string, Lineup>): string {
  const base = slugifyLineupName(name);
  if (!base) {
    let i = 1;
    while (existing[`lineup-${i}`]) i += 1;
    return `lineup-${i}`;
  }
  if (!existing[base]) return base;
  let i = 2;
  const build = (n: number): string => {
    const suffix = `-${n}`;
    return `${base.slice(0, ID_MAX_LENGTH - suffix.length)}${suffix}`;
  };
  let candidate = build(i);
  while (existing[candidate]) {
    i += 1;
    candidate = build(i);
  }
  return candidate;
}

function isLineupSlot(v: unknown): v is LineupSlot {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as LineupSlot).provider === 'string' &&
    typeof (v as LineupSlot).model === 'string' &&
    (v as LineupSlot).provider.length > 0 &&
    (v as LineupSlot).model.length > 0
  );
}

function isRoleSlots(v: unknown): v is RoleSlots {
  if (!v || typeof v !== 'object') return false;
  return LINEUP_TIERS.every((tier) => isLineupSlot((v as Record<string, unknown>)[tier]));
}

/**
 * Copies one slot with no shared sub-objects.
 *
 * `params` is the reason this is a function rather than a spread: `{...slot}`
 * is shallow, so every cell a replication produces would point at ONE params
 * object. Latent rather than live — nothing in the tree mutates a slot's params
 * in place, and `saveLineup` serialises — but {@link cloneRoleSlots} already
 * promised "no shared slot refs" and that promise was false for this one field.
 * {@link bindEverySlot} is what makes it reachable: it is the first replicator
 * whose input can carry params (the editor's slot picker returns them), where
 * `seedForProvider` never does.
 */
function cloneSlot(slot: LineupSlot): LineupSlot {
  return { ...slot, ...(slot.params ? { params: { ...slot.params } } : {}) };
}

/** Deep-copies one `{premium, mid, cheap}` ladder (no shared slot refs). */
function cloneRoleSlots(slots: RoleSlots): RoleSlots {
  return {
    premium: cloneSlot(slots.premium),
    mid: cloneSlot(slots.mid),
    cheap: cloneSlot(slots.cheap),
  };
}

/** Builds a full `role → ladder` map, replicating one ladder across every role. */
function replicateAcrossRoles(slots: RoleSlots): Record<RoleId, RoleSlots> {
  const out = {} as Record<RoleId, RoleSlots>;
  for (const role of ALL_ROLE_IDS) out[role] = cloneRoleSlots(slots);
  return out;
}

/**
 * How many `(role, tier)` cells a lineup has — 18 today.
 *
 * Derived rather than written, because `model-roles.ts` advertises adding a 7th
 * role as a one-place additive edit and three surfaces name this number in copy
 * ("all 18 slots"). A literal would make that claim false on the day the role
 * lands, in prose, where nothing type-checks it.
 */
export const LINEUP_SLOT_COUNT = ALL_ROLE_IDS.length * LINEUP_TIERS.length;

/**
 * Binds **every** `(role, tier)` cell to one slot (#618).
 *
 * `modelMode: 'off'` used to mean "every site uses one model"; #225 retired it
 * and #606 removed the settings row on the argument that a lineup whose slots
 * all name the same model reproduces it exactly. That is true of the resolver
 * and was false of the affordance — reaching the state took 18 separate picks.
 * This is the state expressed as one value.
 *
 * Composed from {@link replicateAcrossRoles} rather than written beside it: a
 * uniform lineup IS a ladder whose three rungs are the same slot, replicated.
 * The clone happens inside, so the 18 cells share nothing.
 */
export function bindEverySlot(slot: LineupSlot): Record<RoleId, RoleSlots> {
  return replicateAcrossRoles({ premium: slot, mid: slot, cheap: slot });
}

/**
 * Canonical identity of a slot — what makes two cells "the same binding".
 *
 * `params` is part of it: two cells naming `openai/gpt-5.5` at different
 * temperatures are not one binding, and a detector that ignored the field would
 * report "every slot is gpt-5.5" on the one surface whose whole job is to say
 * so truthfully.
 *
 * Keys are sorted rather than read off `PARAM_IDS`, for two reasons. `params`
 * is not validated by {@link isLineupSlot}, so a hand-edited `lineups.json` can
 * carry a key that list does not have — iterating the known ids would silently
 * call two different slots identical. And it keeps this module off a runtime
 * edge to `providers/model-params.ts`, which today it needs only as a type.
 */
function slotIdentity(slot: LineupSlot): string {
  const params = slot.params ?? {};
  const entries = Object.keys(params)
    .sort()
    .map((k) => [k, (params as Record<string, unknown>)[k]]);
  return JSON.stringify([slot.provider, slot.model, entries]);
}

/**
 * The single binding every cell of `roles` holds, or `null` when they differ.
 *
 * The legibility half of #618: a uniform lineup should READ as uniform instead
 * of having to be checked slot by slot. Deliberately returns the slot rather
 * than a boolean, so a caller can name the model without re-deriving it — the
 * shape {@link derivedLadderIfUnmodified} already argues for a few functions
 * down, and for the same reason (the predecessor there recovered the models by
 * indexing `ALL_ROLE_IDS[0]`, correct only by an unstated invariant).
 *
 * Phrasing is deliberately left to each caller. The `/lineups` list, the
 * editor's detail card and `lineup_edit`'s matrix each say it in their own
 * voice and at their own width; a shared label would be the lowest common
 * denominator of three surfaces that legitimately differ. This module answers
 * *whether, and to what* — not *how to put it*.
 */
export function uniformSlot(roles: Record<RoleId, RoleSlots>): LineupSlot | null {
  const first = roles[ALL_ROLE_IDS[0]].premium;
  const want = slotIdentity(first);
  for (const role of ALL_ROLE_IDS) {
    for (const tier of LINEUP_TIERS) {
      if (slotIdentity(roles[role][tier]) !== want) return null;
    }
  }
  // A copy, so a caller cannot reach back into the lineup through the answer.
  return cloneSlot(first);
}

function writeFile(lineups: Record<string, Lineup>): void {
  fs.mkdirSync(path.dirname(LINEUPS_PATH), { recursive: true });
  const payload: LineupsFile = { lineups };
  atomicWriteFileSync(LINEUPS_PATH, JSON.stringify(payload, null, 2) + '\n');
}

function nowIso(): string {
  return new Date().toISOString();
}

function seedForProvider(provider: BuiltinProvider, now: string): Lineup {
  const tiers = DEFAULT_TIERS[provider];
  const ladder: RoleSlots = {
    premium: { provider, model: tiers.premium },
    mid: { provider, model: tiers.mid },
    cheap: { provider, model: tiers.cheap },
  };
  return {
    id: provider,
    name: `${PROVIDER_DISPLAY_NAMES[provider]}-only`,
    roles: replicateAcrossRoles(ladder),
    createdAt: now,
    updatedAt: now,
  };
}

function buildSeedLineups(): Record<string, Lineup> {
  const now = nowIso();
  const out: Record<string, Lineup> = {};
  for (const provider of BUILTIN_PROVIDERS) {
    out[provider] = seedForProvider(provider, now);
  }
  return out;
}

/**
 * Adds default lineups for any built-in provider not yet present on disk.
 * Existing lineups (including user-edited slot picks) are left untouched.
 * Returns the merged map and only writes when something actually changed.
 */
export function seedDefaultLineups(existing: Record<string, Lineup>): Record<string, Lineup> {
  const now = nowIso();
  let mutated = false;
  const out: Record<string, Lineup> = { ...existing };
  for (const provider of BUILTIN_PROVIDERS) {
    if (out[provider]) continue;
    out[provider] = seedForProvider(provider, now);
    mutated = true;
  }
  if (mutated) {
    try {
      writeFile(out);
    } catch {
      // best-effort; return the merged map regardless
    }
  }
  return out;
}

/**
 * Normalizes one stored lineup entry into the current role-keyed shape,
 * migrating where needed. Returns `null` for unrecoverable entries (caller
 * drops them and re-seeds if the map ends up empty).
 *
 * Handled shapes:
 *  1. **Old flat** (`{premium, mid, cheap}` at top level, no `roles`): replicate
 *     the cost ladder across every role → behavior identical to pre-#264.
 *  2. **Role-keyed** (`{roles: {...}}`): validate each known role; backfill any
 *     role missing from `ALL_ROLE_IDS` (e.g. a role added after this lineup was
 *     saved) from an anchor role (`orchestrator`, else the first valid role).
 *  3. **Neither**: `null`.
 *
 * Sets `mutatedRef.value = true` whenever it changes the on-disk shape so the
 * caller can persist the upgrade.
 */
function migrateLineupShape(
  id: string,
  entry: unknown,
  mutatedRef: { value: boolean },
): Lineup | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== 'string' || typeof e.name !== 'string') return null;
  // One clock read, not two, and only when a timestamp is actually missing.
  // These were independent `nowIso()` calls, so a file missing BOTH got two
  // values that are usually but not reliably equal — enough to make a later
  // equality check on them flaky for reasons nothing in the record explains.
  // Lazy because `loadLineups` is uncached and hot (see `model-policy.ts`), and
  // a healthy file never needs the value at all.
  let migratedAt: string | undefined;
  const at = (): string => (migratedAt ??= nowIso());
  const createdAt = typeof e.createdAt === 'string' ? e.createdAt : at();
  const updatedAt = typeof e.updatedAt === 'string' ? e.updatedAt : at();

  // Case 2 — already role-keyed.
  if (e.roles && typeof e.roles === 'object') {
    const stored = e.roles as Record<string, unknown>;
    // Anchor for backfilling missing roles: prefer orchestrator, else any valid.
    const anchorId = ALL_ROLE_IDS.find((r) => isRoleSlots(stored[r])) ?? null;
    if (!anchorId) return null;
    const anchor = stored[anchorId] as RoleSlots;
    const roles = {} as Record<RoleId, RoleSlots>;
    for (const role of ALL_ROLE_IDS) {
      if (isRoleSlots(stored[role])) {
        roles[role] = cloneRoleSlots(stored[role] as RoleSlots);
      } else {
        roles[role] = cloneRoleSlots(anchor);
        mutatedRef.value = true; // backfilled a missing/invalid role
      }
    }
    return { id: e.id, name: e.name, roles, createdAt, updatedAt };
  }

  // Case 1 — legacy flat shape.
  if (isLineupSlot(e.premium) && isLineupSlot(e.mid) && isLineupSlot(e.cheap)) {
    mutatedRef.value = true;
    const ladder: RoleSlots = {
      premium: e.premium,
      mid: e.mid,
      cheap: e.cheap,
    };
    return {
      id: e.id,
      name: e.name,
      roles: replicateAcrossRoles(ladder),
      createdAt,
      updatedAt,
    };
  }

  return null;
}

/**
 * Model ids that a past seeder wrote and that cannot dispatch.
 *
 * Keyed `provider/model` via {@link modelKey}. Deliberately tiny and
 * deliberately hand-maintained:
 * this is the belt-and-braces half of repair, and its whole job is to guarantee
 * #447 is fixed even for an install whose ladder no longer matches what
 * {@link deriveTiers} produces today (the user seeded months ago against a
 * different gateway snapshot, so the content match below cannot recognise it).
 *
 * **The bar for adding an entry is a live probe the model cannot pass** — not
 * "expensive", not "stale", not "absent from the catalog" (see
 * {@link DEFAULT_TIERS} for why membership settles nothing). Silently rewriting
 * a *working* config is a worse trade than leaving it. Every id here is one the
 * old price-ranked derivation actually seeded.
 *
 * Three return `not_found`. `grok-4.20-multi-agent` instead returns `Bad
 * Request`, with or without a temperature parameter, while its siblings
 * `grok-4.20-reasoning` and `grok-4.20-non-reasoning` both answer normally — so
 * it is the model that is unreachable here, not the call shape. It matters more
 * than the others: it is the legacy derived **mid** for xAI, and `balanced`
 * routes every specialist, wrapper and compressor call through mid.
 *
 * Probed 2026-09-14. Three return `not_found` from a completion call;
 * `claude-opus-4` returns HTTP 404 `not_found_error` from
 * `GET /v1/models/claude-opus-4`, which is unbilled and so answers on an
 * account with no credit.
 */
const DEAD_SEEDED_MODELS: ReadonlySet<string> = new Set([
  'anthropic/claude-opus-4',
  'openai/gpt-oss-20b',
  'openai/gpt-5.1-thinking',
  // NOT a typo for `DEFAULT_TIERS.xai.cheap`, which is `grok-4-1-fast-reasoning`
  // — one character apart, and both spellings are deliberate. The DOTTED form
  // here is the gateway's, which xAI's API rejects; the DASHED form there is
  // the one that dispatches. `normalizeModelId` folds them together for catalog
  // lookup, which is exactly why this looks like a mistake and is not. Running
  // either through it would break one of the two.
  'xai/grok-4.1-fast-reasoning',
  'xai/grok-4.20-multi-agent',
]);

/**
 * `provider/model` — the spelling `entryKey` (`providers/catalog.ts`),
 * `distinctPairs` and `formatProbeLine` already use, so the startup notice and
 * `bernard validate-lineup` name the same slot the same way. A colon is this
 * repo's permission NAMESPACE separator (`shell:git`), a different idea.
 */
function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/**
 * The curated ladder for a slot's provider, or `null` when it is a custom one.
 *
 * Every {@link DEAD_SEEDED_MODELS} entry names a built-in today, so the `null`
 * arm is unreachable — but a slot's provider is a free string and a custom
 * provider has no curated ladder, so indexing without the check is how a
 * `undefined[tier]` throw arrives later from a file somebody hand-edited.
 */
function curatedTiersFor(provider: string): { premium: string; mid: string; cheap: string } | null {
  return (BUILTIN_PROVIDERS as readonly string[]).includes(provider)
    ? DEFAULT_TIERS[provider as BuiltinProvider]
    : null;
}

/** What {@link repairBuiltinLineups} changed, for the caller to surface. */
export interface LineupRepairReport {
  /** Lineup ids rewritten, in `BUILTIN_PROVIDERS` order. */
  ids: string[];
  /** False when the repair applied in memory but could not be saved. */
  persisted: boolean;
  /**
   * The subset of replaced models that are KNOWN not to dispatch, `provider/model`.
   *
   * Deliberately not "everything that changed". A ladder match re-seeds the
   * whole lineup, so most of what it replaces was working fine — listing
   * `grok-4.6` under a notice about models that do not work is a false alarm in
   * the one message whose job is to explain a change the user did not ask for.
   * Empty is normal and means "this was an old machine seed, now refreshed".
   */
  dead: string[];
}

/**
 * Set by {@link repairBuiltinLineups}, drained by
 * {@link consumeLineupRepairReport}.
 *
 * `repairReported` is a latch on the REPORT and the WRITE, never on the
 * transform — and that distinction is the whole correctness argument.
 * `writeFile`'s failure is swallowed below, so on a read-only filesystem the
 * repair must not retry a temp-write + rename on every `loadLineups()`, which
 * is once per `resolveSiteModel`, i.e. dozens of times per turn.
 *
 * But latching the TRANSFORM to achieve that left the process split-brained: a
 * failed write meant load #1 returned the repaired map while every later load
 * re-read the broken file and was refused a repair, so within a single turn the
 * first call site got the fixed model and the rest got the dead one — which
 * reads as a flaky provider rather than a configuration problem. The repair is
 * therefore applied on every load and costs nothing in the healthy case, where
 * the written file trips `derivedLadderIfUnmodified`'s curated early-out.
 */
let repairReported = false;
let lastRepair: LineupRepairReport | null = null;

/**
 * Hands over the last repair report and clears it, so a caller that renders a
 * startup notice cannot render it twice. Returns `null` when nothing was
 * repaired this process.
 */
export function consumeLineupRepairReport(): LineupRepairReport | null {
  const report = lastRepair;
  lastRepair = null;
  return report;
}

/**
 * True when every role×tier slot is exactly what {@link deriveTiers} produces
 * for this provider today — i.e. the lineup is an unmodified machine seed from
 * before #447.
 *
 * Content, not timestamps. `createdAt === updatedAt` looks like an "untouched"
 * signal and is not one: `saveLineup` binds a single `now` and writes it to
 * both fields, so every newly *created* user lineup satisfies it; `renameLineup`
 * bumps `updatedAt` alone, so a renamed-but-unedited lineup would never be
 * repaired though it is still broken; and a hand-edited file looks untouched.
 * Matching content has none of those failure modes and is idempotent by
 * construction — after the rewrite the slots no longer match, so it cannot
 * re-fire.
 *
 * The residual false NEGATIVE is a user seeded against an older catalog
 * snapshot, whose ladder today's derivation no longer reproduces;
 * {@link DEAD_SEEDED_MODELS} is what covers the case that actually crashes.
 *
 * Returns the ladder it matched rather than a boolean, so the caller can name
 * the models it is about to replace without re-deriving them. The predecessor
 * returned `boolean` and the caller recovered them by indexing
 * `ALL_ROLE_IDS[0]` — correct only because `replicateAcrossRoles` makes every
 * role identical, which is a fact stated nowhere near the read.
 *
 * **Known decay, accepted deliberately.** This recognises a historical fact by
 * re-running a price sort over third-party data on a 24h refresh, so the day
 * the gateway drops or reprices `claude-opus-4` the rule silently stops firing
 * — and `tiers.test.ts` pins against the *vendored* snapshot, not the user's
 * live cache, so CI stays green while field behaviour changes. Freezing the
 * three ladders as literals would make it a fact that cannot rot, but it also
 * narrows recognition to installs seeded when that snapshot was current, and
 * the live sort is strictly better for the recently-seeded majority. Neither
 * covers an install seeded months ago; {@link DEAD_SEEDED_MODELS} is what does.
 * The mechanism that retires this whole question is provenance — a `version` on
 * `LineupsFile` and a `seededBy` stamp on a seeded lineup, so repair reads a
 * field instead of sniffing content.
 */
function derivedLadderIfUnmodified(lineup: Lineup, provider: BuiltinProvider): DerivedTiers | null {
  // Cheapest rejection first: this spares a hand-edited or already-repaired
  // lineup the catalog filter + sort below, which on the steady state is every
  // install. It must compare ALL THREE tiers, not just `premium` — a one-tier
  // early-out shipped briefly and silently disabled rule 1 for xAI, whose
  // derived premium (`grok-4.6`) happens to EQUAL the curated one, leaving the
  // failing `grok-4.20-multi-agent` in `mid`. A curated ladder and a derived
  // one can agree on a cell; they cannot agree on all three.
  const first = lineup.roles[ALL_ROLE_IDS[0]];
  const curated = DEFAULT_TIERS[provider];
  if (first.premium.provider !== provider) return null;
  if (LINEUP_TIERS.every((tier) => first[tier].model === curated[tier])) return null;

  const entries = getCatalogForProvider(provider);
  // `deriveTiers` throws only on an empty list, which this rules out — so there
  // is deliberately no try/catch here to imply otherwise.
  if (entries.length === 0) return null;
  const derived = deriveTiers(entries);
  for (const role of ALL_ROLE_IDS) {
    const ladder = lineup.roles[role];
    for (const tier of LINEUP_TIERS) {
      const slot = ladder[tier];
      if (slot.provider !== provider || slot.model !== derived[tier]) return null;
      // Params are reachable from the lineup editor WITHOUT changing a model,
      // so a lineup carrying any is one the user has configured — and the
      // re-seed below builds fresh slots and would silently drop them. Decline
      // rule 1 here; rule 2 still rescues a dead model and preserves params,
      // so the two rules agree about never discarding this field.
      if (slot.params !== undefined) return null;
    }
  }
  return derived;
}

/**
 * Replaces any slot holding a {@link DEAD_SEEDED_MODELS} id with this tier's
 * curated model. Mutates `lineup.roles` in place, records what it replaced into
 * `dead`, and returns whether it changed anything.
 */
function replaceDeadSlots(lineup: Lineup, dead: Set<string>): boolean {
  let changed = false;
  for (const role of ALL_ROLE_IDS) {
    const ladder = lineup.roles[role];
    for (const tier of LINEUP_TIERS) {
      const slot = ladder[tier];
      const key = modelKey(slot.provider, slot.model);
      if (!DEAD_SEEDED_MODELS.has(key)) continue;
      // The replacement comes from the SLOT's provider, never the lineup's.
      // A lineup may freely mix providers (see the module docstring), so an
      // `anthropic` lineup can legitimately hold an `openai` cell — and taking
      // the model from `DEFAULT_TIERS[provider]` there produced
      // `{provider:'openai', model:'claude-sonnet-5'}`, a pair that cannot
      // exist, reported to the user as "refreshed".
      const curated = curatedTiersFor(slot.provider);
      if (!curated) continue;
      dead.add(key);
      ladder[tier] = { ...slot, model: curated[tier] };
      changed = true;
    }
  }
  return changed;
}

/**
 * Rewrites built-in-provider lineups that a pre-#447 seeder produced, in place.
 * Returns true when anything changed, so the caller can fold the write into the
 * one it may already be doing for a shape migration.
 *
 * Scoped to lineups whose id IS a built-in provider, because only the seeder
 * creates those — `uniqueLineupId` de-duplicates a user's own "anthropic" to
 * `anthropic-2` while the seeds exist. A user who deletes a seed and recreates
 * the id is still safe: their slot picks will not match all 18 cells of the
 * derived ladder.
 *
 * Concurrency: the REPL, the cron daemon and the applet host all share
 * `lineups.json`, so two processes can repair at once. `atomicWriteFileSync`
 * keeps the file from tearing, and last-writer-wins is benign for a narrower
 * reason than "the rules agree": neither rule's OUTPUT depends on what it read.
 * Both write `DEFAULT_TIERS`, a compiled-in constant, so two racing repairs
 * produce identical bytes. An edit that made the replacement catalog-dependent
 * would break this silently — that, not rule disagreement, is what to guard.
 */
function repairBuiltinLineups(map: Record<string, Lineup>): boolean {
  const ids: string[] = [];
  const dead = new Set<string>();
  const now = nowIso();
  for (const provider of BUILTIN_PROVIDERS) {
    const lineup = map[provider];
    if (!lineup) continue;

    // Rule 1 (reads the live catalog): an untouched pre-#447 machine seed →
    // re-seed the whole lineup, which is the only way `mid` and `cheap` are
    // restored. Keep `name` and `createdAt`: a rename is cosmetic and must not
    // cost the user their label, and the lineup really was created when it says.
    const derived = derivedLadderIfUnmodified(lineup, provider);
    if (derived) {
      for (const tier of LINEUP_TIERS) {
        const key = modelKey(provider, derived[tier]);
        if (DEAD_SEEDED_MODELS.has(key)) dead.add(key);
      }
      map[provider] = {
        ...seedForProvider(provider, now),
        name: lineup.name,
        createdAt: lineup.createdAt,
      };
      ids.push(provider);
      continue;
    }

    // Rule 2 (no catalog, static list): a known-dead id survived in a lineup
    // whose ladder rule 1 can no longer reproduce — seeded against an older
    // snapshot. Per-slot, so the user's other picks stay.
    if (replaceDeadSlots(lineup, dead)) {
      lineup.updatedAt = now;
      ids.push(provider);
    }
  }
  if (ids.length === 0) return false;
  // Reported once per process, while the transform above runs every load. A
  // second identical notice for the same repair is noise, and this latch is
  // what bounds the repair's contribution to the write: it requests one, once.
  //
  // It does NOT bound writes in general, and the difference matters if you are
  // reading this to reason about a read-only filesystem. `writeFile` below is
  // gated on `mutatedRef.value`, which `migrateLineupShape` also sets when it
  // backfills a missing role — and a failed write leaves that role missing, so
  // the migration re-detects it and re-requests a write on every load. That is
  // pre-existing and deliberately left alone: a shape migration retrying is how
  // it recovers from a TRANSIENT failure, and the cost is one temp-write that
  // fails fast on EACCES. The repair cannot use that argument, because it would
  // also re-announce itself and re-do work that is already correct in memory.
  if (!repairReported) {
    repairReported = true;
    const report: LineupRepairReport = { ids, dead: [...dead], persisted: true };
    lastRepair = report;
    // Unconditional, not behind the REPL's notice: `script`, `cron-run` and the
    // applet host repair too and have nowhere to render one.
    debugLog('lineup:repaired', report);
    return true;
  }
  return false;
}

/**
 * Reads `lineups.json`. If the file is missing or unparseable, seeds the
 * three built-in provider lineups, persists them, and returns the result.
 * Always returns at least the seeded set so callers never have to handle an
 * empty-map case. Auto-migrates legacy flat lineups and backfills newly-added
 * roles, persisting the upgraded shape when anything changed.
 */
export function loadLineups(): Record<string, Lineup> {
  try {
    const raw = fs.readFileSync(LINEUPS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<LineupsFile>;
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.lineups &&
      typeof parsed.lineups === 'object'
    ) {
      const out: Record<string, Lineup> = {};
      const mutatedRef = { value: false };
      for (const [id, entry] of Object.entries(parsed.lineups)) {
        const migrated = migrateLineupShape(id, entry, mutatedRef);
        if (migrated) out[id] = migrated;
        else mutatedRef.value = true; // dropped a corrupt entry
      }
      if (Object.keys(out).length > 0) {
        // Before the write below, so a repair and a shape migration cost one
        // write rather than two.
        if (repairBuiltinLineups(out)) mutatedRef.value = true;
        if (mutatedRef.value) {
          try {
            writeFile(out);
          } catch {
            // best-effort; the in-memory migration still applies this session.
            // The repair did too, but it will not survive the process — say so
            // rather than letting the notice claim a refresh that is not saved.
            if (lastRepair) lastRepair.persisted = false;
          }
        }
        return out;
      }
    }
  } catch {
    // fall through to seed
  }

  const seeded = buildSeedLineups();
  try {
    writeFile(seeded);
  } catch {
    // best-effort; return the in-memory seed regardless
  }
  return seeded;
}

/**
 * Resolves the active lineup id. Precedence:
 *   1. Explicit `activeLineupId` arg (from `ProfileSettings.activeLineupId`).
 *   2. A lineup whose `id` matches `fallbackProviderName` (e.g. the legacy
 *      `config.provider`, so users upgrading land on the seeded lineup for
 *      whichever built-in they had selected).
 *   3. The first lineup in iteration order.
 * Throws only if the map is empty (shouldn't happen because `loadLineups`
 * always seeds).
 */
export function resolveActiveLineup(
  lineups: Record<string, Lineup>,
  activeLineupId: string | undefined,
  fallbackProviderName: string | undefined,
): Lineup {
  if (activeLineupId && lineups[activeLineupId]) return lineups[activeLineupId];
  if (fallbackProviderName && lineups[fallbackProviderName]) return lineups[fallbackProviderName];
  const first = Object.values(lineups)[0];
  if (!first)
    throw new Error('No lineups available. This is a bug — loadLineups should always seed.');
  return first;
}

/** Outcome of {@link resolveActiveLineupWithCorrection}. */
export interface LineupResolution {
  /** The lineup that will actually be used. */
  lineup: Lineup;
  /**
   * Set only when `activeLineupId` was non-empty but pointed at a lineup that
   * doesn't exist (e.g. a stale id left over from a deleted lineup, or a typo in
   * a hand-edited profile). Carries the id that was requested and the id we fell
   * back to, so the caller can persist the correction and tell the user.
   */
  corrected?: { requestedId: string; resolvedId: string };
}

/**
 * Like {@link resolveActiveLineup}, but additionally reports whether the
 * requested `activeLineupId` was *invalid* (set, but absent from `lineups`).
 * When that happens the caller should persist `corrected.resolvedId` back onto
 * the active profile and surface a note so the silent fallback isn't invisible.
 *
 * An empty/undefined `activeLineupId` is NOT a correction — that's the normal
 * "no explicit selection, use the provider/first fallback" path.
 */
export function resolveActiveLineupWithCorrection(
  lineups: Record<string, Lineup>,
  activeLineupId: string | undefined,
  fallbackProviderName: string | undefined,
): LineupResolution {
  const lineup = resolveActiveLineup(lineups, activeLineupId, fallbackProviderName);
  if (activeLineupId && !lineups[activeLineupId]) {
    return { lineup, corrected: { requestedId: activeLineupId, resolvedId: lineup.id } };
  }
  return { lineup };
}

export interface SaveLineupInput {
  id?: string;
  name: string;
  roles: Record<RoleId, RoleSlots>;
}

/**
 * Inserts or updates a lineup. When `input.id` is omitted, a fresh slug is
 * derived from `input.name`. Returns the persisted entry.
 *
 * @throws on invalid name/id or empty slot fields.
 */
export function saveLineup(input: SaveLineupInput): Lineup {
  const nameErr = validateLineupName(input.name);
  if (nameErr) throw new Error(nameErr);
  for (const role of ALL_ROLE_IDS) {
    const ladder = input.roles[role];
    for (const tier of LINEUP_TIERS) {
      if (!isLineupSlot(ladder?.[tier])) {
        throw new Error(`Role "${role}" tier "${tier}" must have non-empty provider and model.`);
      }
    }
  }
  const existing = loadLineups();
  const id = input.id ?? uniqueLineupId(input.name, existing);
  const idErr = validateLineupId(id);
  if (idErr) throw new Error(idErr);
  const now = nowIso();
  const roles = {} as Record<RoleId, RoleSlots>;
  for (const role of ALL_ROLE_IDS) roles[role] = cloneRoleSlots(input.roles[role]);
  const entry: Lineup = {
    id,
    name: input.name.trim(),
    roles,
    createdAt: existing[id]?.createdAt ?? now,
    updatedAt: now,
  };
  existing[id] = entry;
  writeFile(existing);
  return entry;
}

export function renameLineup(id: string, newName: string): Lineup {
  const nameErr = validateLineupName(newName);
  if (nameErr) throw new Error(nameErr);
  const existing = loadLineups();
  const target = existing[id];
  if (!target) throw new Error(`No lineup with id "${id}".`);
  const updated: Lineup = { ...target, name: newName.trim(), updatedAt: nowIso() };
  existing[id] = updated;
  writeFile(existing);
  return updated;
}

/**
 * Deletes a lineup. Refuses to delete the last remaining lineup so callers
 * always have something to resolve against.
 *
 * @throws when `id` is unknown or it's the last remaining entry.
 */
export function deleteLineup(id: string): void {
  const existing = loadLineups();
  if (!existing[id]) throw new Error(`No lineup with id "${id}".`);
  if (Object.keys(existing).length <= 1)
    throw new Error('Cannot delete the last remaining lineup.');
  delete existing[id];
  writeFile(existing);
}

/** Lists all lineups in iteration order. */
export function listLineups(): Lineup[] {
  return Object.values(loadLineups());
}
