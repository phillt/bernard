/**
 * @module profiles-wizard-data
 *
 * Declarative shape of the settings wizard. The legacy `src/profiles-wizard.ts`
 * paired field metadata with readline-bound pickers; this module strips the
 * readline assumption and leaves a pure data tree so any UI host (the Ink REPL,
 * the standalone setup host, future hosts) can interpret the same categories.
 *
 * Two consumers today: `runProfileWizardInk` (`/profiles` → create) and
 * `src/setup-wizard.ts` (`bernard setup`, `/setup`, first run).
 *
 * ## It covers every settable field, and a test says so
 *
 * It used to cover 22 of `ProfileSettings`' 40 fields (#447). The other 18 were
 * not a considered exclusion — they were simply never added, so `provider`,
 * `model`, the active lineup, every voice setting and five behaviour toggles
 * were reachable from no wizard at all. The drift is silent by construction: a
 * field added to `ProfileSettings` works everywhere else and is merely absent
 * here, which nothing notices.
 *
 * So `src/settings-coverage.test.ts` walks `ProfileSettings`' keys and
 * fails on any that is neither declared here nor in a reasoned exclusion set —
 * the record-to-table direction, per `bundled-manifest.test.ts`. Adding a
 * preference is now a failing test until someone decides whether a user should
 * be asked about it.
 *
 * ## Why `envVar` is here
 *
 * `loadConfig` resolves a setting as `prefs.X ?? env ?? DEFAULT`, so writing a
 * value into the profile permanently shadows the matching variable. A wizard
 * that prepopulates from the effective value and saves everything back would
 * silently kill every `BERNARD_*` the user had set. The setup flow guards that
 * by persisting only what changed, and uses this field to SAY where a value is
 * coming from while the user is looking at it.
 */

import { MAX_CONCURRENT_AGENTS_LIMIT } from './tools/agent-pool.js';
import { RESPONSE_STYLE_IDS, type ResponseStyle } from './agent-prompt.js';
import { REMOTE_MESSAGE_MODES } from './remote-messages.js';
import { COORDINATOR_MODES } from './coordinator-modes.js';
import { TOOL_MODES } from './tool-modes.js';
import { THEMES } from './theme.js';
import type { ProfileSettings } from './profiles.js';

/**
 * A list whose options are only knowable at runtime — the installed providers,
 * the model catalog for the provider just chosen, the lineups on disk.
 *
 * Declared as a `source` rather than a thunk so this module stays a pure data
 * tree with no edge to the catalog, the lineup store or `keys.json`. The setup
 * flow resolves it (`src/setup-wizard.ts`); a host that cannot resolve it says
 * so instead of guessing.
 */
export type DynamicOptionSource = 'provider' | 'model' | 'lineup';

/**
 * How much of the settings walk a run asks for (#582).
 *
 * `quick` is the handful of questions in {@link WizardFieldData.tier};
 * `expert` is every declared field, which is what setup asked before this
 * existed. The two are built from the SAME registry by one predicate, so they
 * cannot come to disagree about what a question is — a pair of hand-written
 * lists is how one of them quietly stops containing a setting.
 */
export type SetupTier = 'quick' | 'expert';

/**
 * A named runtime moment at which a setting's effect first becomes observable
 * (#583).
 *
 * A closed set, and it has to be: there is no chokepoint where a setting is
 * READ — `BernardConfig` is a plain resolved object and every consumer does
 * `config.X` inline at 58 sites — and a read-hook would be the wrong signal
 * anyway, since `config.toolDetails` is read on every transcript push. What is
 * worth announcing is that Bernard DID something, which only the code path
 * knows, so each trigger is a line somewhere in a runtime path. No registry can
 * supply that half; this table supplies the other two.
 */
export type HintTrigger =
  | 'voice:first-readback'
  | 'rewriter:first-rewrite'
  | 'recall:first-injection';

