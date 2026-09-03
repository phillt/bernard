import { printError, printInfo } from '../output.js';
import type { PermissionRule, ToolPermissionEffect } from '../tool-permissions.js';
import { loadAppGrants, saveAppGrants } from './app-grants.js';
import { AppRegistry } from './registry.js';

/**
 * `bernard app-grant` — the producer for per-app permission rules (#420).
 *
 * A CLI command and nothing an agent can call, deliberately: letting a model
 * widen the authority of the app it is running inside is the escalation the
 * gate exists to prevent. Same reasoning, and the same shape, as
 * `bernard cron-grant` (#340).
 */

/**
 * Splits a `<tool>` or `<tool>:<specifier>` argument into a rule.
 *
 * The colon form is the one the rest of the system already prints —
 * `permissionKeyFor` renders `shell:git` and `cron:delete` — so a user can
 * paste back what they were shown. Only the FIRST colon splits, because an
 * action-scoped rule's specifier is itself `action:<value>`.
 */
export function parseGrantSpec(spec: string, effect: ToolPermissionEffect): PermissionRule | null {
  const trimmed = spec.trim();
  if (trimmed === '') return null;
  const colon = trimmed.indexOf(':');
  if (colon === -1) return { effect, tool: trimmed, _v: 2 };
  const tool = trimmed.slice(0, colon);
  const specifier = trimmed.slice(colon + 1);
  if (tool === '' || specifier === '') return null;
  return { effect, tool, specifier, _v: 2 };
}

function describe(rule: PermissionRule): string {
  const scope = rule.specifier === undefined ? '(any invocation)' : rule.specifier;
  return `${rule.effect.padEnd(5)} ${rule.tool} ${scope}`;
}

export async function appGrant(
  appId: string,
  specs: string[],
  opts: { deny?: boolean; clear?: boolean } = {},
): Promise<void> {
  // Resolved against the registry first so a typo'd id fails loudly rather
  // than persisting rules that address nothing.
  const app = new AppRegistry().get(appId);
  if (!app.ok) {
    printError(app.failure.message);
    process.exitCode = 1;
    return;
  }

  if (opts.clear) {
    saveAppGrants(appId, []);
    printInfo(`Cleared permission rules for "${appId}".`);
    printInfo(
      'It keeps the tools its manifest declares — rules refine that, they do not grant it.',
    );
    return;
  }

  if (specs.length === 0) {
    const current = loadAppGrants(appId) ?? [];
    printInfo(`App "${app.manifest.name}" (${appId})`);
    printInfo(
      current.length > 0
        ? `  Rules:\n${current.map((r) => `    ${describe(r)}`).join('\n')}`
        : "  No permission rules. The manifest's tool allowlist is the only limit.",
    );
    return;
  }

  const effect: ToolPermissionEffect = opts.deny ? 'deny' : 'allow';
  const rules: PermissionRule[] = [];
  for (const spec of specs) {
    const rule = parseGrantSpec(spec, effect);
    if (!rule) {
      printError(`Not a tool spec: "${spec}". Use <tool> or <tool>:<specifier>.`);
      process.exitCode = 1;
      return;
    }
    rules.push(rule);
  }

  // Replaces rather than appends. The engine scans an ordered list, so
  // "add one" is a merge whose result depends on where it landed — the whole
  // list being written at once keeps that decision where a person can see it.
  saveAppGrants(appId, rules);
  printInfo(`Permission rules for "${appId}":`);
  for (const r of rules) printInfo(`  ${describe(r)}`);
  printInfo('Applies to the next invocation — no restart needed.');
}
