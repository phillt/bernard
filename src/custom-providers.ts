/**
 * @module custom-providers
 *
 * Disk-backed registry of user-defined custom providers — named endpoints
 * that wrap one of the installed AI SDKs (`@ai-sdk/openai`,
 * `@ai-sdk/anthropic`, `@ai-sdk/xai`) with a custom `baseURL` and API key.
 *
 * Lets the user route Bernard at OpenAI/Anthropic/xAI-compatible servers
 * (Ollama, LM Studio, vLLM, OpenRouter, Together, internal proxies, ...)
 * and have several such endpoints configured at once alongside the
 * built-in providers.
 *
 * Storage: `~/.config/bernard/custom-providers.json`
 * Shape:   `{ providers: Record<name, CustomProvider> }` with file mode 0600.
 *
 * API keys are NOT stored here; they live in `keys.json` keyed by the
 * provider name (the same file the built-in providers use).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CUSTOM_PROVIDERS_PATH } from './paths.js';
import { atomicWriteFileSync } from './fs-utils.js';
import type { SupportedSdk } from './providers/types.js';

/** Names reserved by built-in providers — cannot be used for custom entries. */
export const RESERVED_PROVIDER_NAMES: ReadonlySet<string> = new Set(['anthropic', 'openai', 'xai']);

/** Allowed SDK choices for a custom provider. */
export const SUPPORTED_SDKS: ReadonlyArray<SupportedSdk> = ['openai', 'anthropic', 'xai'];

/** Max remembered models per custom provider (oldest entries drop when full). */
const MODELS_CAP = 20;

const NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;
const NAME_MAX_LENGTH = 32;

/** A single registered custom provider. */
export interface CustomProvider {
  /** Provider name — used as the `--provider` value. Lowercase, [a-z0-9_-]+. */
  name: string;
  /** Which installed AI-SDK package to wrap. */
  sdk: SupportedSdk;
  /** Base URL for the provider endpoint, e.g. `http://localhost:11434/v1`. */
  baseURL: string;
  /** Default model — first one offered in the /model menu, used when switching. */
  defaultModel: string;
  /** Known models for this provider. `defaultModel` is always first. Grows as user types new model names. */
  models: string[];
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-update timestamp. */
  updatedAt: string;
}

interface CustomProvidersFile {
  providers: Record<string, CustomProvider>;
}

/**
 * Validates a custom provider name.
 * @returns An error message if invalid, or `null` if valid.
 */
export function validateProviderName(name: string): string | null {
  if (!name) return 'Provider name cannot be empty.';
  if (name.length > NAME_MAX_LENGTH)
    return `Provider name must be ${NAME_MAX_LENGTH} characters or fewer.`;
  if (!NAME_PATTERN.test(name))
    return 'Provider name must start with a lowercase letter and contain only lowercase letters, digits, hyphens, and underscores.';
  if (RESERVED_PROVIDER_NAMES.has(name))
    return `"${name}" is a built-in provider name; pick a different name for the custom entry.`;
  return null;
}

/**
 * Validates a base URL — must parse, and use http/https.
 * @returns An error message if invalid, or `null` if valid.
 */
export function validateBaseURL(url: string): string | null {
  if (!url || !url.trim()) return 'Base URL cannot be empty.';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Base URL is not a valid URL.';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return 'Base URL must use http or https.';
  return null;
}

