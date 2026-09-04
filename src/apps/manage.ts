import {
  isGrantableSource,
  isWildcardSource,
  normalizeSandboxTokens,
  describeCspGrant,
  isEmptyCspGrant,
  GRANTABLE_DIRECTIVES,
  DIRECTIVE_NAMES,
  SANDBOX_ALIASES,
  type AppCspGrant,
  type GrantableDirective,
} from '../host/csp-grant.js';
import { loadAppCspGrant, saveAppCspGrant } from './app-csp-grants.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppRegistry } from './registry.js';
import { APPS_DIR } from '../paths.js';
import { parseRawAppManifest } from './manifest.js';
import { SpecialistStore } from '../specialists.js';
import { uncoveredTools, uncoveredToolsMessage } from './invocation.js';

/**
 * Applet management that RETURNS rather than prints (#460, #467).
 *
 * The `apps/open.ts` split, for the same reason: `app-cli.ts` prints through
 * `printInfo` and sets `process.exitCode`, and both are wrong inside Ink's
 * alternate screen buffer — the writes land outside the render loop and a
 * failed menu action would exit the whole session non-zero. So the decision
 * lives here and the CLI is a printer over it, which is also what makes it
 * testable without a terminal.
 */

/** What a caller asked to change. An absent field leaves that directive alone. */
export interface CspGrantSpec {
  imgSrc?: string[];
  connectSrc?: string[];
  fontSrc?: string[];
  mediaSrc?: string[];
  /** CLI aliases (`links`, `navigate`) or raw tokens; resolved on the way in. */
  sandbox?: string[];
  /** Remove the whole grant. */
  clear?: boolean;
}

export type CspGrantOutcome =
  | { ok: false; error: string }
  | { ok: true; grant: AppCspGrant; lines: string[]; warnings: string[] };

/**
 * Reads or writes one applet's CSP grant.
 *
 * A spec naming nothing is a read, which is what makes `bernard app csp <id>`
 * with no flags the "show me what this applet may reach" command.
 *
 * **Whole-directive replacement, never append**, matching `appAllow` and
 * `saveAppGrants`: "add one" is a merge whose result depends on ordering
 * nobody can see, and the question a user actually asks is "what may this
 * applet reach", which has to be answerable from the grant rather than from
 * the history of how it got there.
 *
 * **An invalid source refuses the WHOLE write.** A partial grant is the worst
 * outcome available — the user believes they granted three origins, two
 * landed, and the applet half-works for reasons nothing reports.
 */
export function applyCspGrant(appId: string, spec: CspGrantSpec): CspGrantOutcome {
  if (!new AppRegistry({ seed: false }).exists(appId)) {
    return { ok: false, error: `No such app: ${appId}` };
  }

  const current = loadAppCspGrant(appId) ?? {};
  const touched =
    spec.clear === true ||
    spec.sandbox !== undefined ||
    GRANTABLE_DIRECTIVES.some((key) => spec[key] !== undefined);

  if (!touched) return report(current, []);

  if (spec.clear) {
    saveAppCspGrant(appId, {});
    return report({}, []);
  }

  const next: AppCspGrant = { ...current };
  for (const key of GRANTABLE_DIRECTIVES) {
    const sources = spec[key];
    if (sources === undefined) continue;
    const bad = sources.filter((s) => !isGrantableSource(s));
    if (bad.length > 0) {
      return {
        ok: false,
        error:
          `Not a grantable source for ${DIRECTIVE_NAMES[key]}: ${bad.join(', ')}. ` +
          'Expected scheme://host[:port] — no paths, no quoted keywords, no bare `*`.',
      };
    }
    if (sources.length === 0) delete next[key];
    else next[key] = [...new Set(sources)];
  }

  if (spec.sandbox !== undefined) {
    if (spec.sandbox.length === 0) delete next.sandbox;
    else {
      const tokens = normalizeSandboxTokens(spec.sandbox);
      if (tokens.length === 0) {
        return {
          ok: false,
          error:
            `Not a grantable sandbox setting: ${spec.sandbox.join(', ')}. ` +
            `Use ${Object.keys(SANDBOX_ALIASES).join(' or ')}.`,
        };
      }
      next.sandbox = tokens;
    }
  }

  saveAppCspGrant(appId, next);
  // Read back rather than trusting `next`: the store sanitizes on write, so
  // what is reported is what a request will actually be served.
  return report(loadAppCspGrant(appId) ?? {}, []);
}

function report(grant: AppCspGrant, extra: string[]): CspGrantOutcome {
  const lines = isEmptyCspGrant(grant)
    ? ['(nothing granted — this applet reaches only Bernard)']
    : describeCspGrant(grant);
  return { ok: true, grant, lines, warnings: [...extra, ...warningsFor(grant)] };
}

/**
 * What a user should be told about the grant they now hold.
 *
 * Said at every read as well as every write, because a grant made months ago
 * is the one whose breadth has been forgotten.
 */
