import { tool } from 'ai';
import { z } from 'zod';
import { attachMeta } from '../framework/tools/adapter.js';
import { AppRegistry } from '../apps/registry.js';
import { ACTION_NAME_RE, APP_ID_RE, type RawAppManifest } from '../apps/manifest.js';

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

const ARG_SPEC = z
  .object({
    type: z.enum(['string', 'number', 'boolean', 'enum']),
    required: z.boolean().optional(),
    values: z.array(z.string()).optional().describe("Required for, and only valid on, type 'enum'"),
    maxLength: z.number().int().positive().optional().describe("Only valid on type 'string'"),
    description: z.string().max(200).optional(),
  })
  .strict();

const ACTION = z
  .object({
    description: z.string().max(400).optional(),
    args: z.record(z.string(), ARG_SPEC).optional(),
    dispatch: z
      .union([
        z.object({ kind: z.literal('agent'), specialistId: z.string(), instructions: z.string() }),
        z.object({
          kind: z.literal('tool'),
          tool: z.string(),
          args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        }),
      ])
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
      "The applet's index.html. Required for create. Plain HTML with inline <script>; it " +
        'reaches Bernard by POSTing a capability handle to /__bernard/invoke — read the ' +
        'bundled demo applet for the shape.',
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
          return run(store, args);
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

function run(store: AppRegistry, args: AppletArgs): string {
  switch (args.action) {
    case 'list': {
      const ids = store.listIds();
      return ids.length === 0 ? 'No applets.' : `Applets: ${ids.join(', ')}`;
    }
    case 'read': {
      const id = need(args.id, 'id', 'read');
      const app = store.get(id);
      if (!app.ok) return `Error: ${app.failure.message}`;
      return JSON.stringify(app.manifest, null, 2);
    }
    case 'create': {
      const id = need(args.id, 'id', 'create');
      if (!APP_ID_RE.test(id)) {
        return `Error: "${id}" is not a valid applet id — lowercase letters, digits and hyphens, 2-64 characters.`;
      }
      const manifest = buildManifest(id, args);
      const created = store.create(manifest, {
        'index.html': need(args.page, 'page', 'create'),
        ...(args.files ?? {}),
      });
      return (
        `Applet "${created.name}" (${created.id}) created with ` +
        `${Object.keys(created.actions).length} action(s). Its actions have no tools yet — ` +
        `grant them with \`bernard app-grant ${created.id}\`.`
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
      const files: Record<string, string> = { ...(args.files ?? {}) };
      if (args.page !== undefined) files['index.html'] = args.page;
      const updated = store.update(id, manifest, files);
      return `Applet "${updated.name}" (${updated.id}) updated.`;
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
  existing?: { name: string; description?: string; actions: Record<string, unknown> },
): RawAppManifest {
  const actions: Record<string, unknown> = {};
  const source = args.actions ?? {};
  for (const [actionName, spec] of Object.entries(source)) {
    if (!ACTION_NAME_RE.test(actionName)) {
      throw new Error(`"${actionName}" is not a valid action name — lowercase, digits, _ and -.`);
    }
    const prior = (existing?.actions?.[actionName] ?? {}) as Record<string, unknown>;
    actions[actionName] = {
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      ...(spec.args ? { args: spec.args } : {}),
      dispatch: spec.dispatch,
      ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
      // Carried, never authored here.
      ...(prior.toolAllowlist ? { toolAllowlist: prior.toolAllowlist } : {}),
      ...(prior.toolMode ? { toolMode: prior.toolMode } : {}),
      ...(prior.confirmMode ? { confirmMode: prior.confirmMode } : {}),
    };
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
  } as RawAppManifest;
}

function need<T>(value: T | undefined, field: string, action: string): T {
  if (value === undefined) throw new Error(`\`${field}\` is required for action "${action}".`);
  return value;
}
