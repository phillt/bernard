import { tool } from 'ai';
import { z } from 'zod';
import { attachMeta } from '../framework/tools/adapter.js';
import { AppRegistry } from '../apps/registry.js';
import { defaultAppletPage } from '../apps/page-template.js';
import { directInvocableRefusalByName, toolArgRefusal } from '../apps/direct-tool.js';
import {
  refusalFor,
  validateAppletPage,
  warningsFor,
  type PageIssue,
} from '../apps/page-validate.js';
import {
  ACTION_NAME_RE,
  APP_ID_RE,
  AgentDispatchFields,
  ArgSpecFields,
  ToolDispatchFields,
  type RawAppAction,
  type RawAppManifest,
} from '../apps/manifest.js';

/**
 * `applet` — authoring the small local web apps Bernard serves.
 *
 * **The authority fields are deliberately absent, and that is the whole
 * design.** `toolAllowlist`, `toolMode` and `confirmMode` decide what the
 * agent behind a button may *do*; `bernard app-grant` and `bernard app` own
 * them, for the reason `app-grants.ts` already gives about itself — *"letting
 * a model widen the authority of the app it is running inside is the
 * escalation the gate exists to prevent."* A manifest's `toolAllowlist` is the
 * PRIMARY control (it decides which tools are constructed at all), so writing
 * it is strictly more power than the grants tool is denied.
 *
 * What a model can therefore build is a working applet whose actions are
 * read-only and tool-less — the schema already defaults `toolAllowlist: []`
 * and `toolMode: 'read-only'`. That is not a crippled applet: an action that
 * summarises, reformats or answers from its arguments needs no tools at all.
 * Anything more is a user granting it at a CLI, exactly as permissions already
 * work.
 *
 * Deletion is CLI-only for the same reason plus a second one: it sweeps six
 * stores including bound specialists, and a model removing an artifact the
 * user is relying on is not an edit.
 *
 * `audience: 'main'` in the group table, and no `directInvocable`, so an
 * applet action can never reach this and author applets.
 */

/**
 * The manifest's own schemas, re-advertised to the model.
 *
 * Derived, never re-typed. A hand copy drops whatever the source gains — the
 * first cut of this file had already lost `values.min(1)`, `maxLength.max()`
 * and all three of `ArgSpecSchema`'s cross-field rules — and worse, a field
 * added to the manifest would be silently unauthorable here, because the model
 * can only set what the advertised schema names.
 *
 * `ArgSpecFields` rather than `ArgSpecSchema`, and the dispatch objects rather
 * than `DispatchSchema`, because a refinement or a `.default()` transform makes
 * a `ZodEffects` and changes what `zod-to-json-schema` emits for a tool
 * parameter (the hazard #341 records). The refinements are not lost, only
 * deferred: `store.create`/`store.update` parse with `parseRawAppManifest`
 * before anything is written, so a malformed spec is refused — one beat later,
 * with the real schema's message.
 */
const ARG_SPEC = ArgSpecFields.describe('One argument the button collects');

