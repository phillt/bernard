import type { SupportedSdk } from './providers/types.js';
import { debugLog } from './logger.js';

/**
 * Is this API key valid? — answered without spending anything (#447).
 *
 * ## Why this exists when `validateModel` already probes a provider
 *
 * That one calls `generateText`, which is a **billed completion**, and so it
 * cannot answer this question at all. Its own docstring records the measurement:
 * on an account with no credit Anthropic answers `Your credit balance is too
 * low` for *every* model, valid or not, and the probe reports `unknown` for all
 * of them. A perfectly good key comes back as a failure.
 *
 * The rule this module exists to honour is that a valid key on an empty account
 * is **valid**. We care whether the key authenticates, not whether the account
 * owes money.
 *
 * The important move is that the billing case is not CLASSIFIED, it is designed
 * out: `GET /models` is metadata, it is not billed, and it needs only a valid
 * key — so there is no billing error to mistake for an auth error. The same
 * endpoint is how #447's premise was finally measured by hand, recorded in
 * `model-validate.ts` as a curl recipe with zero call sites until now.
 *
 * ## It takes an endpoint, never a provider name
 *
 * Keying off `provider === 'anthropic'` would take a key minted for someone's
 * private gateway and send it to `api.anthropic.com`. Two live paths reach this
 * code with a non-vendor endpoint: a custom provider (its own `baseURL`, which
 * the setup hub lists alongside the built-ins), and `config.providerBaseUrl`,
 * which re-points a built-in SDK. So the caller resolves the endpoint and this
 * module never learns what anything is called.
 */

/**
 * What a check concluded. **Three states, all the way to the pixel.**
 *
 * A boolean cannot say "I could not tell", so every uncertain answer would
 * collapse into "invalid" — which is the exact shape of the bug this module
 * exists to avoid, reintroduced one type further out.
 */
export interface CheckVerdict {
  tone: 'ok' | 'bad' | 'unknown';
  /** Shown to the reader verbatim. Never contains the key. */
  message: string;
}

/** Vendor endpoints, used only when nothing else names one. */
const DEFAULT_BASE_URL: Record<SupportedSdk, string> = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  xai: 'https://api.x.ai/v1',
};

/** The date-pinned version header Anthropic requires on every request. */
const ANTHROPIC_VERSION = '2023-06-01';

/** Long enough for a cold TLS handshake, short enough that a hang still ends. */
const DEFAULT_TIMEOUT_MS = 8_000;

export function defaultBaseUrl(sdk: SupportedSdk): string {
  return DEFAULT_BASE_URL[sdk];
}

/**
 * Where a check for this SDK and base URL goes.
 *
 * Joined with `URL` rather than concatenated: a custom `baseURL` usually already
 * ends in `/v1`, and `base + '/models'` yields `/v1/v1/models` against a server
 * that then 404s — which would read as "your key is bad".
 */
export function keyCheckEndpoint(sdk: SupportedSdk, baseURL?: string): URL {
  const base =
    baseURL !== undefined && baseURL.trim().length > 0 ? baseURL.trim() : defaultBaseUrl(sdk);
  return new URL('models', base.endsWith('/') ? base : `${base}/`);
}

/** The auth header this SDK's API expects. One shape per SDK, never per name. */
function authHeaders(sdk: SupportedSdk, key: string): Record<string, string> {
  return sdk === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION }
    : { authorization: `Bearer ${key}` };
}

/**
 * A pasted key, as the provider will see it.
 *
 * People paste `"sk-ant-…"` out of a JSON blob, or with the newline the
 * clipboard brought along. A stray character turns a good key into a 401, and
 * the feature then confidently reports the opposite of the truth — which is the
 * likeliest false "invalid" in practice.
 */
export function tidyKey(raw: string): string {
  const trimmed = raw.trim();
  const quoted = /^(["'])(.*)\1$/s.exec(trimmed);
  return (quoted ? quoted[2] : trimmed).trim();
}

/**
 * Ask the provider whether this key authenticates. Never throws.
 *
 * The status table is the whole contract:
 *
 * | status | verdict | why |
 * |--------|---------|-----|
 * | 200 | `ok` | it authenticated, and nothing was billed |
 * | 401 | `bad` | a genuine authentication failure — the only trustworthy "no" |
 * | 403 | `unknown` | authenticated but not permitted. Anthropic's
 *                     `permission_error` and OpenAI's scoped project keys both
 *                     land here with a VALID key, so calling it invalid would
 *                     break the rule one status code over |
 * | 429 | `ok` | it authenticated; being throttled says nothing about the key |
 * | 404 | `unknown` | a custom base URL with no models route |
 * | other, throw, timeout | `unknown` | never "invalid" because the network is down |
 *
 * The body is deliberately not parsed. A 200 is a 200, and a shape check only
 * invents a new way for a working key to read as `unknown` when one vendor's
 * list differs from another's.
 */
export async function checkProviderKey(opts: {
  sdk: SupportedSdk;
  key: string;
  /** Absent means the vendor default for this SDK. */
  baseURL?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Injected in tests; the global otherwise. */
  fetchImpl?: typeof fetch;
}): Promise<CheckVerdict> {
  const key = tidyKey(opts.key);
  if (key.length === 0) return { tone: 'unknown', message: 'No key to check.' };

  const url = keyCheckEndpoint(opts.sdk, opts.baseURL);
  const doFetch = opts.fetchImpl ?? fetch;
  // A hard bound, because the overlay draws no spinner — a hang and a freeze
  // look identical there, so the only mitigation is that the wait always ends.
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  try {
    const res = await doFetch(url, { method: 'GET', headers: authHeaders(opts.sdk, key), signal });
    // Host and status only. The key never reaches the log, and neither does the
    // response body, which can echo request material.
    debugLog('keycheck', { host: url.host, sdk: opts.sdk, status: res.status });
    return verdictForStatus(res.status, url.host);
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    debugLog('keycheck:failed', { host: url.host, sdk: opts.sdk, aborted });
    return {
      tone: 'unknown',
      message: aborted
        ? `Couldn't check — ${url.host} did not answer in time.`
        : `Couldn't check — ${url.host} could not be reached.`,
    };
  }
}

function verdictForStatus(status: number, host: string): CheckVerdict {
  if (status === 200) return { tone: 'ok', message: 'Key is valid.' };
  if (status === 401) return { tone: 'bad', message: `Key rejected by ${host}.` };
  if (status === 429) {
    // It authenticated. Saying only "valid" before a first call that may be
    // throttled would read as a promise the next screen breaks.
    return { tone: 'ok', message: 'Key is valid (rate limited right now).' };
  }
  if (status === 403) {
    return { tone: 'unknown', message: `Key works but ${host} would not list models for it.` };
  }
  if (status === 404) {
    return { tone: 'unknown', message: `Couldn't check — ${host} has no model list.` };
  }
  return { tone: 'unknown', message: `Couldn't check — ${host} answered ${status}.` };
}
