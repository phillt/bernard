import { printError, printInfo } from '../output.js';
import { AppRegistry } from './registry.js';
import { parseRawAppManifest } from './manifest.js';
import { deleteApplet } from './lifecycle.js';
import { SpecialistStore } from '../specialists.js';
import { uncoveredTools } from './invocation.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { APPS_DIR, appletAssetDir } from '../paths.js';

/**
 * `bernard app` — the half of applet authoring a model may not do.
 *
 * `toolAllowlist`, `toolMode` and `confirmMode` decide what the agent behind a
 * button is permitted, and deletion sweeps six stores. Both are user
 * decisions, kept off the agent-callable `applet` tool for the reason
 * `app-grant` is: a model widening the authority of the app it runs inside is
 * the escalation the gates exist to prevent.
 */

export function appList(): void {
  const registry = new AppRegistry();
  const ids = registry.listIds();
  if (ids.length === 0) {
    printInfo('No applets installed.');
    return;
  }
  for (const id of ids) {
    const app = registry.get(id);
    if (!app.ok) {
      printInfo(`  ${id} — ⚠ ${app.failure.message}`);
      continue;
    }
    const actions = Object.entries(app.manifest.actions);
    printInfo(`  ${id} — ${app.manifest.name} (${actions.length} action(s))`);
    for (const [name, action] of actions) {
      const tools = action.toolAllowlist.length ? action.toolAllowlist.join(', ') : 'no tools';
      printInfo(`      ${name}  [${action.dispatch.kind}] ${action.toolMode}, ${tools}`);
    }
  }
}

/**
 * Sets an action's tool allowlist and mode.
 *
 * Whole-list replacement, matching `app-grant`: the allowlist is scanned as a
 * set and "add one" is a merge whose result depends on ordering nobody can
 * see. Passing no tools clears it.
 */
export function appAllow(
  appId: string,
  actionName: string,
  tools: string[],
  opts: { write?: boolean; confirm?: string } = {},
): void {
  const registry = new AppRegistry();
  const file = path.join(APPS_DIR, `${appId}.json`);
  if (!registry.exists(appId)) {
    printError(`No such app: ${appId}`);
    process.exitCode = 1;
    return;
  }
  // Read the RAW file, not the parsed manifest: the reader lifts v1 actions
  // into `dispatch`, and writing that back is rejected by the schema's own
  // version refinement.
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
    actions: Record<string, Record<string, unknown>>;
  };
  const action = raw.actions?.[actionName];
  if (!action) {
    printError(`App "${appId}" has no action "${actionName}".`);
    process.exitCode = 1;
    return;
  }
  action.toolAllowlist = tools;
  // The grant is the user's and is applied either way — but a grant the
  // backing specialist cannot reach is a no-op, and silently so: the action
  // runs with an empty registry and the agent answers that it cannot do the
  // job. This is where the two halves of the intersection first meet, so it is
  // where the mismatch is worth saying out loud.
  warnUncoveredGrant(action, tools);
  if (opts.write !== undefined) action.toolMode = opts.write ? 'write' : 'read-only';
  if (opts.confirm !== undefined) action.confirmMode = opts.confirm;

  const parsed = parseRawAppManifest(raw);
  if (!parsed.ok) {
    printError(`Refusing to write an invalid manifest: ${parsed.error}`);
    process.exitCode = 1;
    return;
  }
  registry.update(appId, parsed.value);
  printInfo(`${appId}/${actionName}:`);
  printInfo(`  tools: ${tools.length ? tools.join(', ') : '(none)'}`);
  printInfo(`  mode:  ${String(action.toolMode ?? 'read-only')}`);
  printInfo(
    "Remember the grant is an INTERSECTION with the backing specialist's targetTools — a tool " +
      'the specialist does not target stays absent.',
  );
}

export function appDelete(appId: string): void {
  const result = deleteApplet(appId);
  if (!result.deleted) {
    printError(`No such app: ${appId}`);
    process.exitCode = 1;
    return;
  }
  printInfo(`Deleted applet "${appId}" — manifest, page, data and workspace.`);
  if (result.boundSpecialists.length > 0) {
    printInfo(
      `Also removed ${result.boundSpecialists.length} specialist(s) bound to it: ` +
        `${result.boundSpecialists.join(', ')}. They were reachable only through this applet.`,
    );
  }
  printInfo(
    'Its port assignment is kept, so re-adding this id restores the same origin — and any ' +
      'browser storage still held there.',
  );
}

/** Where an applet's served files live, for a user who wants to edit them. */
export function appPath(appId: string): void {
  if (!new AppRegistry().exists(appId)) {
    printError(`No such app: ${appId}`);
    process.exitCode = 1;
    return;
  }
  printInfo(appletAssetDir(appId));
}

/**
 * Opens an applet in the default browser, starting the host if needed.
 *
 * Starting first is not politeness: `appletHostStart` already polls for a real
 * bind because "spawning returns the instant the process exists, which is well
 * before it is listening", and opening ahead of that shows a connection error
 * as the user's first impression of the feature.
 */
export async function appOpen(appId: string, opts: { open?: boolean } = {}): Promise<void> {
  const { openApplet } = await import('./open.js');
  const result = await openApplet(appId, opts);
  if ('error' in result) {
    printError(result.error);
    process.exitCode = 1;
    return;
  }
  if (result.started) printInfo('Started the applet host.');
  if (result.opened) printInfo(`Opening ${result.url}`);
  else printInfo(result.note ? `${result.note} — open it at ${result.url}` : result.url);
}

/**
 * Says so when a grant lands on a specialist that does not target the tool.
 *
 * A warning rather than a refusal: the grant itself is legitimate and the
 * specialist may be updated next. What must not happen is the user believing
 * the tool was granted when the intersection has voided it.
 */
function warnUncoveredGrant(action: Record<string, unknown>, tools: string[]): void {
  const dispatch = action.dispatch as { kind?: string; specialistId?: string } | undefined;
  if (dispatch?.kind !== 'agent' || !dispatch.specialistId || tools.length === 0) return;

  const record = new SpecialistStore({ seed: false }).get(dispatch.specialistId);
  if (!record) {
    printInfo(
      `Note: specialist "${dispatch.specialistId}" does not exist yet. Create it with ` +
        `targetTools covering ${tools.join(', ')}, or this action will run with no tools.`,
    );
    return;
  }
  const missing = uncoveredTools(tools, record.targetTools);
  if (missing.length === 0) return;
  printInfo(
    `Warning: specialist "${dispatch.specialistId}" does not target ${missing.join(', ')}. ` +
      'An action gets the INTERSECTION of its toolAllowlist and the specialist targetTools, so ' +
      `this action would run with ${
        missing.length === tools.length
          ? 'no tools at all'
          : 'only ' + tools.filter((t) => !missing.includes(t)).join(', ')
      }. Update the specialist to target [${tools.map((t) => `'${t}'`).join(', ')}].`,
  );
}
