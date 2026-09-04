import { printError, printInfo } from '../output.js';
import { AppRegistry, bundledAppIds } from './registry.js';
import { parseRawAppManifest } from './manifest.js';
import { deleteApplet } from './lifecycle.js';
import { applyCspGrant, setActionGrant, type CspGrantSpec } from './manage.js';
import { SpecialistStore } from '../specialists.js';
import { uncoveredTools, uncoveredToolsMessage } from './invocation.js';
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

/**
 * Lists applets, the user's own by default.
 *
 * The default is **not** everything, and that is the point. A seeded example
 * sitting in the same flat list as the user's own work is indistinguishable
 * from it — the observed report was "I tried deleting the old apps and don't
 * know what is what". Bundled applets are still listable and still deletable;
 * they are just not mixed in unasked.
 *
 * Hiding them entirely was the other option and is worse: a bundled applet
 * still holds a port and still answers in a browser, so a listing that cannot
 * show it makes it unfindable rather than tidy.
 */
export function appList(opts: { bundled?: boolean; all?: boolean } = {}): void {
  const registry = new AppRegistry();
  const bundled = bundledAppIds();
  const ids = registry.listIds();
  const mine = ids.filter((id) => !bundled.has(id));
  const theirs = ids.filter((id) => bundled.has(id));

  if (opts.all) {
    printApps(registry, mine, 'No applets of your own yet.', 'Yours');
    printInfo('');
    printApps(registry, theirs, 'None installed.', 'Bundled');
    return;
  }

  if (opts.bundled) {
    printApps(registry, theirs, 'No bundled applets installed.');
    return;
  }

  printApps(
    registry,
    mine,
    theirs.length > 0
      ? `No applets yet. ${theirs.length} bundled example(s) installed — \`bernard app list --bundled\`.`
      : 'No applets installed.',
  );
}

/**
 * The only place a list of applets is printed.
 *
 * Was three near-identical loops, and they had already drifted: the `--all`
 * branch printed group titles but omitted the blank line between applets that
 * the other two had, so the grouped view — the one most likely to be long —
 * was the least readable.
 */
function printApps(registry: AppRegistry, ids: string[], empty: string, title?: string): void {
  if (title) printInfo(`${title}:`);
  if (ids.length === 0) {
    printInfo(title ? `  ${empty}` : empty);
    return;
  }
  ids.forEach((id, i) => {
    if (i > 0) printInfo('');
    printApp(registry, id);
  });
}

/** Word-wraps to `width`, preserving nothing else — descriptions are one line of prose. */
function wrap(text: string, width: number): string[] {
  if (!text) return [];
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

/**
 * One applet, laid out like `--help` rather than a run-on line.
 *
 * The reported problem was that the flat form was unreadable: id, name, action
 * count, then every action on its own line at one indent, with the description
 * mixed in among them. Aligning the action column and separating the applet
 * header from its body is what makes it scannable.
 */
function printApp(registry: AppRegistry, id: string): void {
  const app = registry.get(id);
  if (!app.ok) {
    printInfo(`  ${id}`);
    printInfo(`      ⚠ ${app.failure.message}`);
    return;
  }
  const { name, description, actions } = app.manifest;
  const entries = Object.entries(actions);

  printInfo(`  ${id}${name && name !== id ? `  (${name})` : ''}`);
  // Wrapped rather than left to the terminal, which breaks mid-word and
  // destroys the indent that makes the block read as one applet.
  for (const line of wrap(description ?? '', 72)) printInfo(`      ${line}`);
  if (description) printInfo('');
  if (entries.length === 0) {
    printInfo('      no actions');
    return;
  }

  // Labelled and addressed as `<app>/<action>`, because the bare name read as
  // a top-level entry: a user seeing `greet  agent  read-only  datetime` in a
  // command called `app list` tried `bernard app delete greet`. The slash form
  // is also exactly how `bernard app allow <app> <action>` addresses it, so
  // the listing now shows the thing you would type.
  //
  // The dispatch kind is deliberately gone. `agent` next to an action name
  // read as "this is an agent" in a listing that never mentions agents; how an
  // action runs is not what `app list` is for.
  printInfo('      actions:');
  const width = Math.max(...entries.map(([n]) => n.length + id.length + 1));
  for (const [actionName, action] of entries) {
    const tools = action.toolAllowlist.length ? action.toolAllowlist.join(', ') : 'no tools';
    printInfo(
      `        ${`${id}/${actionName}`.padEnd(width)}  ${action.toolMode.padEnd(9)}  ${tools}`,
    );
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
  const outcome = setActionGrant(appId, actionName, tools, opts);
  if (!outcome.ok) {
    printError(outcome.error);
    process.exitCode = 1;
    return;
  }
  printInfo(`${appId}/${actionName}:`);
  printInfo(`  tools: ${outcome.tools.length ? outcome.tools.join(', ') : '(none)'}`);
  printInfo(`  mode:  ${outcome.toolMode}`);
  // The grant is the user's and is applied either way — but a grant the
  // backing specialist cannot reach is a no-op, and silently so: the action
  // runs with a smaller registry and the agent answers that it cannot do the
  // job. This is where the two halves of the intersection first meet, so it is
  // where the mismatch is worth saying out loud.
  for (const warning of outcome.warnings) printInfo(`Warning: ${warning}`);
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
 * `bernard app csp <id>` — show or set what an applet may reach (#467, #468).
 *
 * A sibling sub-action rather than a flag on `app allow`, which is per
 * ACTION (`appId`, `actionName`, `tools`): a CSP grant is per APPLET and has
 * no action to name, so `bernard app allow demo --img-src X` would collide
 * positionally with `bernard app allow demo greet`.
 *
 * A printer over {@link applyCspGrant}, so `/applets` can offer the same thing
 * without printing into Ink's alternate screen buffer.
 */
export function appCsp(appId: string, spec: CspGrantSpec): void {
  const outcome = applyCspGrant(appId, spec);
  if (!outcome.ok) {
    printError(outcome.error);
    process.exitCode = 1;
    return;
  }
  printInfo(`${appId} may reach:`);
  for (const line of outcome.lines) printInfo(`  ${line}`);
  for (const warning of outcome.warnings) printInfo(`Warning: ${warning}`);
  printInfo('Applies to the next request — no restart needed.');
}