export function warningsFor(grant: AppCspGrant): string[] {
  const out: string[] = [];
  const wildcards = GRANTABLE_DIRECTIVES.flatMap((key) =>
    (grant[key] ?? []).filter(isWildcardSource).map((src) => `${DIRECTIVE_NAMES[key]} ${src}`),
  );
  if (wildcards.length > 0) {
    out.push(
      `Wildcard grant: ${wildcards.join(', ')}. This covers every matching site, not a named ` +
        'few — anything the applet can put in a URL can leave the machine.',
    );
  }
  if ((grant.connectSrc ?? []).length > 0) {
    out.push(
      'A `connect-src` grant is a two-way channel: the applet can SEND data to those origins, ' +
        'not only read from them. It is the one worth re-reading.',
    );
  }
  if ((grant.sandbox ?? []).length > 0) {
    out.push(
      'A link grant is not origin-scoped — there is no way to permit links to one site only, ' +
        'so this applet may open any URL it chooses in your browser.',
    );
  }
  return out;
}

/** Directive keys a CLI flag or menu row can name, with their flag spellings. */
export const CSP_FLAGS: Record<GrantableDirective, string> = {
  imgSrc: '--img-src',
  connectSrc: '--connect-src',
  fontSrc: '--font-src',
  mediaSrc: '--media-src',
};

/** The outcome of setting one action's tool allowlist. */
export type ActionGrantOutcome =
  | { ok: false; error: string }
  | { ok: true; tools: string[]; toolMode: string; warnings: string[] };

/**
 * Sets an action's tool allowlist and mode, returning rather than printing.
 *
 * Lifted out of `appAllow` so `/applets` can offer the same operation: the
 * printer sets `process.exitCode` and writes through `printInfo`, and inside
 * Ink both are wrong — the writes land outside the render loop and a failed
 * menu action would exit the session non-zero (#460).
 *
 * Reads the RAW manifest, not the parsed one: the reader lifts a v1 action
 * into `dispatch`, and writing that back is rejected by the schema's own
 * version refinement.
 */
export function setActionGrant(
  appId: string,
  actionName: string,
  tools: string[],
  opts: { write?: boolean; confirm?: string } = {},
): ActionGrantOutcome {
  const registry = new AppRegistry({ seed: false });
  if (!registry.exists(appId)) return { ok: false, error: `No such app: ${appId}` };

  const file = path.join(APPS_DIR, `${appId}.json`);
  let raw: { actions: Record<string, Record<string, unknown>> };
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as typeof raw;
  } catch (err) {
    return { ok: false, error: `Could not read the manifest: ${(err as Error).message}` };
  }
  const action = raw.actions?.[actionName];
  if (!action) return { ok: false, error: `App "${appId}" has no action "${actionName}".` };

  action.toolAllowlist = tools;
  if (opts.write !== undefined) action.toolMode = opts.write ? 'write' : 'read-only';
  if (opts.confirm !== undefined) action.confirmMode = opts.confirm;

  const parsed = parseRawAppManifest(raw);
  if (!parsed.ok)
    return { ok: false, error: `Refusing to write an invalid manifest: ${parsed.error}` };
  registry.update(appId, parsed.value);

  return {
    ok: true,
    tools,
    toolMode: String(action.toolMode ?? 'read-only'),
    // The intersection is where a grant silently becomes a no-op, so it is
    // reported at the moment the grant is made rather than discovered later.
    warnings: uncoveredWarning(action, tools),
  };
}

/**
 * Whether the backing specialist can actually reach what was just granted.
 *
 * `buildActionTools` takes the INTERSECTION of the action's allowlist and the
 * specialist's `targetTools`, so a tool the specialist does not target stays
 * absent — and the failure is silent: the action runs with a smaller registry
 * and the agent answers that it cannot do the job.
 */
function uncoveredWarning(action: Record<string, unknown>, tools: string[]): string[] {
  const dispatch = action.dispatch as { kind?: string; specialistId?: string } | undefined;
  if (dispatch?.kind !== 'agent' || !dispatch.specialistId || tools.length === 0) return [];
  const record = new SpecialistStore({ seed: false }).get(dispatch.specialistId);
  if (!record) return [`Specialist "${dispatch.specialistId}" does not exist yet.`];
  const missing = uncoveredTools(tools, record.targetTools);
  return missing.length === 0 ? [] : [uncoveredToolsMessage(dispatch.specialistId, tools, missing)];
}

/** The tools an action's backing specialist can actually reach, for a picker. */
export function targetToolsFor(appId: string, actionName: string): string[] | null {
  const app = new AppRegistry({ seed: false }).get(appId);
  if (!app.ok) return null;
  const dispatch = app.manifest.actions[actionName]?.dispatch;
  if (!dispatch || dispatch.kind !== 'agent') return null;
  return new SpecialistStore({ seed: false }).get(dispatch.specialistId)?.targetTools ?? null;
}