/** Reads the custom-providers file. Fails open to an empty map on any error. */
export function loadCustomProviders(): Record<string, CustomProvider> {
  try {
    const raw = fs.readFileSync(CUSTOM_PROVIDERS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CustomProvidersFile>;
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.providers &&
      typeof parsed.providers === 'object'
    ) {
      const out: Record<string, CustomProvider> = {};
      for (const [name, entry] of Object.entries(parsed.providers)) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Partial<CustomProvider>;
        if (
          typeof e.name === 'string' &&
          typeof e.sdk === 'string' &&
          SUPPORTED_SDKS.includes(e.sdk as SupportedSdk) &&
          typeof e.baseURL === 'string' &&
          typeof e.defaultModel === 'string'
        ) {
          const models = Array.isArray(e.models)
            ? e.models.filter((m): m is string => typeof m === 'string' && m.length > 0)
            : [e.defaultModel];
          if (!models.includes(e.defaultModel)) models.unshift(e.defaultModel);
          out[name] = {
            name: e.name,
            sdk: e.sdk as SupportedSdk,
            baseURL: e.baseURL,
            defaultModel: e.defaultModel,
            models,
            createdAt: typeof e.createdAt === 'string' ? e.createdAt : new Date().toISOString(),
            updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : new Date().toISOString(),
          };
        }
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

function writeFile(providers: Record<string, CustomProvider>): void {
  fs.mkdirSync(path.dirname(CUSTOM_PROVIDERS_PATH), { recursive: true });
  const payload: CustomProvidersFile = { providers };
  atomicWriteFileSync(CUSTOM_PROVIDERS_PATH, JSON.stringify(payload, null, 2) + '\n');
  fs.chmodSync(CUSTOM_PROVIDERS_PATH, 0o600);
}

/**
 * Inserts or updates a custom provider. Validates name / sdk / baseURL /
 * defaultModel and ensures `defaultModel` is the first entry in `models`.
 *
 * @throws {Error} If any field fails validation.
 */
export function saveCustomProvider(input: {
  name: string;
  sdk: SupportedSdk;
  baseURL: string;
  defaultModel: string;
  models?: string[];
}): CustomProvider {
  const nameErr = validateProviderName(input.name);
  if (nameErr) throw new Error(nameErr);

  if (!SUPPORTED_SDKS.includes(input.sdk)) {
    throw new Error(`Unsupported SDK "${input.sdk}". Supported: ${SUPPORTED_SDKS.join(', ')}.`);
  }

  const urlErr = validateBaseURL(input.baseURL);
  if (urlErr) throw new Error(urlErr);

  const defaultModel = input.defaultModel.trim();
  if (!defaultModel) throw new Error('Default model cannot be empty.');

  const existing = loadCustomProviders();
  const now = new Date().toISOString();
  const seedModels = input.models?.filter((m) => m && m.trim().length > 0) ?? [];
  const models = [defaultModel, ...seedModels.filter((m) => m !== defaultModel)];

  const entry: CustomProvider = {
    name: input.name,
    sdk: input.sdk,
    baseURL: input.baseURL,
    defaultModel,
    models: models.slice(0, MODELS_CAP),
    createdAt: existing[input.name]?.createdAt ?? now,
    updatedAt: now,
  };

  existing[input.name] = entry;
  writeFile(existing);
  return entry;
}

/**
 * Deletes a custom provider entry. Does NOT delete the matching key in
 * `keys.json` — callers (CLI / REPL) handle key cleanup explicitly.
 *
 * @throws {Error} If no custom provider with that name exists.
 */
export function removeCustomProvider(name: string): void {
  const existing = loadCustomProviders();
  if (!existing[name]) {
    throw new Error(`No custom provider named "${name}".`);
  }
  delete existing[name];
  if (Object.keys(existing).length === 0) {
    if (fs.existsSync(CUSTOM_PROVIDERS_PATH)) {
      fs.unlinkSync(CUSTOM_PROVIDERS_PATH);
    }
  } else {
    writeFile(existing);
  }
}

/**
 * Adds `model` to the remembered list for a custom provider if not already
 * present. The default model always stays at position 0. No-op when the
 * provider is unknown.
 */
export function rememberCustomModel(name: string, model: string): void {
  const trimmed = model.trim();
  if (!trimmed) return;
  const existing = loadCustomProviders();
  const entry = existing[name];
  if (!entry) return;
  if (entry.models.includes(trimmed)) return;

  const next = [...entry.models, trimmed].slice(-MODELS_CAP);
  // Default model always first.
  const reordered = [entry.defaultModel, ...next.filter((m) => m !== entry.defaultModel)];
  existing[name] = { ...entry, models: reordered, updatedAt: new Date().toISOString() };
  writeFile(existing);
}

/** Returns true if `name` matches an existing custom provider entry. */
export function isCustomProvider(
  name: string,
  customProviders: Record<string, CustomProvider> = loadCustomProviders(),
): boolean {
  return Object.hasOwn(customProviders, name);
}
