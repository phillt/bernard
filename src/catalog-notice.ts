import type { CatalogRefreshDiff } from './providers/catalog.js';

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
export type CatalogNoticeKind = 'none' | 'added' | 'removed' | 'provider-wiped';

export interface CatalogNotice {
  kind: CatalogNoticeKind;
  /** User-facing text. Empty string when `kind === 'none'`. */
  message: string;
  /** Providers that lost every entry — populated only for `provider-wiped`. */
  wipedProviders: string[];
}

export interface CatalogNoticeOptions {
  /**
   * Providers this session actually depends on: `config.provider` plus every
   * provider bound to a slot of the active lineup. A provider outside this set
   * losing entries is housekeeping; one inside it going to zero is an outage.
   */
  providersInUse: string[];
}

const NONE: CatalogNotice = { kind: 'none', message: '', wipedProviders: [] };

/** `a, b, c +N more` — keeps a long list from swallowing the line. */
function nameList(names: string[], limit = 3): string {
  const head = names.slice(0, limit).join(', ');
  const rest = names.length - limit;
  return rest > 0 ? `${head} +${rest} more` : head;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
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
  if (diff.error) return NONE;
  if (diff.previousSource === 'vendored') return NONE;

  const lostProviders = new Set(diff.removed.map((e) => e.provider));
  const inUse = new Set(opts.providersInUse);
  const wipedProviders = [...lostProviders]
    .filter((p) => inUse.has(p) && (diff.byProvider[p] ?? 0) === 0)
    .sort();

  if (wipedProviders.length > 0) {
    return {
      kind: 'provider-wiped',
      wipedProviders,
      message:
        `Model catalog: ${nameList(wipedProviders)} lost every entry in this refresh ` +
        `(${diff.removed.length} ${plural(diff.removed.length, 'model', 'models')} removed). ` +
        `You have ${plural(wipedProviders.length, 'it', 'them')} configured, so context-window ` +
        `and cost figures for ${plural(wipedProviders.length, 'that provider', 'those providers')} ` +
        `will fall back to defaults (128k window, cost shown as n/a) until the catalog recovers.`,
    };
  }

  if (diff.removed.length > 0) {
    return {
      kind: 'removed',
      wipedProviders: [],
      message:
        `${diff.removed.length} ${plural(diff.removed.length, 'model', 'models')} removed from the ` +
        `catalog: ${nameList(diff.removed.map((e) => `${e.provider}/${e.model}`))}.`,
    };
  }

  if (diff.added.length > 0) {
    return {
      kind: 'added',
      wipedProviders: [],
      message:
        `${diff.added.length} new ${plural(diff.added.length, 'model', 'models')} available: ` +
        `${nameList(diff.added.map((e) => `${e.provider}/${e.model}`))}. ` +
        `Browse with /models or bind one via /lineup.`,
    };
  }

  return NONE;
}
