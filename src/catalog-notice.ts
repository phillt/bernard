import { entryKey, type CatalogRefreshDiff } from './providers/catalog.js';
import { nameList, plural } from './text.js';

/**
 * Startup catalog-refresh notice (#306).
 *
 * `refreshCatalogWithDiff` has always computed `removed`, and the startup hook
 * has always thrown it away — its guard short-circuited on `added.length === 0`,
 * so a refresh that only *lost* models was silent. That is how the Vercel AI
 * Gateway's `xai/` → `spacexai/` owner rename dropped every Grok model with no
 * signal at all; it surfaced days later as two unrelated-looking symptoms (a
 * context meter pinned full, a session cost of `$0.00`), because the catalog is
 * the single upstream source for both context windows and pricing and *both*
 * call sites fail soft.
 *
 * The owner-alias table added alongside that fix handles that one rename. It
 * does nothing for the next one, so the detection has to live here: at the
 * catalog layer, keyed on what actually disappeared.
 *
 * Pure and side-effect-free — the caller owns the surfacing (toast vs. durable
 * notice) and any once-per-session latch. Modelled on `cost-guardrail.ts`.
 */

/**
 * What a refresh warrants telling the user, in ascending order of urgency.
 *
 * - `none` — nothing worth saying (or no trustworthy baseline to diff against).
 * - `added` — new models are available; the pre-existing success toast.
 * - `removed` — models disappeared, but none this session depends on.
 * - `provider-wiped` — a provider this session actually uses lost *every*
 *   entry. This is the incident shape, and the only one that must survive the
 *   next keystroke.
 */
export type CatalogNoticeKind = 'none' | 'added' | 'removed' | 'provider-wiped' | 'provider-empty';

export interface CatalogNotice {
  kind: CatalogNoticeKind;
  /** User-facing text. Empty string when `kind === 'none'`. */
  message: string;
}

export interface CatalogNoticeOptions {
  /**
   * Providers this session actually depends on: `config.provider` plus every
   * provider bound to a slot of the active lineup. A provider outside this set
   * losing entries is housekeeping; one inside it going to zero is an outage.
   */
  providersInUse: string[];
  /**
   * Per-provider counts of the bundled snapshot
   * ({@link vendoredProviderCounts}). The diff-independent baseline.
   *
   * Required rather than optional on purpose: defaulting it to `{}` would
   * silently disable the carried-over check for any caller that forgot it,
   * which is the exact class of silent degradation this notice exists to catch.
   */
  vendoredByProvider: Record<string, number>;
}

const NONE: CatalogNotice = { kind: 'none', message: '' };

/**
 * The carried-over case. Worded to distinguish it from `provider-wiped`: the
 * catalog *is* missing the provider rather than having just lost it, so the
 * recovery is a refresh, not a wait.
 */
function providerEmpty(providers: string[]): CatalogNotice {
  return {
    kind: 'provider-empty',
    message:
      `Model catalog: no entries for ${nameList(providers)}, which ` +
      `${plural(providers.length, 'is', 'are')} configured for this session. ` +
      `Context-window and cost figures for ` +
      `${plural(providers.length, 'it', 'them')} will use defaults (128k window, ` +
      `cost shown as n/a). Run /refresh-models to rebuild the catalog.`,
  };
}

/**
 * Decide what (if anything) to tell the user about a catalog refresh.
 *
 * Suppression rules, in order:
 * 1. A failed refresh says nothing — the diff is empty by construction and the
 *    gateway being unreachable is not news about the catalog's contents.
 * 2. `previousSource === 'vendored'` says nothing — a fresh install has no real
 *    baseline, so diffing the bundled snapshot against the live gateway would
 *    announce the whole catalog as new and every vendored-only entry as lost.
 *
 * A provider counts as *wiped* only when it both lost entries in this refresh
 * and now sits at zero. The second condition alone would fire on every startup
 * for any built-in provider that has never been in the catalog — `byProvider`
 * deliberately seeds all of them to `0`.
 */
export function catalogRefreshNotice(
  diff: CatalogRefreshDiff,
  opts: CatalogNoticeOptions,
): CatalogNotice {
  // Runs BEFORE both suppressions below, because neither applies to it.
  //
  // A provider can be missing from the catalog without having lost anything in
  // *this* refresh — a poisoned cache written by an earlier run yields
  // `removed: []`, so the diff-driven checks say nothing and every subsequent
  // session inherits the damage in silence. That is what the `xai` →
  // `spacexai` rename actually did: one run warned, the rest did not.
  //
  // `diff.error` must not suppress it (offline plus a bad cache is the worst
  // case, and on error `byProvider` reflects the cache we are still serving),
  // and neither must a vendored baseline (a fresh install whose first live
  // fetch drops a provider is precisely the incident).
  const emptyProviders = opts.providersInUse
    .filter((p) => (opts.vendoredByProvider[p] ?? 0) > 0 && (diff.byProvider[p] ?? 0) === 0)
    .sort();

  if (diff.error) return emptyProviders.length > 0 ? providerEmpty(emptyProviders) : NONE;
  if (diff.previousSource === 'vendored') {
    return emptyProviders.length > 0 ? providerEmpty(emptyProviders) : NONE;
  }

  const lostProviders = new Set(diff.removed.map((e) => e.provider));
  const inUse = new Set(opts.providersInUse);
  const wipedProviders = [...lostProviders]
    .filter((p) => inUse.has(p) && (diff.byProvider[p] ?? 0) === 0)
    .sort();

  if (wipedProviders.length > 0) {
    return {
      kind: 'provider-wiped',
      message:
        `Model catalog: ${nameList(wipedProviders)} lost every entry in this refresh ` +
        `(${diff.removed.length} ${plural(diff.removed.length, 'model', 'models')} removed). ` +
        `You have ${plural(wipedProviders.length, 'it', 'them')} configured, so context-window ` +
        `and cost figures for ${plural(wipedProviders.length, 'that provider', 'those providers')} ` +
        `will fall back to defaults (128k window, cost shown as n/a) until the catalog recovers.`,
    };
  }

  if (emptyProviders.length > 0) return providerEmpty(emptyProviders);

  if (diff.removed.length > 0) {
    return {
      kind: 'removed',
      message:
        `${diff.removed.length} ${plural(diff.removed.length, 'model', 'models')} removed from the ` +
        `catalog: ${nameList(diff.removed.map(entryKey))}.`,
    };
  }

  if (diff.added.length > 0) {
    return {
      kind: 'added',
      message:
        `${diff.added.length} new ${plural(diff.added.length, 'model', 'models')} available: ` +
        `${nameList(diff.added.map(entryKey))}. ` +
        `Browse with /models or bind one via /lineup.`,
    };
  }

  return NONE;
}