/**
 * What to say the first time a setting's effect is observable, and where to go
 * and change it (#583).
 *
 * A setting nobody chose is a setting nobody knows about, and #582's quick path
 * makes that the default state rather than an edge case: a first run now leaves
 * Bernard on a couple of dozen defaults the reader has never seen.
 *
 * The SENTENCE is carried rather than derived. #583 hoped `label` plus a
 * surface would compose one, and it cannot: what a reader needs is what just
 * happened, which is prose about a runtime moment and not a restatement of the
 * setting's name. What IS composed is the signpost — `renderHint` appends the
 * surface — so a hint can never be written without a door out of it.
 */
export interface SettingHint {
  trigger: HintTrigger;
  /**
   * What just happened, in the reader's terms, ending before the signpost.
   *
   * One line: it is rendered as a toast, which is one line wide. Say what
   * Bernard did and why, not what the setting is — the description above
   * already does the second, at length, on a screen the reader asked for.
   */
  message: string;
  /** The command that changes it. `renderHint` appends "to change it." */
  surface: string;
}

export type WizardFieldKind =
  | { kind: 'list'; options: Array<{ value: string; label: string; description?: string }> }
  | { kind: 'dynamic'; source: DynamicOptionSource }
  | { kind: 'text' }
  | { kind: 'boolean' }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'float01' };

export interface WizardFieldData {
  key: keyof ProfileSettings;
  /**
   * What the setting is called. Plain words, never an internal name — this is
   * the heading of a screen someone meets on their first run. "Sub-agent PAC
   * pipeline" was the live label, and PAC is three of our words for our own
   * mechanism; nobody outside this repo can read it.
   */
  label: string;
  /**
   * What the setting is, in three parts. Write every one of these in this
   * order, and in the register you would use explaining it out loud:
   *
   * 1. **What it is** — and gloss any word that is ours rather than English.
   *    `sub-agent`, `specialist`, `applet` and `lineup` all mean something
   *    specific here and nothing to a new reader, so each is explained at the
   *    first question that uses it: "sub-agents — small helpers that go off, do
   *    one thing and report back".
   * 2. **What you get** — the reason to turn it on, in terms of the work rather
   *    than the mechanism. "Catches the confident-sounding mistakes", not
   *    "adds a verification phase".
   * 3. **What it costs, and when that cost is not worth paying** — explicitly,
   *    and only when there is a real cost. The theme picker has none and is not
   *    padded to pretend otherwise.
   *
   * The point of the third part is that it is the only one that answers the
   * question a reader actually brings: not "what is this", but "is this one for
   * me". Naming the mechanism cannot answer it — `Integer 1-20.` was a real
   * description here — and neither can examples, because the examples will
   * always be somebody else's work.
   *
   * For a list, the rows are BARE and this sentence names them all. A gloss in
   * parentheses beside an option translates one of our words into another in
   * the one place there is no room to explain it.
   *
   * `settings-coverage.test.ts` holds the checkable parts of this.
   */
  description: string;
  field: WizardFieldKind;
  /**
   * The environment variable this setting reads when the profile leaves it
   * unset. Absent means the setting is profile-only.
   */
  envVar?: string;
  /**
   * Other `ProfileSettings` keys this one step decides.
   *
   * One entry: Tool mode, whose third option (`unrestricted`) is
   * `skipPermissions`, exactly as `/agent-options` already presents it. Asking
   * about it twice would let a user set a mode and then contradict it on the
   * next screen.
   */
  covers?: Array<keyof ProfileSettings>;
  /**
   * Something the question shows you as the cursor passes a row (#447).
   *
   * Host-agnostic like the rest of this file: it names WHAT to preview, and
   * the renderer decides how. `'theme'` is the only value, and this is a
   * declaration rather than `step.id === 'theme'` at the renderer because a
   * special case keyed on a field name is the thing this registry exists to
   * remove.
   */
  livePreview?: 'theme';
  /**
   * Asked on the QUICK path as well as the full one (#582).
   *
   * A closed set of one, the {@link WizardFieldData.livePreview} idiom: absent
   * means expert-only, so a setting added later lands on the long walk and is
   * still reachable — the safe direction, and the one
   * `settings-coverage.test.ts` can keep checking.
   *
   * The bar is deliberately narrow, and it is two clauses rather than
   * "important". A question earns a place here only when **no default can be
   * right for everyone** AND **it is answerable from the screen, now, by
   * somebody who has not used Bernard yet**. Importance on its own is an
   * argument for a good default, not for a question; and a question nobody can
   * answer yet is a screen they press Enter on.
   *
   * Three qualify, and each fails a different way when it is wrong:
   *
   *  - `toolMode` — the security posture, and the only one of the three whose
   *    default is silent until it bites. It also decides `confirmMode` and
   *    `skipPermissions` through `covers`, so one screen settles the whole
   *    permission question.
   *  - `modelMode` — what every turn costs. Left at `balanced`, `main` resolves
   *    through the lineup's PREMIUM slot, which is the most expensive model the
   *    vendor sells, on every turn, with the bill arriving at the provider
   *    rather than in the terminal.
   *  - `theme` — the cheapest question in the product: the screen IS the answer,
   *    since it repaints as the cursor moves. And no default can serve someone
   *    who needs high-contrast or colorblind-safe colours.
   *
   * **`model` is deliberately NOT here, and it is the one that looks essential.**
   * `SITE_ROLE.main` is `orchestrator`, whose `balanced` tier is `premium`, so
   * on a default install `config.model` decides nothing — it is the fallback for
   * when model mode is OFF. A reader who picked the cheap model on a quick path
   * to save money would still be billed for the premium one, which is worse than
   * not being asked. `activeLineupId` is out for the second clause instead: the
   * fallback (`resolveActiveLineup`) is already correct, and nobody can judge a
   * lineup before using one.
   */
  tier?: 'quick';
  /**
   * Announce this setting once, the first time its effect shows (#583).
   *
   * Absent for most fields, and that is the rule rather than a backlog: a
   * setting with no observable first use has nothing to announce (`theme` is
   * visible immediately, `maxTokens` never announces itself), and a hint for
   * one of those is noise. The bar is that Bernard DID something a reader can
   * point at and would not otherwise be able to explain.
   *
   * **A hint can only hang on a field this registry declares**, which is the
   * one lossy edge of putting it here: the eight settings
   * `settings-coverage.test.ts` excludes have no entry to carry one. In
   * practice that costs nothing — three are permission maps, which are
   * consulted constantly and have no first use — and the one case where it
   * shows is `voiceNormalizer`, whose hint hangs on `voiceTts` instead. See
   * that field.
   */
  hint?: SettingHint;
}