const ACTION = z
  .object({
    description: z.string().max(400).optional(),
    args: z.record(z.string(), ARG_SPEC).optional(),
    dispatch: z
      .union([AgentDispatchFields, ToolDispatchFields])
      .describe(
        'How the button runs. `tool` calls one tool directly with no model — free and ' +
          'deterministic, and the right choice whenever the work has a known shape. `agent` ' +
          'dispatches a specialist and costs tokens.',
      ),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

const PARAMETERS = z.object({
  action: z.enum(['create', 'update', 'read', 'list']).describe('The operation to perform'),
  id: z.string().optional().describe('Applet id (kebab-case). Required for create/update/read.'),
  name: z.string().max(80).optional().describe('Display name (required for create)'),
  description: z.string().max(400).optional(),
  actions: z
    .record(z.string(), ACTION)
    .optional()
    .describe('The buttons this applet offers, by name. Required for create.'),
  page: z
    .string()
    .optional()
    .describe(
      "The applet's index.html. OPTIONAL — omit it and a working page is scaffolded from " +
        'the actions, which is the fastest way to a running applet. When you do write one, ' +
        'it MUST: link <link rel="stylesheet" href="/__bernard/tokens.css"> (inline <style> ' +
        'is refused by the CSP and renders nothing), link <link rel="manifest" ' +
        'href="/__bernard/manifest.webmanifest">, and load the client with a plain ' +
        '<script src="/__bernard/applet.js"></script> — never type="module", which is ' +
        "deferred. Then call `await bernard.invoke('action', args)`, which resolves to the " +
        'result and throws on failure, and `bernard.store.get/set/list/delete`. Never fetch ' +
        '/__bernard/* yourself: a hand-rolled request omits the session header and gets a 403, ' +
        'and writing one is refused. `applet read <id>` returns an existing page to copy from.',
    ),
  files: z
    .record(z.string(), z.string())
    .optional()
    .describe('Additional files to serve, by plain filename (no directories).'),
});

type AppletArgs = z.infer<typeof PARAMETERS>;

export function createAppletTool(registry?: AppRegistry) {
  const store = registry ?? new AppRegistry();
  return attachMeta(
    tool({
      description:
        'Create or edit an applet: a small local web app served on its own origin, whose ' +
        'buttons run Bernard actions. Actions are tool-less and read-only when created — the ' +
        'user grants tools with `bernard app-grant`. Deleting an applet is CLI-only.',
      parameters: PARAMETERS,
      execute: async (args: AppletArgs): Promise<string> => {
        try {
          // `return await`, not `return`. With `run` async a bare return hands
          // back the promise before it rejects, so this `catch` would see
          // nothing and the `Error: ` prefix `detectToolError` reads (#364)
          // would silently stop being applied.
          return await run(store, args);
        } catch (err) {
          // The `Error: ` prefix is what `detectToolError` reads (#364).
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
    {
      name: 'applet',
      kind: 'write',
      deterministic: false,
      sideEffect: 'local',
      cacheable: false,
      actionScoped: true,
    },
  );
}

async function run(store: AppRegistry, args: AppletArgs): Promise<string> {
  switch (args.action) {
    case 'list': {
      const ids = store.listIds();
      return ids.length === 0 ? 'No applets.' : `Applets: ${ids.join(', ')}`;
    }
    case 'read': {
      const id = need(args.id, 'id', 'read');
      const app = store.get(id);
      if (!app.ok) return `Error: ${app.failure.message}`;
      // The page, not only the manifest. The `page` field's own description
      // tells a model to read an existing applet for the shape, and until now
      // this branch returned the manifest alone — so the instruction it was
      // given could not be followed.
      const page = store.readAsset(id, 'index.html');
      const shown = page === null ? '(no index.html)' : clampPage(page);
      return `${JSON.stringify(app.manifest, null, 2)}\n\n--- index.html ---\n${shown}`;
    }
    case 'create': {
      const id = need(args.id, 'id', 'create');
      if (!APP_ID_RE.test(id)) {
        return `Error: "${id}" is not a valid applet id — lowercase letters, digits and hyphens, 2-64 characters.`;
      }
      const manifest = buildManifest(id, args);
      const dispatchRefusal = await checkDispatch(manifest.actions);
      if (dispatchRefusal) return dispatchRefusal;
      // Scaffolded when the caller supplies none, so every refusal below has a
      // remedy reachable in one call rather than being a dead end.
      const page =
        args.page ?? defaultAppletPage(manifest.name, manifest.description, manifest.actions);
      const issues = validateAppletPage(page, Object.keys(manifest.actions));
      const refusal = refusalFor(issues);
      if (refusal) return refusal;

      const created = store.create(manifest, { 'index.html': page, ...(args.files ?? {}) });
      return (
        `Applet "${created.name}" (${created.id}) created with ` +
        `${Object.keys(created.actions).length} action(s). Its actions have no tools yet — ` +
        `grant them with \`bernard app-grant ${created.id}\`.` +
        warningsFor(issues)
      );
    }
    case 'update': {
      const id = need(args.id, 'id', 'update');
      const existing = store.get(id);
      if (!existing.ok) return `Error: ${existing.failure.message}`;
      // Read-modify-write on the RAW shape. The reader's manifest has already
      // been lifted, so writing it back would be rejected by its own version
      // refinement — see `RawAppManifestSchema`.
      const manifest = buildManifest(id, args, existing.manifest);
      const dispatchRefusal = await checkDispatch(manifest.actions);
      if (dispatchRefusal) return dispatchRefusal;
      const files: Record<string, string> = { ...(args.files ?? {}) };
      let issues: PageIssue[] = [];
      if (args.page !== undefined) {
        // Validated against the manifest as it will be AFTER this update, so a
        // call that adds an action and its button in one go is not refused for
        // invoking something that does not exist yet.
        issues = validateAppletPage(args.page, Object.keys(manifest.actions));
        const refusal = refusalFor(issues);
        if (refusal) return refusal;
        files['index.html'] = args.page;
      }
      const updated = store.update(id, manifest, files);
      return `Applet "${updated.name}" (${updated.id}) updated.` + warningsFor(issues);
    }
    default:
      // Unreachable through the AI SDK, which parses against the enum first —
      // but a direct `execute` would otherwise return `undefined`, which
      // `detectResultFailure` reads as a SUCCESS with no content.
      return (
        `Error: unknown action "${String(args.action)}". Use create, update, read or list. ` +
        'Deleting an applet is `bernard app delete`, not this tool.'
      );
  }
}

/**
 * Builds the raw manifest, carrying forward the authority fields this tool
 * cannot set.
 *
 * On update those come from the record on disk, so an edit never silently
 * revokes a grant the user made — and never widens one either, since nothing
 * here can name them.
 */
function buildManifest(
  id: string,
  args: AppletArgs,
  existing?: { name: string; description?: string; actions: Record<string, RawAppAction> },
): RawAppManifest {
  const actions: Record<string, RawAppAction> = {};
  const source = args.actions ?? {};
  for (const [actionName, spec] of Object.entries(source)) {
    if (!ACTION_NAME_RE.test(actionName)) {
      throw new Error(`"${actionName}" is not a valid action name — lowercase, digits, _ and -.`);
    }
    const prior = existing?.actions?.[actionName];
    actions[actionName] = {
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      ...(spec.args ? { args: spec.args } : {}),
      dispatch: spec.dispatch,
      ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
      // Carried, never authored here — see `AUTHORITY_ACTION_FIELDS`.
      ...(prior?.toolAllowlist ? { toolAllowlist: prior.toolAllowlist } : {}),
      ...(prior?.toolMode ? { toolMode: prior.toolMode } : {}),
      ...(prior?.confirmMode ? { confirmMode: prior.confirmMode } : {}),
    } as RawAppAction;
  }
  const merged = args.actions ? actions : (existing?.actions ?? {});
  return {
    schemaVersion: 2,
    id,
    name: args.name ?? existing?.name ?? id,
    ...((args.description ?? existing?.description)
      ? { description: args.description ?? existing?.description }
      : {}),
    actions: merged,
  };
}

function need<T>(value: T | undefined, field: string, action: string): T {
  if (value === undefined) throw new Error(`\`${field}\` is required for action "${action}".`);
  return value;
}

/**
 * Refuses a manifest whose actions could never run.
 *
 * Gated on a `kind: 'tool'` action actually being present, so the common
 * agent-backed applet builds no registry and pays nothing.
 *
 * An unknown `specialistId` is deliberately a WARNING, not a refusal, and that
 * is the whole reason the boundary is "immutable relative to the write". A
 * tool's eligibility is compiled in — `datetime` will never become eligible.
 * A specialist is user state, and the natural authoring order is to create the
 * applet and then create and bind its agent, which `agent-builder` depends on;
 * refusing here would break that sequence. It is already pre-flighted at run
 * time with its own error code.
 */
async function checkDispatch(actions: Record<string, RawAppAction>): Promise<string | null> {
  const problems: string[] = [];
  for (const [name, action] of Object.entries(actions)) {
    const dispatch = action.dispatch;
    if (dispatch?.kind !== 'tool') continue;
    const refusal =
      (await directInvocableRefusalByName(dispatch.tool)) ??
      (await toolArgRefusal(dispatch.tool, dispatch.args ?? {}));
    if (refusal) problems.push(`  - action "${name}": ${refusal}`);
  }
  if (problems.length === 0) return null;
  return (
    `Error: this applet was not written — ${problems.length} action(s) could never run:\n` +
    `${problems.join('\n')}\n` +
    'Tools callable directly are: web_read, web_search, memory, file_read_lines, file_write. ' +
    'For anything else, back the action with a specialist: ' +
    "dispatch: { kind: 'agent', specialistId: '...', instructions: '...' }."
  );
}

/** A page is unbounded; a tool result that reaches a model is not. */
const PAGE_PREVIEW_MAX = 20_000;

function clampPage(page: string): string {
  return page.length <= PAGE_PREVIEW_MAX
    ? page
    : `${page.slice(0, PAGE_PREVIEW_MAX)}\n… (truncated, ${page.length} chars total)`;
}
