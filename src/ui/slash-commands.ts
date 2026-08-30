/**
 * The single source of truth for Bernard's slash commands (#390).
 *
 * A data module, not a component one, for the reason `line-geometry.ts` is
 * split from `use-line-editor.tsx` and `mouse.ts` from `useMouseWheel.ts`: the
 * catalogue is plain data, and living inside `SlashHints.tsx` meant every
 * consumer — including a test that renders nothing — pulled Ink and React in
 * behind it. That is also what lets `App.tsx` import {@link DispatchedCommand}
 * from here (#393) without a cycle back through the component that owns the
 * dispatch.
 *
 * `SlashHints.tsx` re-exports the three original names, so existing importers
 * are unaffected.
 */

/**
 * Every command literal `<App>.handleSubmit` branches on (#393).
 *
 * This array is **load-bearing at compile time**, and that is the whole point.
 * A hand-written list checked only by a test against {@link SLASH_COMMANDS} is
 * blind to the failure that actually happened: someone writes
 * `if (text === '/foo')` without listing it here, and nothing anywhere
 * objects — which is exactly how `/session-log` shipped dispatched and
 * undocumented. So `App.tsx` routes every branch condition through the typed
 * `is` / `startsWithCmd` helpers declared beside `handleSubmit`, whose second
 * parameter is {@link DispatchedCommand}. An unlisted command is then a type
 * error at the branch itself, which is louder and earlier than any test.
 *
 * That leaves this module free of Ink and React, which is why the array lives
 * here and not in `App.tsx`: `__tests__/slash-catalogue.test.ts` renders
 * nothing and should not drag a ~45-module component graph in to compare two
 * string sets. It replaces a regex that read `App.tsx` as source text, knew two
 * branch shapes, and silently lost coverage for any third.
 *
 * Order follows the dispatch chain so the two read as one document. Names not
 * in {@link SLASH_COMMANDS} are dispatched on purpose (aliases, deprecation
 * pointers) and are enumerated with their reasons in the test's
 * `DELIBERATELY_UNDOCUMENTED`.
 */
export const DISPATCHED_COMMANDS = [
  '/exit',
  '/quit',
  '/clear',
  '/help',
  '/session-log',
  '/refresh-models',
  '/memory',
  '/scratch',
  '/compact',
  '/policy',
  '/usage',
  '/cost',
  '/mcp',
  '/cron',
  '/rag',
  '/facts',
  '/update',
  '/theme',
  '/tool-permissions',
  '/voice',
  '/provider',
  '/models',
  '/model',
  '/lineup',
  '/lineups',
  '/agent-options',
  '/profiles',
  '/manage-profiles',
  '/options',
  '/routines',
  '/specialists',
  '/candidates',
  '/create-routine',
  '/create-task',
  '/create-specialist',
  '/task',
  '/image',
  '/react',
  '/tool-details',
  '/debug',
] as const;

/** One of the literals in {@link DISPATCHED_COMMANDS}. */
export type DispatchedCommand = (typeof DISPATCHED_COMMANDS)[number];

export interface SlashCommand {
  /**
   * Not narrowed to {@link DispatchedCommand}: the dynamic routine completions
   * `App.tsx` synthesizes from the user's `RoutineStore` are `SlashCommand`s
   * too, and their names (`/{routine-id}`) exist only at runtime.
   * {@link SLASH_COMMANDS} narrows it via {@link BuiltinSlashCommand}.
   */
  name: string;
  /** One-line gloss for the prompt-adjacent hint strip, which is narrow. */
  description: string;
  /**
   * What the help screen shows instead, when it has something *more* to say.
   * Falls back to {@link description}, which is the case for most commands —
   * carrying two strings that mean the same thing just gives them somewhere to
   * drift apart, so this field is deliberately rare.
   *
   * The bar is additional information or a wording that is only true on one
   * surface, never a reword of the same content at a different length. Two
   * shapes clear it. `/help` is deictic: its row inside the help screen reads
   * "Show this help", which is wrong on the hint strip where that screen is not
   * open. `/options` and `/agent-options` elide with `…` on the strip and name
   * the actual option groups here, where there is a full frame to spend.
   */
  detail?: string;
}

/**
 * A catalogue entry, as distinct from a runtime-synthesized routine
 * completion. Narrowing `name` here is the other half of the #393 guarantee:
 * documenting a command that nothing dispatches is a compile error too, so the
 * two directions of drift are both closed at build time rather than one at
 * build time and one in a test.
 */
interface BuiltinSlashCommand extends SlashCommand {
  name: DispatchedCommand;
}