export interface WizardCategoryData {
  id: string;
  title: string;
  description: string;
  fields: WizardFieldData[];
}

export const WIZARD_CATEGORIES_DATA: WizardCategoryData[] = [
  {
    id: 'model',
    title: 'Model',
    description: 'Which model answers you, and which ladder the other call sites use.',
    fields: [
      {
        key: 'provider',
        label: 'Provider',
        description:
          "Which company's models Bernard talks to. Each one has its own API key, its own prices and its own strengths. You're not locked in — Bernard can use different providers for different jobs, and you can add more later — so this is just the one it reaches for when nothing else names a model.",
        field: { kind: 'dynamic', source: 'provider' },
        envVar: 'BERNARD_PROVIDER',
      },
      {
        key: 'model',
        label: 'Default model',
        description:
          'The model Bernard falls back to when nothing else picks one. A bigger model handles hard problems better and costs more per turn; a smaller one is quicker and cheaper and gives up sooner. Most calls are decided by model mode and by your lineup — a named set of models — so this one matters most when those are off.',
        field: { kind: 'dynamic', source: 'model' },
        envVar: 'BERNARD_MODEL',
      },
      {
        key: 'activeLineupId',
        label: 'Active lineup',
        description:
          "A named set of models — a strong one for hard work, a cheaper one for routine jobs, a cheap one for Bernard's own small internal calls. It's how you spend less without picking a model every turn. It does nothing while model mode is off, since everything then uses the default model.",
        field: { kind: 'dynamic', source: 'lineup' },
      },
    ],
  },
  {
    id: 'agent-behavior',
    title: 'Agent behavior',
    description: 'How a turn is planned, which models it spends, and how sub-agents run.',
    fields: [
      {
        key: 'coordinatorMode',
        label: 'Coordinator mode',
        // The rows are bare on purpose. They used to read "Auto (qualifier picks
        // per turn)" and "On (always coordinator)", which translated one piece
        // of jargon into another beside every option — a reader who does not
        // know what a coordinator is learns nothing from being told they always
        // get one. The sentence carries it instead.
        //
        // It has to do more than name the rows, because the question a reader
        // brings is "which of these is right for ME", and no list of examples
        // answers that — they will always be someone else's work. So it states
        // the trade itself: what planning buys, what it costs, and the one
        // condition under which the cost buys nothing. A reader who knows
        // whether their own work has several steps can then settle it, and the
        // two `Always` rows are the two ends of that same sentence.
        description:
          'On a job with several steps, coordinator mode makes the work a lot more reliable: Bernard writes out a plan first and holds itself to it. It costs extra turns and time, and buys you nothing on work that was only ever one step. Auto switches it on when it spots a multi-step job.',
        // The shared table, not a second copy — see `coordinator-modes.ts`.
        field: { kind: 'list', options: [...COORDINATOR_MODES] },
        envVar: 'BERNARD_COORDINATOR_MODE',
      },
      {
        key: 'modelMode',
        label: 'Model mode',
        description:
          'Bernard makes a lot of small internal calls you never see. This picks which model handles them — cheap ones do those jobs just as well, so moving them down cuts the bill with nothing visible lost. Balanced keeps the strong model for your own turns; optimize for token usage moves those down too; optimize for performance uses the strong one everywhere; off ignores the lineup.',
        field: {
          kind: 'list',
          options: [
            { value: 'off', label: 'Off' },
            { value: 'balanced', label: 'Balanced' },
            { value: 'optimize-tokens', label: 'Optimize for token usage' },
            { value: 'optimize-performance', label: 'Optimize for performance' },
          ],
        },
        envVar: 'BERNARD_MODEL_MODE',
        // Quick: what every turn costs. `balanced` sends `main` to the lineup's
        // premium slot, and nothing in the terminal says what that is spending.
        tier: 'quick',
      },
      {
        key: 'subagentPac',
        label: 'Sub-agent self-review',
        description:
          "When a job is big, Bernard hands pieces of it to sub-agents — small helpers that go off, do one thing and report back. With this on, each one plans, works, then checks its own answer before handing it over, which catches the confident-sounding mistakes. It costs two extra model calls per helper, so it's only wasted if you rarely delegate.",
        field: { kind: 'boolean' },
        envVar: 'BERNARD_SUBAGENT_PAC',
      },
    ],
  },
  {
    id: 'memory-context',
    title: 'Memory & context',
    description: 'The pre-turn passes, and what Bernard remembers between sessions.',
    fields: [
      {
        key: 'promptRewriter',
        label: 'Prompt rewriter',
        description:
          "Different model families want to be asked differently. This rewrites your message into the shape the one answering reads best, so you get the answer you meant without learning each model's habits. Costs one small extra call a turn, and falls back to your exact words if anything goes wrong.",
        field: { kind: 'boolean' },
        envVar: 'BERNARD_PROMPT_REWRITER',
        // On by default and entirely invisible: the model is asked something
        // other than what was typed, and nothing on screen says so. The
        // transcript keeps showing the original, which is right — and is
        // exactly why the first rewrite is worth one sentence.
        hint: {
          trigger: 'rewriter:first-rewrite',
          message:
            'Bernard reshaped that message for the model answering it — your words are what you see; Shift+Tab → Prompt & Context shows what was sent.',
          surface: '/agent-options',
        },
      },
      {
        key: 'recallFilter',
        label: 'Recall filter',
        description:
          "Bernard pulls in things it picked up from past conversations whenever they look related to what you're asking. This casts a wider net, then has a cheap model drop whatever doesn't bear on the question — fewer tokens spent, and less chance of a stray one dragging the answer off course. It only touches what Bernard picked up by itself, never the notes you asked it to keep. All for one small extra call a turn.",
        field: { kind: 'boolean' },
        envVar: 'BERNARD_RECALL_FILTER',
        // The first time an answer is informed by something the reader never
        // said in this conversation. Without a word about it that reads as the
        // model knowing things it should not.
        hint: {
          trigger: 'recall:first-injection',
          message:
            'That answer also drew on things Bernard picked up in past conversations, chosen for this question.',
          surface: '/agent-options',
        },
      },
      {
        key: 'memoryConsolidation',
        label: 'Memory consolidation',
        description:
          'Every note you keep is sent to the model on every call, so one about something long finished costs you tokens forever — and once the pile outgrows its budget Bernard leaves some out to fit, which may well be one you still need. This flags what looks done at the end of a session, and you approve the list next time you start. The call runs after you have closed the session, so you never wait on it.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_MEMORY_CONSOLIDATION',
      },
      {
        key: 'specialistRecall',
        label: 'Specialist recall',
        description:
          'A specialist is a saved persona Bernard hands certain jobs to. This lets each one keep its own notes from its own runs, so it stops making the same mistake twice. They are private to that specialist and go when it does — separate from yours. Costs one small call per specialist at the end of a session.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_SPECIALIST_RECALL',
      },
      {
        key: 'scratchSubjectThreshold',
        label: 'Scratch subject-change threshold',
        description:
          'Bernard keeps rough working notes while it is on a task and throws them out when you change the subject. This is how close a new message has to be to the last one to count as the same subject. Higher throws them out more readily, which keeps a new task clean; lower carries them further, which keeps a long one coherent.',
        field: { kind: 'float01' },
        envVar: 'BERNARD_SCRATCH_SUBJECT_THRESHOLD',
      },
    ],
  },
  {
    id: 'tool-safety',
    title: 'Tool safety',
    description: 'Read-only blocking and risk-based confirmation prompts.',
    fields: [
      {
        key: 'toolMode',
        label: 'Tool mode',
        // The rows are bare and the description names all three, which is the
        // treatment the coordinator question already got: a gloss in
        // parentheses translates one piece of jargon into another beside every
        // option, where a sentence above has room to say what each one means by
        // the time the reader reaches it.
        // The last sentence is the merge showing through (#447). `confirmMode`
        // used to be the next question, which is what made the middle row's
        // label falsifiable one screen later; folding it in means a reader who
        // wants to be stopped more often has nothing on this page to reach for,
        // and would reasonably conclude it is not possible.
        description:
          "How much Bernard can do on its own before it needs you. Stopping for every change is the safest and interrupts constantly once you're doing real work; stopping only at the dangerous calls — a shell command that deletes, anything reaching off your machine — keeps that out of your way while still catching what matters. Never asking is quickest and puts nothing between a mistake and your files. If you want it to stop before ordinary file edits too, /agent-options has a finer setting.",
        // The shared table, not a fourth copy of it — see `tool-modes.ts` on the
        // three spellings this had already grown, one of them wrong.
        field: { kind: 'list', options: [...TOOL_MODES] },
        envVar: 'BERNARD_TOOL_MODE',
        // Three keys, one question. `confirmMode` has no step of its own since
        // the merge, and `covers` is what keeps it counted by
        // `settings-coverage.test.ts` and read as answered by
        // `storedExplicitly` — a profile storing only the confirm level HAS
        // answered this question.
        covers: ['skipPermissions', 'confirmMode'],
        // Quick: the one security-shaped question, and the only default here
        // that is silent until it bites. `covers` means this screen settles the
        // whole permission posture rather than a third of it.
        tier: 'quick',
      },
      {
        // Beside the two tool gates rather than under Automation: those govern
        // what Bernard is allowed to BUILD unattended, and this governs what may
        // reach it as an instruction — the same question `toolMode` asks, one
        // channel over.
        key: 'remoteMessages',
        label: 'Messages from other processes',
        description:
          "What a message from another program on this machine is allowed to do. Ask me shows it and waits — one keystroke acts on it, so nothing runs while you're not looking. The other two let any local program that can write your state directory start a turn by itself: handy for scripts, and a real grant.",
        // The shared table, not a fourth copy of it. Hand-written here the rows
        // had already disagreed with the menu's on arrival — which is the drift
        // `remote-messages.ts` says it exists to prevent, happening in the one
        // surface that could not import it while it lived under `src/ui/`.
        field: { kind: 'list', options: [...REMOTE_MESSAGE_MODES] },
      },
    ],
  },
  {
    id: 'output-style',
    title: 'Output style',
    description: 'Concise mode, response shape, tool-call verbosity, and color theme.',
    fields: [
      {
        key: 'conciseMode',
        label: 'Concise mode',
        description:
          "Keeps answers as short as the question allows, so you can scan a reply instead of reading it. Off lets Bernard explain its reasoning and show its working, which is worth having while you're still learning what it does — and is a lot more to get through once you aren't.",
        field: { kind: 'boolean' },
        envVar: 'BERNARD_CONCISE_MODE',
      },
      {
        key: 'responseStyle',
        label: 'Response style',
        description:
          'The shape of an answer rather than its length — how much structure, how much detail, what tone. Default adds nothing and lets the model answer however it would; the rest trade some of that for a predictable form, which helps if you read answers the same way every time.',
        field: {
          kind: 'list',
          options: RESPONSE_STYLE_IDS.map((id: ResponseStyle) => ({
            value: id,
            label: id,
          })),
        },
        envVar: 'BERNARD_RESPONSE_STYLE',
      },
      {
        key: 'toolDetails',
        label: 'Tool details',
        description:
          "Shows what each tool was called with and what came back. It's how you check Bernard's work instead of taking it on trust, and it makes the transcript a lot noisier — worth leaving on while you're still deciding whether to trust a tool.",
        field: { kind: 'boolean' },
        envVar: 'BERNARD_TOOL_DETAILS',
      },
      {
        key: 'theme',
        label: 'Theme',
        description:
          'Which colours the terminal uses. Pick high-contrast or colorblind if the defaults are hard to read; nothing but the colours changes.',
        field: {
          kind: 'list',
          options: Object.keys(THEMES).map((name) => ({ value: name, label: name })),
        },
        // The whole wizard repaints as the cursor moves, so the question's own
        // answer is what it looks like. The only field that declares it.
        livePreview: 'theme',
        // Quick, and it is the live preview above that earns it: the screen is
        // the answer, so the question costs one keystroke — and no default can
        // serve a reader who needs high-contrast or colorblind-safe colours.
        tier: 'quick',
      },
    ],
  },
  {
    id: 'voice',
    title: 'Voice',
    description: 'Spoken readback of each reply.',
    fields: [
      {
        key: 'voiceTts',
        label: 'Speak replies',
        description:
          "Reads each answer out loud as well as printing it, which is what makes Bernard usable while you're looking somewhere else. It only speaks the last answer, so anything that has scrolled past won't be read back.",
        field: { kind: 'boolean' },
        envVar: 'BERNARD_VOICE',
        // The setting this hint is ABOUT is `voiceNormalizer`, which defaults
        // on and which the wizard deliberately does not ask about (#447) — so
        // it has no field of its own to carry one. It hangs here because the
        // observable moment is a readback and `/voice` owns every part of it,
        // including the row that turns this off. Lossy in the direction of the
        // home rather than of the sentence, which is carried verbatim.
        //
        // It fires on a real `'normalized'` outcome rather than on the setting,
        // so a reader who would hear no difference is never told about one.
        hint: {
          trigger: 'voice:first-readback',
          message:
            'Natural speech is on — Bernard reads a listener-friendly version of each reply, so what you hear differs a little from what is on screen.',
          surface: '/voice',
        },
      },
    ],
  },
  {
    id: 'automation',
    title: 'Automation',
    description: 'What Bernard is allowed to build or update without being asked each time.',
    fields: [
      {
        key: 'autoCreateSpecialists',
        label: 'Auto-create specialists',
        description:
          "When the same kind of work keeps coming back, Bernard can save a specialist for it — so that job comes out the same way each time instead of being explained again. On, it saves one once it's confident enough; off, it offers and waits for you. The threshold below is what confident enough means.",
        field: { kind: 'boolean' },
        envVar: 'BERNARD_AUTO_CREATE_SPECIALISTS',
      },
      {
        key: 'autoCreateApplets',
        label: 'Auto-create applets',
        description:
          'Whether Bernard offers to build you a small web app — an applet — when it notices the same task coming round again. An applet turns that task into a button instead of a conversation. It only ever offers; building one is still a turn you ask for, so this widens what gets suggested, not what gets made.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_AUTO_CREATE_APPLETS',
      },
      {
        key: 'autoOpenApplets',
        label: 'Open new applets',
        description:
          "Opens a newly built applet in your browser the moment it's ready. Turn it off where there's nothing to open — over SSH, or on a machine with no display.",
        field: { kind: 'boolean' },
        envVar: 'BERNARD_AUTO_OPEN_APPLETS',
      },
      {
        key: 'autoStyleApplets',
        label: 'Style new applets',
        description:
          "Runs a design pass over a new applet before it opens, so it doesn't turn up looking unmade. Costs one call at build time, and only when one is created — if you supply the page yourself it's left exactly as written.",
        field: { kind: 'boolean' },
        envVar: 'BERNARD_AUTO_STYLE_APPLETS',
      },
      {
        key: 'appletPlanning',
        label: 'Plan applets before building',
        description:
          'Works out what an applet should be — its screens, its controls, what it stores — before any of it gets written. Costs three short calls up front, and saves the rebuilds you get from deciding all that while writing the page.',
        field: { kind: 'boolean' },
        envVar: 'BERNARD_APPLET_PLANNING',
      },
      {
        key: 'autoCreateThreshold',
        label: 'Auto-create threshold',
        description:
          "How sure Bernard has to be before doing any of the above by itself. Higher means it asks more often and surprises you less; lower means it acts more freely and will sometimes make something you didn't want.",
        field: { kind: 'float01' },
        envVar: 'BERNARD_AUTO_CREATE_THRESHOLD',
      },
      {
        key: 'autoUpdate',
        label: 'Auto-update',
        description:
          'Installs a new version of Bernard when you close the session, if one turned up while you were working. On keeps you current without thinking about it; off just tells you an update exists and leaves the install to you, which is what you want if you are on a version you have tested.',
        field: { kind: 'boolean' },
      },
    ],
  },
  {
    id: 'limits',
    title: 'Limits & performance',
    description: 'Step budget, parallelism, token limits, and shell timeout.',
    fields: [
      {
        key: 'maxConcurrentAgents',
        label: 'Max concurrent sub-agents',
        description:
          "How many sub-agents may run at once. More gets a fan-out done sooner, and multiplies how fast you hit your provider's rate limit — that's what this bounds, rather than the amount of work itself.",
        field: { kind: 'int', min: 1, max: MAX_CONCURRENT_AGENTS_LIMIT },
        envVar: 'BERNARD_MAX_CONCURRENT_AGENTS',
      },
      {
        key: 'maxSteps',
        label: 'Max agent steps per turn',
        description:
          'How many times Bernard may call the model to finish one turn. Higher lets it see a long job through; lower caps what a single turn can cost you, and a turn that runs out stops mid-job and tells you.',
        field: { kind: 'int', min: 1, max: 200 },
        envVar: 'BERNARD_MAX_STEPS',
      },
      {
        key: 'maxTokens',
        label: 'Max response tokens',
        description:
          'The longest single answer the model may write. Raise it and a long piece of writing finishes in one go; the cost is that a runaway answer runs further before anything stops it.',
        field: { kind: 'int', min: 256, max: 200_000 },
        envVar: 'BERNARD_MAX_TOKENS',
      },
      {
        key: 'shellTimeout',
        label: 'Shell timeout (ms)',
        description:
          "How long a shell command may run before Bernard gives up on it. Long enough for your slowest ordinary command, short enough that one which is never going to finish doesn't hold up the whole turn.",
        field: { kind: 'int', min: 1_000, max: 600_000 },
        envVar: 'BERNARD_SHELL_TIMEOUT',
      },
      {
        key: 'tokenWindow',
        label: 'Context window override',
        description:
          "How much Bernard holds in mind before it compacts the conversation. 0 reads the real limit off the model, which is right unless your provider reports one Bernard can't look up — set it by hand then.",
        field: { kind: 'int', min: 0, max: 2_000_000 },
        envVar: 'BERNARD_TOKEN_WINDOW',
      },
    ],
  },
];

/** Every declared field, in walk order. */
export const WIZARD_FIELDS: WizardFieldData[] = WIZARD_CATEGORIES_DATA.flatMap((c) => c.fields);
