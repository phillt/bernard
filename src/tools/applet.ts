import { tool } from 'ai';
import { z } from 'zod';
import { attachActionMeta } from '../framework/tools/adapter.js';
import { capSubagentResult } from './result-cap.js';
import { AppRegistry } from '../apps/registry.js';
import type { ToolOptions } from './types.js';
import { defaultAppletPage } from '../apps/page-template.js';
import { SpecialistStore, type Specialist } from '../specialists.js';
import { directInvocableRefusalByName, toolArgRefusal } from '../apps/direct-tool.js';
import type { AppletStyler, StyleOutcome } from './applet-styling.js';
import { AppletBriefStore } from '../apps/brief-store.js';
import { INTENT_FIELDS, INTENT_FIELD_LABELS, MAX_NOTE_CHARS, renderBrief } from '../apps/brief.js';
import { interviewPlaybook } from '../apps/interview.js';
import { uncoveredTools, uncoveredToolsMessage } from '../apps/invocation.js';
import {
  formatWarnings,
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
  type AppManifest,
  type AppPermissions,
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

/**
 * Prose the USER reads before making a security decision, so it is capped and
 * every renderer treats it as untrusted — Bernard states the structural fact
 * (which directive, which origins) in its own words and shows this beneath it,
 * attributed to the applet.
 */
const REASON_HELP =
  "One short sentence, in the user's terms, on what this buys THEM — " +
  '"so each headline has a thumbnail", not "required for img-src".';

const PERMISSION_REQUEST = z
  .object({
    origins: z
      .array(z.string())
      .min(1)
      .describe('Exact origins: `https://host` or `https://host:port`. No paths, no `*`.'),
    reason: z.string().max(200).optional().describe(REASON_HELP),
  })
  .strict();

/** Actions that only look. Drives the read-only block gate and the risk tier. */
const APPLET_READ_ACTIONS: ReadonlySet<string> = new Set(['read', 'list', 'logs']);

/** Actions that must be confirmed even under `confirmMode: 'auto'` (#456). */
const APPLET_HIGH_RISK_ACTIONS: ReadonlySet<string> = new Set(['delete']);

const PARAMETERS = z.object({
  action: z
    .enum(['create', 'update', 'read', 'list', 'logs', 'delete', 'style', 'brief', 'interview'])
    .describe(
      "The operation to perform. `logs` shows what this applet's buttons actually did, " +
        'including why one failed. `delete` removes the applet and everything keyed to it, ' +
        'and asks the user first. `style` hands an existing applet to the design pass — ' +
        'a new applet gets that automatically, so reach for this to restyle one. ' +
        "`brief` reads or edits the applet's design brief — what it is for and what has " +
        'been decided; `read` already returns it, so reach for `brief` to CHANGE it.',
    ),
  id: z.string().optional().describe('Applet id (kebab-case). Required for create/update/read.'),
  intent: z
    .record(z.enum(INTENT_FIELDS), z.string())
    .optional()
    .describe(
      "The design brief's intent model — what the applet is FOR, kept separately from the " +
        'page so it can be revised without rebuilding. Fields: ' +
        INTENT_FIELDS.map((f) => `\`${f}\` (${INTENT_FIELD_LABELS[f].toLowerCase()})`).join(', ') +
        '. Supply what you actually know; an empty string clears a field. Set on `create` and ' +
        'edit with `brief`.',
    ),
  note: z
    .string()
    .max(MAX_NOTE_CHARS)
    .optional()
    .describe(
      'One line for the design brief: what changed and why, or what was tried and rejected. ' +
        'REQUIRED on `update` — the next edit reads it, and a note written only when ' +
        'convenient is written once.',
    ),
  name: z.string().max(80).optional().describe('Display name (required for create)'),
  description: z
    .string()
    .max(400)
    .optional()
    .describe(
      'One line on what this applet is for. REQUIRED on create — it is what the user reads ' +
        'in `bernard app list` and in /applets, where a list of ids alone is unreadable.',
    ),
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
  permissions: z
    .object({
      imgSrc: PERMISSION_REQUEST.optional(),
      connectSrc: PERMISSION_REQUEST.optional(),
      fontSrc: PERMISSION_REQUEST.optional(),
      mediaSrc: PERMISSION_REQUEST.optional(),
      sandbox: z
        .object({
          tokens: z
            .array(z.enum(['links', 'navigate']))
            .describe(
              '`links` to open a link in a new browser window (the only setting that works — ' +
                'a popup that inherits the sandbox loads with no scripts or storage). ' +
                '`navigate` replaces the applet itself, which is right for docs and wrong ' +
                'for a feed.',
            ),
          reason: z.string().max(200).optional().describe(REASON_HELP),
        })
        .strict()
        .optional(),
    })
    .strict()
    .optional()
    .describe(
      'What this applet needs from outside its own origin, and why. REQUESTING IS NOT ' +
        'GRANTING: the user is shown this and allows or denies it, and until they allow it ' +
        'the browser blocks the load. Declare the NARROWEST set that works — the exact ' +
        'origins, never a bare `https:`. Omit entirely for an applet that only talks to ' +
        'Bernard, which is most of them.',
    ),
});

type AppletArgs = z.infer<typeof PARAMETERS>;

/**
 * Builds the `applet` tool.
 *
 * `styleApplet` is **absent by default**, and that is load-bearing rather than
 * a convenience. `createTools` builds this tool with no styler — it is a pure
 * function of its arguments and has no `AgentContext` to make one from — so
 * the instance a tool-wrapper dispatch receives cannot style. Since the design
 * pass writes by calling `applet update`, that is what makes re-entry
 * impossible without a re-entrancy flag: only the instance
 * `framework/agents/main.ts` builds, from a live ctx, can dispatch the styler.
 * See `applet-styling.ts`.
 */
export function createAppletTool(
  registry?: AppRegistry,
  requestConsent?: ToolOptions['requestPermissionConsent'],
  styleApplet?: AppletStyler,
) {
  const store = registry ?? new AppRegistry();
  return attachActionMeta(
    tool({
      description:
        'Create or edit an applet: a small local web app served on its own origin, whose ' +
        'buttons run Bernard actions. Actions are tool-less and read-only when created — the ' +
        'user grants tools with `bernard app-grant`. Deleting one asks the user first.',
      parameters: PARAMETERS,
      execute: async (
        args: AppletArgs,
        execOptions?: { abortSignal?: AbortSignal },
      ): Promise<string> => {
        try {
          // `return await`, not `return`. With `run` async a bare return hands
          // back the promise before it rejects, so this `catch` would see
          // nothing and the `Error: ` prefix `detectToolError` reads (#364)
          // would silently stop being applied.
          return await run(store, args, requestConsent, styleApplet, execOptions?.abortSignal);
        } catch (err) {
          // The `Error: ` prefix is what `detectToolError` reads (#364).
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
    {
      name: 'applet',
      // `read`/`list` stop being `medium` — they had no predicate before, so
      // they carried the same tier as `create`.
      readActions: APPLET_READ_ACTIONS,
      // `delete` sweeps six stores including any bound agent. `medium` never
      // prompts under the default `confirmMode: 'auto'`, and a static
      // `risk: 'high'` would prompt on `list` too — see `ToolMeta.riskForCall`.
      highRiskActions: APPLET_HIGH_RISK_ACTIONS,
    },
  );
}

/**
 * The brief store, built on first use.
 *
 * Lazy so that importing this module does not create `APPLET_BRIEFS_DIR` as a
 * side effect — the constructor's `mkdirSync` is 4.6 us and idempotent, so the
 * saving is the directory, not the microseconds.
 */
let briefStoreInstance: AppletBriefStore | undefined;
function briefStore(): AppletBriefStore {
  briefStoreInstance ??= new AppletBriefStore();
  return briefStoreInstance;
}

async function run(
  store: AppRegistry,
  args: AppletArgs,
  requestConsent?: ToolOptions['requestPermissionConsent'],
  styleApplet?: AppletStyler,
  abortSignal?: AbortSignal,
): Promise<string> {
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
      const shown = page === null ? '(no index.html)' : capSubagentResult(page, PAGE_PREVIEW_MAX);
      // The brief is the third thing, and `read` is the only place it is
      // loaded: someone calling this is about to edit, which is exactly when
      // knowing what was already tried is worth its tokens (#463).
      const rendered = renderBrief(briefStore().read(id));
      const briefBlock = rendered ? `\n\n--- design brief ---\n${rendered}` : '';
      return (
        `${JSON.stringify(app.manifest, null, 2)}\n\n--- index.html ---\n${shown}` + briefBlock
      );
    }
    case 'create': {
      const id = need(args.id, 'id', 'create');
      if (!APP_ID_RE.test(id)) {
        return `Error: "${id}" is not a valid applet id — lowercase letters, digits and hyphens, 2-64 characters.`;
      }
      // Required by the TOOL, not by the schema. The manifest stays tolerant
      // of a missing description because it must still read files written
      // before this and by hand; what changes is that Bernard cannot author
      // one without saying what it is for.
      need(args.description, 'description', 'create');
      const manifest = buildManifest(id, args);
      const dispatch = await checkDispatch(id, manifest.actions);
      if (dispatch.refusal) return dispatch.refusal;
      // Scaffolded when the caller supplies none, so every refusal below has a
      // remedy reachable in one call rather than being a dead end.
      const page =
        args.page ?? defaultAppletPage(manifest.name, manifest.description, manifest.actions);
      const issues = validateAppletPage(page, Object.keys(manifest.actions), {
        declaresLinkPermission: manifest.permissions?.sandbox !== undefined,
        files: args.files ?? {},
      });
      const refusal = refusalFor(issues);
      if (refusal) return refusal;

      const created = store.create(manifest, { 'index.html': page, ...(args.files ?? {}) });
      // Asked AFTER the write and BEFORE the applet opens: the applet exists
      // either way — denying a permission is not a build failure — and asking
      // once it is on screen would be asking about something the user is
      // already looking at.
      // With the applet, not after it: an applet whose brief failed to land is
      // one whose next editor re-derives intent from the page, which is the
      // defect. Before consent for the same reason the write is — nothing
      // below can turn a successful create into a failed tool call.
      if (args.intent) briefStore().write(created.id, { intent: args.intent });
      // A warning, not a refusal: `create` has to stay usable from a test and
      // from someone who knows exactly what they want, and the failure is
      // visible — a thinner applet — rather than silent.
      const noIntent = args.intent
        ? ''
        : ' No design brief — nothing records what this is for, so the next edit ' +
          'starts from the HTML. Use `interview` before building next time.';
      const consent = await askForPermissions(created.id, created.name, manifest, requestConsent);
      // BEFORE `openedNote`, which is what opens the browser: styling after
      // the open would show the scaffold and make the user refresh. The applet
      // is already on disk, so nothing here can turn a successful create into
      // a failed tool call — the rule `askForPermissions` and `openedNote`
      // already follow.
      const styled = await styleNote(created, styleApplet, abortSignal);
      return (
        `Applet "${created.name}" (${created.id}) created with ` +
        `${Object.keys(created.actions).length} action(s).` +
        grantHint(created.id, Object.keys(created.actions)) +
        consent +
        styled +
        noIntent +
        warningsFor(issues) +
        formatWarnings(dispatch.warnings) +
        (await openedNote(created.id))
      );
    }
    case 'update': {
      const id = need(args.id, 'id', 'update');
      // Required by the TOOL, not the schema — the same shape as `description`
      // on create, and for the same reason. A design brief written only when
      // convenient is written once and then drifts, which is precisely the
      // failure it exists to prevent (#463).
      need(args.note, 'note', 'update');
      const existing = store.get(id);
      if (!existing.ok) return `Error: ${existing.failure.message}`;
      // Read-modify-write on the RAW shape. The reader's manifest has already
      // been lifted, so writing it back would be rejected by its own version
      // refinement — see `RawAppManifestSchema`.
      const manifest = buildManifest(id, args, existing.manifest);
      const dispatch = await checkDispatch(id, manifest.actions);
      if (dispatch.refusal) return dispatch.refusal;
      const files: Record<string, string> = { ...(args.files ?? {}) };
      let issues: PageIssue[] = [];
      // Validated whenever a page OR a file is supplied, not only on a page
      // change. The old `args.page !== undefined` gate meant an update that
      // shipped a stylesheet and nothing else — replacing `app.css`, which is
      // an ordinary edit — reached `store.update` completely unchecked, so the
      // two refusals that exist for silent failures (a `.css` nothing links,
      // an off-origin `@import`) could not fire on the call most likely to
      // introduce them.
      const shippedFiles = args.files ?? {};
      if (args.page !== undefined || Object.keys(shippedFiles).length > 0) {
        // The page as it will be SERVED: the new one when this call supplies
        // it, otherwise the one already on disk — because "does index.html
        // link this stylesheet" is a question about the served pair, not about
        // what changed.
        const servedPage = args.page ?? store.readAsset(id, 'index.html');
        if (servedPage !== null) {
          // Validated against the manifest as it will be AFTER this update, so
          // a call that adds an action and its button in one go is not refused
          // for invoking something that does not exist yet.
          issues = validateAppletPage(servedPage, Object.keys(manifest.actions), {
            declaresLinkPermission: manifest.permissions?.sandbox !== undefined,
            files: shippedFiles,
          });
          const refusal = refusalFor(issues);
          if (refusal) return refusal;
        }
      }
      if (args.page !== undefined) files['index.html'] = args.page;
      const updated = store.update(id, manifest, files);
      briefStore().write(id, { intent: args.intent, note: args.note });
      const consent = await askForPermissions(id, updated.name, manifest, requestConsent);
      return (
        `Applet "${updated.name}" (${updated.id}) updated.` +
        consent +
        warningsFor(issues) +
        formatWarnings(dispatch.warnings)
      );
    }
    case 'logs': {
      const id = need(args.id, 'id', 'logs');
      if (!store.exists(id)) return `Error: no such applet "${id}".`;
      const { formatAppletLog } = await import('../apps/invocation-log.js');
      const lines = formatAppletLog(id, 20);
      if (lines.length === 0) {
        return `No recorded invocations for "${id}" — its buttons have not been pressed yet.`;
      }
      return capSubagentResult(lines.join('\n'), PAGE_PREVIEW_MAX);
    }
    case 'delete': {
      const id = need(args.id, 'id', 'delete');
      // The existing sweep, not a second one: `deleteApplet` orders six stores
      // deliberately (the manifest first, because that is what stops the host
      // serving it and therefore what releases the SQLite handle) and is
      // covered by a no-orphans test. This is a new door onto it.
      const { deleteApplet } = await import('../apps/lifecycle.js');
      const result = deleteApplet(id);
      if (!result.deleted) return `Error: no such applet "${id}".`;
      // Said in full because "deleted it" is wrong in both directions: it
      // understates the sweep (the data store and any bound agent go too) and
      // overstates it (the port assignment is kept, so re-adding this id
      // restores the same origin and the browser storage still held there).
      const bound =
        result.boundSpecialists.length > 0
          ? ` Also removed ${result.boundSpecialists.length} specialist(s) bound to it: ` +
            `${result.boundSpecialists.join(', ')} — they were reachable only through this applet.`
          : '';
      return (
        `Deleted applet "${id}" — its page, design brief, data store, workspace, tool grants ` +
        `and external-access grants are gone.${bound} Its port assignment is kept, so re-creating ` +
        'this id restores the same origin.'
      );
    }
    case 'interview': {
      // Returned rather than carried in the system prompt: it matters on the
      // handful of turns where someone is building an applet, and in the cached
      // prefix it would be paid for on every turn forever.
      return interviewPlaybook();
    }
    case 'brief': {
      const id = need(args.id, 'id', 'brief');
      // `exists`, not `get`: this arm never reads the manifest, and `get` runs
      // a full zod parse to produce a value that was thrown away.
      if (!store.exists(id)) return `Error: no such applet "${id}".`;
      if (args.intent === undefined && args.note === undefined) {
        return (
          renderBrief(briefStore().read(id)) ||
          `Applet "${id}" has no design brief yet. Set one with \`intent\`.`
        );
      }
      const written = briefStore().write(id, { intent: args.intent, note: args.note });
      const fields = Object.keys(written.intent).length;
      return `Updated the brief for "${id}" — ${fields} intent field(s), ${written.notes.length} note(s).`;
    }
    case 'style': {
      const id = need(args.id, 'id', 'style');
      // Before `store.get`, which is a read plus a full manifest parse: on a
      // styler-less instance — every one `createTools` builds — that work was
      // done and thrown away.
      if (!styleApplet) {
        // No styler means no live context to dispatch from — a worker surface,
        // a tool-wrapper dispatch, or a headless run. Said plainly rather than
        // reported as a styling failure, because nothing was attempted.
        return 'Error: the design pass is not available here. Ask from the main REPL.';
      }
      const existing = store.get(id);
      if (!existing.ok) return `Error: ${existing.failure.message}`;
      const outcome = await styleApplet(targetFor(existing.manifest), abortSignal);
      return outcome.styled
        ? `Restyled "${existing.manifest.name}" (${id}).` +
            (outcome.summary ? ` ${outcome.summary}` : '')
        : `Error: styling "${id}" did not run (${outcome.reason}). Its page is unchanged.`;
    }
    default:
      // Unreachable through the AI SDK, which parses against the enum first —
      // but a direct `execute` would otherwise return `undefined`, which
      // `detectResultFailure` reads as a SUCCESS with no content.
      // Read off the schema rather than restated: the hand-written list this
      // replaces had already drifted, omitting `logs`.
      return (
        `Error: unknown action "${String(args.action)}". ` +
        `Use one of: ${PARAMETERS.shape.action.options.join(', ')}.`
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
  existing?: {
    name: string;
    description?: string;
    actions: Record<string, RawAppAction>;
    permissions?: AppPermissions;
  },
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
  // Carried like the authority fields, and for a related reason: an update
  // that omits `permissions` is an edit to the page or the actions, not a
  // withdrawal of a request the user may not have answered yet.
  const permissions = (args.permissions as AppPermissions | undefined) ?? existing?.permissions;
  return {
    // Bumped ONLY when something is declared. The version union means an
    // older binary rejects the whole app rather than the field it does not
    // know, so stamping v3 on every applet would cost every existing one its
    // readability to pay for a field it does not use.
    schemaVersion: permissions ? 3 : 2,
    id,
    name: args.name ?? existing?.name ?? id,
    ...((args.description ?? existing?.description)
      ? { description: args.description ?? existing?.description }
      : {}),
    ...(permissions ? { permissions } : {}),
    actions: merged,
  };
}

/**
 * Puts what the applet just asked for in front of the user, and records what
 * they allowed (#467, #468).
 *
 * **Declaring is not granting**, and this function is the only place the two
 * meet. A manifest's `permissions` block is written by a model; nothing in it
 * reaches a response header until a person says so here, and what they say is
 * written to the profile — never back to the manifest, which the model owns.
 *
 * Fail-closed by omission: with no `requestConsent` callback there is no user
 * to ask, so nothing is granted. That is the headless path (`bernard script`,
 * a cron dispatch, a test), and it is also what happens if the callback is
 * ever forgotten at a call site — the applet is built, the browser keeps
 * blocking, and the user can grant later from `/applets` or the CLI. The
 * failure mode of forgetting is a permission that was not given, which is the
 * right direction for it to fail in.
 *
 * The returned string is what the MODEL reads, so it says what was allowed and
 * what was not: an applet whose images were denied should render source names
 * rather than dead image frames, and it cannot adapt to an answer it is not
 * told.
 */
async function askForPermissions(
  appId: string,
  appName: string,
  manifest: RawAppManifest,
  requestConsent?: ToolOptions['requestPermissionConsent'],
): Promise<string> {
  if (!manifest.permissions) return '';
  const { loadAppCspGrant, saveAppCspGrant } = await import('../apps/app-csp-grants.js');
  const { pendingPermissions, grantWith } = await import('../apps/permission-consent.js');

  const grant = loadAppCspGrant(appId);
  const pending = pendingPermissions(manifest.permissions, grant);
  if (pending.length === 0) return ' Everything it needs is already permitted.';

  const asked = pending.map((p) => p.label).join('; ');
  if (!requestConsent) {
    return (
      ` It needs permission to: ${asked} — nobody was present to ask, so this is NOT granted ` +
      'and the browser will block it. The user can allow it from /applets.'
    );
  }

  const allowed = await requestConsent({ appId, appName, pending });
  if (allowed.length > 0) saveAppCspGrant(appId, grantWith(grant, allowed));

  const yes = allowed.map((p) => p.label);
  const no = pending.filter((p) => !allowed.includes(p)).map((p) => p.label);
  const parts: string[] = [];
  if (yes.length > 0) parts.push(`The user allowed: ${yes.join('; ')}.`);
  if (no.length > 0) {
    parts.push(
      `The user did NOT allow: ${no.join('; ')} — the browser will block it, so the page ` +
        'should degrade rather than show something broken.',
    );
  }
  return ` ${parts.join(' ')}`;
}

function need<T>(value: T | undefined, field: string, action: string): T {
  if (value === undefined) throw new Error(`\`${field}\` is required for action "${action}".`);
  return value;
}

/**
 * How to actually grant the new applet its tools.
 *
 * The previous text pointed at `bernard app-grant <id>`, which **cannot do
 * it**. There are two mechanisms and they are not interchangeable:
 * `app-grant` writes `ProfileSettings.appToolGrants`, a list of
 * `PermissionRule`s that allow or deny at the gate — a REFINEMENT over tools
 * that already exist. `bernard app allow <id> <action> --tools a,b` writes the
 * manifest's `toolAllowlist`, which is what decides whether a tool is
 * CONSTRUCTED at all.
 *
 * An action created here always has an empty allowlist, because this tool
 * cannot set one (the authority split). So the very first thing a new
 * agent-backed applet needs is the command this message names, and naming the
 * wrong one meant following the instruction exactly left the button as broken
 * as before — observed, as "No datetime tool available" from a button whose
 * author had done everything right.
 */
function grantHint(appId: string, actions: string[]): string {
  if (actions.length === 0) return '';
  const example = actions[0];
  return (
    ` Its actions have no tools yet — an action with an empty allowlist can only produce text. ` +
    `Grant per action with \`bernard app allow ${appId} ${example} --tools <names>\`` +
    (actions.length > 1 ? ` (and likewise for ${actions.slice(1).join(', ')}).` : '.') +
    ' Note `bernard app-grant` is a different thing — it refines rules over tools an action' +
    ' already has, and cannot add one.'
  );
}

/**
 * Reads one applet flag without letting a missing provider key break the tool.
 *
 * `loadConfig` throws when no provider is configured, and both callers are
 * best-effort steps on a create that has already succeeded — so "could not
 * read it" behaves as "off". One owner rather than a copy per flag: the reason
 * for the catch is the non-obvious part, and the third copy is the one that
 * gets it wrong.
 */
async function appletFlag(key: 'autoOpenApplets' | 'autoStyleApplets'): Promise<boolean> {
  try {
    const { loadConfig } = await import('../config.js');
    return loadConfig()[key];
  } catch {
    return false;
  }
}

/**
 * Opens a just-built applet, and says where it is either way.
 *
 * On `create` only, never `update`: an edit mid-conversation stealing window
 * focus is worse than the defect this fixes. Best-effort by construction — the
 * URL is in the returned string whatever happened, so a model can always tell
 * the user where the applet is, and no failure here can turn a successful
 * create into a failed tool call.
 */
async function openedNote(appId: string): Promise<string> {
  if (!(await appletFlag('autoOpenApplets'))) return '';
  try {
    const { openApplet } = await import('../apps/open.js');
    const result = await openApplet(appId);
    if ('error' in result) return '';
    if (result.opened) return ` Opened it at ${result.url}.`;
    return result.note
      ? ` It is at ${result.url} (not opened: ${result.note}).`
      : ` It is at ${result.url}.`;
  } catch {
    // Nothing here may turn a successful create into a failed tool call — the
    // URL is already in the returned string. (The config read's own throw is
    // handled in `appletFlag`.)
    return '';
  }
}

/** The applet, as the design pass needs to see it. */
function targetFor(manifest: AppManifest) {
  // No brief here on purpose: the styler reaches it through `applet read`,
  // which is the one carrier. Loading it here as well put the same text in the
  // same context twice.
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description ?? '',
    actions: Object.keys(manifest.actions),
  };
}

/**
 * Runs the design pass over a just-created applet, and says what happened.
 *
 * Unconditional on create when a styler is present: the whole defect being
 * fixed is that an applet arrives looking unmade, and a page the model wrote
 * itself is exactly what the styler improves. `update` deliberately does not
 * style, so a caller who wants their exact bytes kept can create and then
 * update.
 *
 * Gated by `autoStyleApplets`, read the way `openedNote` reads
 * `autoOpenApplets` — lazily, through a dynamic import, inside a `try`,
 * because `loadConfig` throws with no provider key configured. Here that catch
 * is doubly right: with no key there is no model to dispatch anyway.
 */
async function styleNote(
  manifest: AppManifest,
  styleApplet?: AppletStyler,
  signal?: AbortSignal,
): Promise<string> {
  if (!styleApplet) return '';
  if (!(await appletFlag('autoStyleApplets'))) return '';
  // Its own try, deliberately not relying on `makeAppletStyler`'s. The applet
  // is already on disk at this point, so a throw reaching `execute`'s catch
  // would report a write that SUCCEEDED as `Error:` — telling the model to
  // retry a create that would then fail as "already exists". A second producer
  // of this callback must not be able to reintroduce that.
  let outcome: StyleOutcome;
  try {
    outcome = await styleApplet(targetFor(manifest), signal);
  } catch (err) {
    outcome = { styled: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (outcome.styled) return outcome.summary ? ` Styled it: ${outcome.summary}` : ' Styled it.';
  // Named, not swallowed. "It looks unstyled" with no reason is the report
  // that costs someone an afternoon.
  return ` It has the default page — the design pass did not run (${outcome.reason}).`;
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
async function checkDispatch(
  appId: string,
  actions: Record<string, RawAppAction>,
): Promise<{ refusal: string | null; warnings: string[] }> {
  const problems: string[] = [];
  const warnings: string[] = [];
  let specialists: SpecialistStore | undefined;
  // Keyed by specialist id, because one specialist commonly backs several
  // buttons — `SpecialistStore.get` is an existsSync + readFileSync + parse
  // every call, so without this an applet with three actions on one specialist
  // reads the same file three times.
  const seen = new Map<string, Specialist | undefined>();
  const lookup = (specialistId: string): Specialist | undefined => {
    if (!seen.has(specialistId)) {
      specialists ??= new SpecialistStore({ seed: false });
      seen.set(specialistId, specialists.get(specialistId));
    }
    return seen.get(specialistId);
  };

  for (const [name, action] of Object.entries(actions)) {
    const dispatch = action.dispatch;

    if (dispatch?.kind === 'tool') {
      const refusal =
        (await directInvocableRefusalByName(dispatch.tool)) ??
        (await toolArgRefusal(dispatch.tool, dispatch.args ?? {}));
      if (refusal) problems.push(`  - action "${name}": ${refusal}`);
      continue;
    }

    if (dispatch?.kind !== 'agent') continue;

    // The intersection rule, which until now had no code behind it.
    // `grantedToolNames` intersects the action's `toolAllowlist` with the
    // specialist's `targetTools`, so an under-declared specialist yields an
    // action with FEWER tools than its manifest promises — possibly none. It
    // then fails as a bad answer rather than an error, which is what makes it
    // so hard to see: the observed case produced "No datetime tool available"
    // from a specialist whose action declared `toolAllowlist: ['datetime']`.
    // `{{arg}}` is not a thing, and the two-channel design is why it must not
    // become one. `action.instructions` is the author-written TRUSTED channel;
    // validated args travel separately as a labelled, fenced JSON block that
    // the model is told to treat as untrusted data. Interpolating an arg into
    // the instruction string would collapse exactly the boundary that makes an
    // applet action safe to expose to a browser.
    //
    // So this warns rather than adding the feature. Observed working by luck:
    // an action whose instructions said `{{dob}}` produced the right answer
    // because the model ALSO had the real value in the args block and used
    // that one. "Reply with exactly {{dob}}" would have printed the literal.
    const placeholders = [
      ...new Set(Array.from(dispatch.instructions.matchAll(/\{\{\s*(\w+)\s*\}\}/g), (m) => m[1])),
    ];
    if (placeholders.length > 0) {
      warnings.push(
        `Action "${name}" writes ${placeholders.map((v) => `{{${v}}}`).join(', ')} in its ` +
          'instructions, which is NOT interpolated — the model receives that text literally. ' +
          'Arguments arrive separately as a JSON block the model is told to treat as untrusted ' +
          'data, and that separation is deliberate. Refer to them by name instead, e.g. ' +
          `"use the ${placeholders[0]} value from the supplied JSON".`,
      );
    }

    const allowed = action.toolAllowlist ?? [];
    const record = lookup(dispatch.specialistId);

    // An empty allowlist is legitimate for an action that only produces text,
    // so this is not warned on by itself. It IS warned on when the backing
    // specialist declares `targetTools` — that specialist was built to use
    // them, the intersection is empty, and the action will fail at the click
    // saying it has no tool. That is the exact shape observed.
    if (allowed.length === 0) {
      const wants = record?.targetTools ?? [];
      if (wants.length > 0) {
        warnings.push(
          `Action "${name}" grants no tools, but its specialist "${dispatch.specialistId}" ` +
            `targets ${wants.join(', ')}. An action gets the INTERSECTION of the two, so this ` +
            `one runs with nothing. Grant them: ` +
            `\`bernard app allow ${appId} ${name} --tools ${wants.join(',')}\`.`,
        );
      }
      continue;
    }

    // ABSENT is a warning, not a refusal, and the distinction is load-bearing:
    // the natural authoring order is to write the applet and then build and
    // bind its agent, which is exactly what `agent-builder` does. Refusing
    // here would make that sequence impossible. Run time pre-flights it with
    // its own error code. A specialist created later is picked up on the next
    // invocation — the store is read from disk per dispatch, never cached.
    if (!record) {
      warnings.push(
        `Action "${name}" names specialist "${dispatch.specialistId}", which does not exist ` +
          `yet. Create it with targetTools covering ${allowed.join(', ')} before the button is used.`,
      );
      continue;
    }

    const missing = uncoveredTools(allowed, record.targetTools);
    if (missing.length > 0) {
      // A REFUSAL where `bernard app allow` warns on the same finding. The
      // axis is who is acting: there, a user making a grant that is theirs,
      // who may fix the specialist next. Here, a model mid-authoring that will
      // not come back to it — so the applet must not be written believing it
      // works.
      problems.push(
        `  - action "${name}": ${uncoveredToolsMessage(dispatch.specialistId, allowed, missing)}`,
      );
    }
  }

  if (problems.length === 0) return { refusal: null, warnings };
  return {
    refusal:
      `Error: this applet was not written — ${problems.length} action(s) could never run:\n` +
      `${problems.join('\n')}\n` +
      'Tools callable directly are: web_read, web_search, memory, file_read_lines, file_write. ' +
      'For anything else, back the action with a specialist — and the specialist must be ' +
      "kind: 'tool-wrapper' and declare targetTools covering the action's toolAllowlist, or it " +
      'is handed no tools and answers that it cannot do the job.',
    warnings,
  };
}

/** A page is unbounded; a tool result that reaches a model is not. */
const PAGE_PREVIEW_MAX = 20_000;