/**
 * The single source of truth for Bernard's slash commands (#390).
 *
 * This list feeds **both** the autocomplete hint strip (via
 * {@link matchSlashCommands}) and the `Commands` section of `<HelpOverlay>`,
 * which derives its rows from here rather than keeping a second table. It used
 * to keep one, and the only mechanism holding the two together was a comment
 * telling the reader to sync them by hand: they had drifted to 33 vs. 30
 * entries with four disagreeing descriptions, and `/session-log` — a working
 * command — appeared in neither.
 *
 * `<App>.handleSubmit`'s if-chain cannot be derived from here (its branches
 * close over REPL state), so {@link DISPATCHED_COMMANDS} stands in for it and
 * `__tests__/slash-catalogue.test.ts` reconciles the two sets. Adding a command
 * means adding it here AND to that dispatch — but neither omission is silent
 * any more: the branch won't compile without the name in
 * {@link DISPATCHED_COMMANDS}, and an entry here whose name isn't in it won't
 * compile either.
 *
 * Items the user can't dispatch directly from the prompt (variants with
 * required args) belong in the help screen, not here.
 */
export const SLASH_COMMANDS: readonly BuiltinSlashCommand[] = [
  { name: '/help', description: 'Show command list', detail: 'Show this help' },
  { name: '/clear', description: 'Clear conversation (--save / -s to summarize first)' },
  { name: '/compact', description: 'Compress conversation history in-place' },
  { name: '/task', description: 'Run an isolated task (no history, structured output)' },
  { name: '/image', description: 'Attach an image: /image <path> [prompt]' },
  { name: '/memory', description: 'List persistent memories' },
  { name: '/scratch', description: 'List session scratch notes' },
  { name: '/mcp', description: 'List MCP servers and tools' },
  { name: '/cron', description: 'Show cron jobs and daemon status' },
  { name: '/rag', description: 'Toggle / inspect the RAG store' },
  { name: '/facts', description: 'Show RAG facts in the current context window' },
  { name: '/policy', description: 'Show last policy decision' },
  { name: '/usage', description: 'Last turn token + cost breakdown by tier (alias /cost)' },
  { name: '/session-log', description: 'Show the debug session-log path (BERNARD_DEBUG=1)' },
  { name: '/lineup', description: 'Edit the active lineup (per-role × premium/mid/cheap)' },
  { name: '/lineups', description: 'List, switch, or create tier lineups' },
  { name: '/models', description: 'Browse the model catalog and add custom providers' },
  { name: '/refresh-models', description: 'Force-refresh the model catalog from the gateway' },
  { name: '/provider', description: 'Manage providers (alias of /models)' },
  { name: '/theme', description: 'Switch color theme' },
  { name: '/voice', description: 'Toggle text-to-speech readback and backend' },
  { name: '/routines', description: 'List saved routines' },
  { name: '/create-routine', description: 'Create a routine with guided AI assistance' },
  { name: '/create-task', description: 'Create a task routine with guided AI assistance' },
  { name: '/specialists', description: 'List specialist agents' },
  { name: '/create-specialist', description: 'Create a specialist with guided AI assistance' },
  { name: '/candidates', description: 'Review specialist suggestions' },
  {
    name: '/options',
    description: 'View and set options (max-tokens, max-steps, …)',
    detail: 'View and set options (max-tokens, max-steps, shell-timeout, token-window)',
  },
  {
    name: '/agent-options',
    description: 'Configure agent behavior (toggles, thresholds)',
    detail: 'Configure agent behavior (toggles, thresholds, saved assets)',
  },
  {
    name: '/tool-permissions',
    description: 'View/remove profile tool grants; skip-permissions toggle',
  },
  { name: '/profiles', description: 'Switch / create settings profiles' },
  { name: '/manage-profiles', description: 'Rename or delete saved profiles' },
  { name: '/update', description: 'Check for and install updates' },
  { name: '/exit', description: 'Quit Bernard (alias /quit)' },
];

/**
 * Returns the subset of commands whose name prefix-matches the buffer. `extra`
 * carries dynamic, session-specific commands — the user's saved routines and
 * tasks — so typing `/my-routine` autocompletes the same way a built-in does.
 */
export function matchSlashCommands(
  buffer: string,
  extra: readonly SlashCommand[] = [],
): SlashCommand[] {
  if (!buffer.startsWith('/')) return [];
  // Hide hints once the user has started typing args (a space terminates the
  // command token); they're past the picker at that point.
  if (buffer.includes(' ')) return [];
  const query = buffer.slice(1).toLowerCase();
  return [...SLASH_COMMANDS, ...extra].filter((c) =>
    c.name.slice(1).toLowerCase().startsWith(query),
  );
}
