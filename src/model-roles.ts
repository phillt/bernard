/**
 * @module model-roles
 *
 * **Single source of truth** for Bernard's functional model *roles* (#264).
 *
 * A lineup binds models along two orthogonal axes:
 *  - **Cost tier** (`premium / mid / cheap`, see {@link module:lineups}) — how
 *    much model to spend. `config.modelMode` moves every call site up/down this
 *    axis.
 *  - **Role** (defined here) — *what kind of work* the call site is doing
 *    (orchestration, delegated execution, structured tool-calling, summarizing,
 *    classification, …). The role selects which model *family* does the job;
 *    the tier selects how strong a model within that family.
 *
 * Everything role-related derives from {@link MODEL_ROLES}: the lineup slot
 * keys, the per-mode tier table ({@link DEFAULT_ROLE_TIERS}), the editor menu,
 * and the snapshot logging. Adding a 7th role is a one-place additive edit
 * here — declare it in `MODEL_ROLES` (and point a call site at it via
 * {@link SITE_ROLE} when one exists).
 */

import type { ModelSite, ModelTier, ModelMode } from './model-policy.js';

/** Stable identifier for a functional model role. */
export type RoleId =
  | 'orchestrator'
  | 'executor'
  | 'function-caller'
  | 'summarizer'
  | 'classifier'
  | 'coder';

/** A single role definition. The whole role system is derived from this list. */
export interface ModelRole {
  id: RoleId;
  /** Short human label for menus. */
  label: string;
  /** One-line description shown in the lineup editor for discoverability. */
  description: string;
  /**
   * Guidance shown in the lineup editor's detail card: *what kind of model to
   * look for* when binding this role. Phrased as advice to the user choosing a
   * model, not a description of the role's job (that's {@link description}).
   */
  lookFor: string;
  /**
   * Per-`ModelMode` cost-tier assignment for this role. This is the data behind
   * the legacy `TIER_TABLE` — re-keyed from `[mode][site]` to `[mode][role]`.
   * The values reproduce Bernard's pre-#264 per-site behavior exactly (every
   * site that maps to a role inherits that role's tier row).
   */
  defaultTiers: Record<ModelMode, ModelTier>;
}

/**
 * The canonical role list. ORDER MATTERS — it's the display order in the
 * lineup editor.
 *
 * Tier rows reproduce the legacy `TIER_TABLE`:
 *  - orchestrator ← old `main` row
 *  - executor     ← old `specialist` row
 *  - function-caller ← old `tool-wrapper` row
 *  - summarizer   ← old `compressor` row
 *  - classifier   ← old `rewriter`/`reference-*`/`specialist-detector` row
 *  - coder        ← new; mirrors `executor` (mid in balanced) as a reasonable
 *                   default until a real code-gen call site is wired up.
 */
export const MODEL_ROLES: readonly ModelRole[] = [
  {
    id: 'orchestrator',
    label: 'Orchestrator',
    description: 'Main interactive agent + cron — long-context planning & tool orchestration.',
    lookFor:
      'A strong long-context reasoner with dependable tool-calling. This model drives every turn — favor capability over cost.',
    defaultTiers: {
      'optimize-tokens': 'mid',
      balanced: 'premium',
      'optimize-performance': 'premium',
    },
  },
  {
    id: 'executor',
    label: 'Task executor',
    description:
      'Sub-agents, specialists & tasks — focused multi-step execution of delegated work.',
    lookFor:
      'A capable all-rounder that follows multi-step instructions and uses tools reliably. Balance cost against how much delegated work you run.',
    defaultTiers: {
      'optimize-tokens': 'cheap',
      balanced: 'mid',
      'optimize-performance': 'premium',
    },
  },
  {
    id: 'function-caller',
    label: 'Function caller',
    description:
      'Tool-wrapper specialists — natural language → schema-conformant structured calls.',
    lookFor:
      'A fast model with strong structured-output / JSON adherence. Argument accuracy matters more than deep reasoning here.',
    defaultTiers: {
      'optimize-tokens': 'cheap',
      balanced: 'mid',
      'optimize-performance': 'premium',
    },
  },
  {
    id: 'summarizer',
    label: 'Summarizer',
    description: 'History compression & fact extraction — synthesis, not reasoning.',
    lookFor:
      'A model good at faithful synthesis and extraction. It runs on every compression, so lean cost-efficient.',
    defaultTiers: {
      'optimize-tokens': 'cheap',
      balanced: 'mid',
      'optimize-performance': 'premium',
    },
  },
  {
    id: 'classifier',
    label: 'Classifier / router',
    description:
      'Rewriter, reference resolver/lookup, specialist detector — cheap single-shot decisions.',
    lookFor:
      'The cheapest model that still judges reliably. These are quick single-shot routing calls where latency and price dominate.',
    defaultTiers: {
      'optimize-tokens': 'cheap',
      balanced: 'cheap',
      'optimize-performance': 'premium',
    },
  },
  {
    id: 'coder',
    label: 'Coder',
    description: 'Code generation and editing — specialists that write or modify code.',
    lookFor:
      'A model strong at code generation and editing. No SITE resolves to this role; it is reached by a specialist that declares `role: "coder"` on its record (#423).',
    defaultTiers: {
      'optimize-tokens': 'cheap',
      balanced: 'mid',
      'optimize-performance': 'premium',
    },
  },
];

/** Every role id, in display order. Iterate this for lineup slots / editor. */
export const ALL_ROLE_IDS: readonly RoleId[] = MODEL_ROLES.map((r) => r.id);

/** Lookup a role definition by id. */
export function getRole(id: RoleId): ModelRole {
  const r = MODEL_ROLES.find((x) => x.id === id);
  if (!r) throw new Error(`Unknown model role "${id}".`);
  return r;
}

/**
 * `Record<ModelMode, Record<RoleId, ModelTier>>` derived from
 * `MODEL_ROLES[*].defaultTiers`. This is the new `TIER_TABLE`: given the active
 * `modelMode` and a role, it yields the cost tier to pull from the lineup.
 */
export const DEFAULT_ROLE_TIERS: Record<ModelMode, Record<RoleId, ModelTier>> = (() => {
  const modes: ModelMode[] = ['optimize-tokens', 'balanced', 'optimize-performance'];
  const out = {} as Record<ModelMode, Record<RoleId, ModelTier>>;
  for (const mode of modes) {
    const row = {} as Record<RoleId, ModelTier>;
    for (const role of MODEL_ROLES) {
      row[role.id] = role.defaultTiers[mode];
    }
    out[mode] = row;
  }
  return out;
})();

/**
 * Static map from every policy-resolved call site to its functional role.
 * Every `ModelSite` must appear here — this is the documented, single-place
 * assignment required by #264 requirement 2.
 */
export const SITE_ROLE: Record<ModelSite, RoleId> = {
  main: 'orchestrator',
  specialist: 'executor',
  'tool-wrapper': 'function-caller',
  compressor: 'summarizer',
  rewriter: 'classifier',
  'reference-resolver': 'classifier',
  'reference-lookup': 'classifier',
  'recall-filter': 'classifier',
  'specialist-detector': 'classifier',
  'applet-detector': 'classifier',
  // "Does this text support this claim?" is a classification, not generation —
  // and the role's cheap/mid tiers are what keep a per-claim check affordable.
  'claim-verifier': 'classifier',
  // Speech normalization IS classification: assign each token its semiotic
  // class, then verbalize per class. The cheap tier is what keeps a pass that
  // runs after every spoken turn affordable.
  'speech-normalizer': 'classifier',
};
