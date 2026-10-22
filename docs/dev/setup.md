<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

## Setup

`bernard setup`, `/setup`, and a first run all walk the same flow (#447). Provider
and key, then every remaining setting, each question opening on the value that is
in force right now.

- **`src/setup-wizard.ts`** is pure — the questions and the decode rules, over an
  injected `SetupContext`, so the whole question set is testable without a
  terminal or a provider key. **`src/setup-flow.ts`** owns the I/O: what is
  installed, what gets persisted, and the closing probe. **`src/ui/SetupHost.tsx`**
  is a minimal Ink mount that provides `requestWizard`; the REPL provides its own.
  One flow, two hosts — the `apps/manage.ts` (returns) vs `app-cli.ts` (prints)
  split applied to a flow. The legacy `src/setup.ts` readline prompt is gone.
- **Only what CHANGED is written, and that is the point.** `loadConfig` resolves
  `prefs.X ?? env ?? DEFAULT`, so writing a value into the profile permanently
  shadows the matching `BERNARD_*` variable. Every step opens on the EFFECTIVE
  value, which for an unset field is the environment's — so saving all of them
  back would freeze whatever each variable happened to hold and leave it dead,
  for settings nobody touched. `settingsPatch` emits a key only when its answer
  differs from the one the step opened with; a step whose value comes from the
  environment says so in its hint. The cost, stated rather than discovered: there
  is no way here to RESET a field to inheriting — `/options` and
  `bernard reset-option` own that, and a row meaning "unset" would need a third
  state these answers cannot carry.
- **Two stages, because `WizardSpec.steps` is a frozen array with no branching.**
  Stage A settles provider and key; stage B is built afterwards, when the model
  list is knowable and `loadConfig()` no longer throws. Stage A persists BEFORE
  stage B is built — a stored key is progress worth keeping, and it is what makes
  the model list and the probe possible at all. Back does not cross the boundary,
  which is honest: changing provider invalidates every model answer after it.
- **`bernard setup` must work with no API key**, which is why it cannot be the
  REPL: `loadConfig()` throws without one. It reads through `getProviderKeyStatus()`
  / `loadPreferences()`, the `voice-test` precedent, and checks `process.stdin.isTTY`
  before mounting — Ink's `useInput` throws out of an already-returned `render()`
  when raw mode is unavailable, surfacing as an unhandled rejection rather than a
  sentence anyone can act on.
- **A step never invents the answer it opens on.** `WizardChoiceStep` seeded its
  cursor-and-tick at row one whenever `initial` matched no row, so a page whose
  in-force value the list did not offer said `✓` against a value nobody held —
  and Continue then WROTE it, because `settingsPatch`'s change test compares the
  answer against `initial` and an invented answer differs from it like any other.
  That is the env-shadowing hazard's twin and strictly worse: not shadowing a
  variable, but replacing a working setting with the first row of a list. It
  seeds `-1` now, ticks nothing, and the reserved reason row says why Continue is
  refusing rather than letting the button swallow the keystroke in silence.
  - **It is reachable through the model step, and the catalog is why.** Catalog
    membership is not dispatchability in either direction — the same fact the
    lineup table above is curated over — so a model in force can be absent from
    its own list. It is offered back as a row (`… — in use, not in the catalog`)
    rather than dropped, since the remedy for "your value is not here" cannot be
    "pick one of these instead". Only when the catalog answered at all: an empty
    list means "could not read it", and the step is dropped entirely, which is
    the same rule a lineup list follows before any lineup exists.
- **Every step must open on something Enter can accept**, and both halves of that
  were found by walking it rather than by reasoning. A CHOICE step with no initial
  puts the cursor on row one and Enter writes that row as though it had been
  chosen — `activeLineupId` is unset on most installs, so the flow resolves it
  through `resolveActiveLineup` instead of leaving it blank. A NUMERIC step with
  no initial is refused by its own range check, so the walk **cannot proceed** —
  `voiceRate` is `undefined` on `BernardConfig` until someone sets one, so an
  unset numeric step is `optional` and its validator tolerates empty. Neither is
  visible from a hand-written context, which is why `setup-flow.test.ts` asserts
  it against the real one.
- **The voice section is one question, and the rest went to `/voice`.** `voiceTts` stays; Natural speech, Voice backend, Speech rate and Audio warmup do not. They generalise the rule above — none can be judged without HEARING the result, which the wizard cannot do and every `/voice` row can — and they were asked of an install where `voiceTts` defaults to false, so four of five questions configured a feature that was not running. The wizard cannot skip them conditionally: `WizardSpec.steps` is a frozen array with no branching, deliberately, because Back must not cross a boundary that invalidates later answers. Nothing is lost — `/voice` has a row for each, and its test row plays a phrase so a bad value is heard rather than discovered later.
- **Auto-update defaults ON, and the install moved to session EXIT to make that safe.** `applyUpdate` is an `execSync` of a global npm install with `stdio: 'inherit'`, and `startupUpdateCheck` is fired before Ink mounts while its promise settles long after — so the old inline apply froze the event loop for the length of that install and wrote npm's output into the alternate screen buffer Ink owns, the exact class of bug `mcp.ts`'s reconnect notice was fixed for. Flipping the default without moving it would have shipped that to every user. The check now records a `pendingUpdate` and `index.ts` drains it after `fullScreen.teardown()`, where output lands on the restored normal screen and nothing is left to interrupt; the message was already "Restart to use the new version", so nothing is lost. `takePendingUpdate` clears as it reads, so a second drain cannot reinstall. The old test asserted `execSync` WAS called mid-session — which is what made the default unsafe to flip — and now asserts it was not.
- **A question you cannot answer from the screen does not belong in the wizard.** `voiceVoice` asked for a free-text voice name — `Daniel`, `en-us+f3` — which needs `say -v ?` or `spd-say -L` from outside Bernard to answer, is not validated, and silently produces no speech when wrong. Every other step offers rows or opens on a real value; this one offered a caret and a description admitting it could not check the answer. It is `/voice`'s, and `/voice` is strictly better at it: that menu's test row plays a phrase and surfaces the backend's rejection through `onError`, so you set the name and immediately hear whether it took. A picker built from the backend's own voice list would earn the question back; nothing short of that would.
  - **Removing it made an existing invariant stronger rather than weaker.** `opens every step on a real value` carried a carve-out naming this one field as legitimately blank, so the rule had to be read before it could be trusted; it is now flat. And `provenanceNote`'s `Not set.` case had been leaning on this field being unset — a fixture that has to stay unset to keep a test meaningful is one waiting to be populated — so it drives a context that OMITS a field instead.
  - **Still asked with speech off**, and worth knowing before the next pass: `voiceTts` defaults to `false`, so Voice backend, Speech rate and Audio warmup are three questions about a feature that is not running. The wizard cannot skip them — `WizardSpec.steps` is a frozen array with no branching, deliberately, because Back must not cross a boundary that invalidates later answers — so the fix is either dropping them to `/voice` as well or giving voice its own stage the way the model list already has one.
- **`profiles-wizard-data.ts` covers every settable field, and a test says so.**
  It covered 22 of `ProfileSettings`' 40 — the other 18 were never a considered
  exclusion, so `provider`, `model`, the lineup, every voice setting and five
  toggles were reachable from no wizard at all. `settings-coverage.test.ts` walks
  the fields DECLARED IN THE SOURCE to the registry — the record-to-table
  direction, per `bundled-manifest.test.ts` — and fails on any that is neither
  declared nor in a reasoned exclusion set (the three structured permission maps,
  which have their own surfaces). It also reconciles the four numeric options
  against `OPTIONS_REGISTRY`, which is a second table describing the same
  settings with its own bounds; merging the three registries is #441's job, and
  the house answer for two tables that must agree is a test (`timeout-offer.test.ts`
  already reconciles a third against the same registry).
- **It opens on a welcome page, and `{kind:'info'}` is how.** A step that asks
  nothing, whose Enter advances. A STEP rather than something the host draws
  first, because back has to work: `^B` from question one should reach it, and a
  host-rendered preamble is gone by then. `isAnswered` is always true for one and
  the review leaves it out — a row reading "Welcome — (not answered)" invites the
  reader to go and fix something that is not broken. The copy is paragraphs, not
  pre-wrapped lines; the card wraps them to whatever width it has.
- **A progress rail down the left, derived from `WizardStep.section`.** Sections,
  not steps: a 36-question walk cannot list every question in a rail a terminal
  can hold, and "which part am I in" is the question a reader has. Derived rather
  than declared, so a spec cannot carry a rail that disagrees with its own steps.
  Marked with a glyph AND a colour (`✓ ▸ ·`), never colour alone. Dropped below
  `RAIL_MIN_COLUMNS` — a rail that squeezes the question into 30 columns costs
  more than the orientation it buys.
  - **`WizardSpec.railContext` spans the seam.** Setup is two wizards because the
    model list cannot be built before a provider is chosen, but it is one journey
    to the person walking it — and a rail derived from `steps` alone restarts at
    the boundary, telling the reader they are at the beginning immediately after
    finishing a third of the work. `before` renders done, `after` todo. The
    review row belongs to the LAST stage only; two of them read as a mistake, and
    on an intermediate review the last section stays current so the rail is never
    left with nothing marked.
  - This **reverses #473's "no progress fraction"** at the user's explicit
    request. That finding is about an ADAPTIVE interview which cannot know its own
    length, where a fraction is a guess in the direction that nearly doubled
    abandonment; here the length is fixed and known, and a rail names sections
    rather than claiming a proportion.
- **The header belongs to the BODY, not to the card.** Spanning the full width
  it sat above the rail as well — over a column the reader is not looking at —
  and read as a title for the modal rather than for the page inside it.
- **Select, then continue — one model on every screen.** Enter on a row marks it
  with `✓`; the Continue control at the foot hands back what is marked. It costs
  a keystroke over "Enter picks and advances", and the keystroke is the price of
  not having two models: a page whose rows are things to DO (the provider hub)
  and a page whose rows are answers otherwise behave differently under the same
  key, and the reader has to learn which is which per screen.
  - The selection is tracked **separately from the cursor**, which is what makes
    it work at all: by the time Continue is pressed the cursor is on a control,
    so a page handing back "the highlighted row" would have nothing to give.
  - Seeded from the answer the step opens on, so accepting a prepopulated page is
    Continue alone rather than a re-pick.
  - **`pickAdvances` is the opt-out**, for pages where picking IS the act: a hub
    row that opens an editor, and `ask_user`, whose whole point is that a
    clarifying question answers in one keystroke (on a multi-select that means
    space toggles and Enter confirms the set, exactly as before). Such a page
    shows **no tick at all** — there is no selection to mark, and one on row one
    would claim an answer nobody had given.
  - The Continue control is **not relabelled from whatever the cursor is
    touching**. It says what IT does; the key line under the card says what Enter
    does where the cursor is (`↵ select`). A button that renames itself to a
    neighbour's action is how a reader presses the wrong thing.
- **Every step kind reaches the controls, and which keys get there depends on
  what else is on the page.** The footer draws Continue and Back on every screen
  and only the choice step could reach them — so on a numeric settings question
  `↓` did nothing, which is the one key a reader tries after typing a value, and
  the key line read `esc cancel` alone on a page showing two buttons. A control
  you can see and cannot reach is worse than no control.
  - A TEXT step takes `↓` from the buffer onto Continue and `↑` back, with `←/→`
    between the two controls exactly as a choice step has. Three details follow
    from the buffer being there: `←/→` are cursor movement while it has focus, so
    they are advertised only once the cursor is ON a control; the caret is hidden
    there, because it means "typing lands here" and would say so while Enter went
    elsewhere; and anything typed on a control hands the buffer back rather than
    being swallowed, which would reproduce the original complaint one key over.
  - An INFO step opens with Continue focused and moves with `←/→` only. There is
    no body above the controls for `↑/↓` to reach, so the hints name the keys
    that work rather than one with nowhere to go.
- **`← Back` and a step's own actions are focusable CONTROLS.** Arrowing past
  the last option moves onto the buttons in the footer rather than into list rows
  that duplicate them: a "Continue" row and a Continue button are two places to
  do one thing, and the reader has to work out whether they differ. The focused
  control takes the marker, the accent AND the `↵`; the list neither grows a row
  for one nor counts it in the position.
  - **Accent means focused, and nothing else.** Painted as the primary colour
    whenever the cursor was merely not on Back, Continue read as highlighted from
    the moment the page opened — so the one thing the accent is for, saying where
    Enter will land, said nothing. The return glyph moves with it: on an option
    row Enter SELECTS, and a `↵` sitting on Continue promises otherwise.
  - **`WizardSpec.backExits` is what makes Back exist at a stage boundary.**
    Four of setup's five screens are single-step specs, so `canGoBack` —
    `index > 0` — was false on almost all of them and the control was simply
    absent. With it, Back on the first step resolves `{cancelled: true, back:
true}` and the caller reopens whatever came before. A FLAG on the cancelled
    variant rather than a third result case: a caller that does not know about it
    still compiles and still stops, and treating an unhandled "go back" as a
    cancel loses a step where treating it as a completion would lose the answers.
  - **So `runSetupFlow` is a stage machine, not a run of awaits.** Setup cannot
    be one wizard (the model list needs a provider first) but it is one journey,
    and a straight sequence has nowhere to put "go back". Each stage names where
    Back goes; `askedDefault` is recorded because the default question is skipped
    when only one provider has a key, and Back from the settings must skip it in
    the same case rather than reopening a question that was never asked.
  - **The review commits through the same control**, not a last list row reading
    "Looks right — go ahead". Every other page moves on with Continue, and a
    review that needed its own gesture was the one screen where the reader had to
    learn a second one. Its key line names the back chord too — it was the one
    surface whose hints omitted it, which is how "there is no back button"
    survives a page that has one.
  - **A greyed row keeps its trailing detail**, muted along with the label. That
    detail is usually the very thing that explains why the row cannot be picked
    (`xai ···· no key`), so branching it away left the reader with a dead row and
    no reason until they highlighted it.
  - **`ctrl+n` does what the step's own forward BUTTON does**, which is not
    always "hand back the selection". A step with its own `actions` draws the
    first of them as that button — the provider hub's reads "Continue to the next
    step" and resolves with that label — and a `pickAdvances` page carries no
    selection at all, so a chord bound to `submitChosen` was advertised in the
    key line and silently inert on the screen a fresh install starts on. It takes
    the same branch `commit` takes for a tail row, so the chord and the button
    cannot come to mean different things, and the hint is gated on the same value
    so it is never offered on a page with no forward button (an `ask_user` menu,
    where picking IS the act). `setup-walk.test.tsx` drives the chord through
    every stage the flow really builds rather than a hand-written spec — the
    shape that broke exists only in the builders.
  - **`ctrl+n` continues from any step kind, and it ACTS.** Symmetric with
    `ctrl+b`, which goes back rather than focusing Back — a pair where one
    commits and the other only points at a button would be two rules wearing one
    shape. It routes through each step's own commit, so a value its validator
    refuses is still refused; a shortcut that bypassed that would open the one
    door nothing else does. A chord rather than `→` because a text step spends
    the arrow keys on its buffer, and a shortcut that works on four step kinds
    and silently does nothing on the fifth is the inconsistency it replaces —
    `←`/`→` do also reach Back and Continue from an option ROW, where the arrows
    have nothing else to mean — a reader who has just learned that `→` goes
    forward reaches for `←` without being told. Both land ON the control rather
    than acting, which is what focusable controls are for; the chords are the
    ones that act. That is the cheap half rather than the rule, and it does not
    exist on a text step, where the arrows belong to the buffer.
  - **Chords are spelled `ctrl+b`, not `^b`.** The caret is terminal shorthand
    that readers of emacs and older CLIs know and nobody else does, and this row
    is read by someone being onboarded. `ctrlKey()` in `hints.tsx` is the one
    spelling, because the wizard and the transcript hint bar had already picked
    `^b` and `^o` independently and would have drifted again on the next one.
  - **Back is reached SIDEWAYS from Continue**, `←` to it and `→` back. They are
    one row on screen, so walking `↓` through them would be the cursor moving
    down where nothing is — `↓` on Continue therefore does nothing at all. `↑`
    from either returns to the END of the list, which is the row the cursor left;
    from Back that is the case worth having, since the row above it is Continue
    and plain list navigation would step onto it. `^b` still works from anywhere
    and is named in the key line, which is why the control itself no longer
    spells the chord. `WizardStepKind.choice.actions` name the extra
    controls, each resolving the step with its own label — which is also what the
    button then says, because the action names what Enter does better than any
    generic word. A page whose Enter already means "choose this and move on"
    declares none: a second control doing the same thing would have to guess which
    option was meant once the cursor had left them.
- **`WizardStepKind.choice.trailing`** is right-aligned detail per row with
  leader dots filling the gap — the table-of-contents shape `output.ts`'s welcome
  box already uses. Separate from the label because the label is the ANSWER
  vocabulary: a decoder that had to strip a decorated suffix back off would be a
  second copy of the formatting, and the decoration changes with the terminal
  width.
- **One tick, one place, one colour.** `✓` goes hard right of the row, past the
  leader dots, in the theme's success green, on every page that draws one. It
  marks a fact ABOUT the row — chosen here, a key already stored on the provider
  hub — where `>` marks where the cursor is. The selection tick used to be
  rendered INSIDE the label (`1. ✓ anthropic`), which broke both halves at once:
  it inherited whatever `MenuRow` painted the highlighted row, so the same glyph
  meant "chosen" in accent on one screen and "key stored" in green on the next,
  and it sat in a different column on each. Plain text is blind to both — a
  `toContain('✓')` assertion passes on either position and either colour — so the
  guard is a bounded colour assertion in `WizardRow.theme.test.tsx`, mutation-
  checked against accent-instead-of-green and against moving it back inside the
  label.
- **`WizardSpec.skipReview`** resolves on the last answer instead of ending at
  the review. The review is a check-your-ANSWERS screen and is unskippable by
  construction precisely so a caller cannot forget it; a navigational page — a
  hub whose rows are things to DO, or a single field opened from one — has no
  batch to check, and a summary reading `Providers — anthropic` is unactionable.
  **A single-question stage counts as one of those**, which the default-provider
  page did not do at first: its review was the page you had just left, restated
  as one row with the blurbs and the greyed rows that made the choice legible
  stripped out. The guard is on the SPEC, not the flow — `runSetupFlow` hands out
  a spec and takes a `WizardResult` back, so the review is entirely a renderer
  concern and every flow test passes with it on or off.
  Resolved from an EFFECT, never in render: it calls back into the host, which
  sets state, and doing that mid-render updates one component while another is
  rendering.
- **Stage A is providers, plural.** Bernard is not a one-provider product —
  lineups mix providers across tiers and a specialist can pin one — and the old
  stage A asked "which provider, and its key", which taught every reader the
  opposite. It is now a key page **per provider**, every one optional, so a
  single walk can add a second and third. One page each is also what keeps the
  spec a flat array: "which do you want to add" followed by pages for the answers
  is branching, which `WizardSpec` deliberately cannot express.
  - **A masked key is `\*\***`, not `····`.** The leader dots that right-align the
cell are `·`, so a `·`-masked key ran straight out of the alignment and the
    row read as one long run of dots with four characters on the end.
  - **`✓` marks the default in force, and nothing else.** It first shipped as a
    per-row `[✓ key set]` badge, which read as "this row is selected" and
    competed with the cursor marker for the same meaning — two markers, two
    different facts, one of them wrong on every row. Key status is carried by the
    greying and the key hint instead.
  - **It is a HUB, not a page per provider.** A page each asked about three
    providers in a row when almost everyone wants one, gave no view of the set,
    and made "which of these am I actually using" a thing you had to remember
    across screens. Here the state IS the screen: every provider with a tick and
    the last four characters of its stored key, Enter opens that key, and a
    the Continue control leaves. A tick alone cannot say WHICH key is
    in place, which is the question after a rotation or with several accounts —
    and the SUFFIX, because provider keys share a scheme-and-project prefix, so
    the front of one identifies nothing. `getStoredKeyHint` exists rather than
    exporting `loadStoredKeys`, which would hand every caller the keys to get at
    four characters; it reads STORED keys only, since one that arrived through
    the environment is not ours to echo back even in part.
  - **The hub is a LOOP in the flow, rebuilt on every pass**, which is what keeps
    the ticks and hints describing what is on disk NOW rather than when the
    wizard opened. Built once, it still says "no key" for a provider whose key you
    typed two screens ago. **Esc on the hub leaves setup; Esc inside a key page
    only leaves that page** — the hub is the screen you are on, and a field
    opened from it dismisses back to where it came from.
  - **A keyless provider is shown, greyed, and refuses Enter**, with the reason on
    a reserved row under the list and `Unavailable` where the action label goes.
    Shown rather than hidden because absence answers no question: a provider
    missing from the list looks unsupported, where a greyed one with "no key"
    beside it says what to do. The cursor still lands on it for the same reason —
    the explanation has to be reachable. Muted **even while highlighted**, or the
    highlight says "pickable" at exactly the moment the reader is looking.
  - **That rule is what forces the default question into its own stage, AFTER the
    keys.** `steps` is frozen, so a page built beside the key pages cannot know
    what was typed into them — and this page must, to grey the right rows. Asked
    first, every row on a fresh install is unpickable and the reader is stuck on a
    question with no valid answer. So: welcome + key pages, then a separate
    one-question wizard, **skipped** when fewer than two providers have keys,
    because a question whose answer is forced is a screen that costs a keystroke.
  - **No keys at all stops the flow** (`status: 'no-key'`) rather than walking 35
    settings questions to arrive at "no API key is stored".
  - **`WizardStep.emptySummary`** is what the review says for a blank answer.
    `(not answered)` is right for a question that wanted one; it is actively
    misleading on an optional page where blank IS the answer — a skipped key page
    read as unanswered next to a provider that works.
- **Every screen is a centred, bounded card (`WizardCard`).** Flush-left and
  full-width, a four-word question wrapped across 100+ columns and a long walk
  read as a terminal that kept reprinting rather than a sequence of pages. The
  border is a **considered reversal** of this component's own "no borders" rule,
  not an oversight: that rule cited the finding that unstructured
  two-dimensional output is the core barrier for CLI screen readers, and the
  barrier it names is two-dimensional LAYOUT — what is inside the frame is still
  one linear column read top to bottom. It is also already the house surface
  (`Prompt` draws one every frame; `TranscriptPanel` around every error and
  notice). The rest of the original rule stands: no animation, no colour-only
  meaning, every step answerable by typing plus Enter. `fill` centres vertically
  too and is **opt-in**, because it is only correct where the wizard owns the
  frame — the standalone host and the REPL in full-screen; legacy inline appends
  below a live transcript that a full-height box would push off the screen.
- **The frame is laid out like a dialog, and `WizardCard` owns all of it.**
  A title bar across the top with a rule under it, the rail and body below,
  the primary action bottom-right with Back immediately to its left, and the
  universally-true keys on a line **under** the card. Inside the frame those
  keys read as being about this question; under it they read as being about the
  wizard — which is also why dismissal is said there and **only** there: a close
  control in the corner plus the same word in the key line is one frame saying
  `esc` twice. `OverlayFooter` is
  correspondingly no longer used here — its blank/position/hints trio is the
  right shape for a free-standing list overlay and the wrong one for a dialog
  with its own button row — so `CARD_CHROME_ROWS` is the single constant every
  budget subtracts, for the reason `OVERLAY_FOOTER_ROWS` exists.
  - The question is a **header across the whole card**, above the rail as well as
    the body. Inside the body column it was one more paragraph competing with
    the hint and the options. Both rules are the box's own border — the header's
    bottom, the body's left — so they span their extent without anyone computing
    it, and the divider grows with the body however tall it gets.
  - **`contentWidth` must charge for the divider**, which is a real border (1)
    plus the body's inset (2). Three columns optimistic, prose pre-wrapped to it
    overflows and Ink wraps it a **second** time — and Ink wraps with
    `trim: false`, so every re-broken line keeps its break space and the welcome
    page comes out with a ragged left edge. Info bodies are pre-wrapped through
    `wrapText` for that reason rather than left to Ink. The guard's fixture is
    uniform short words on purpose: whether a second wrap leaves a visible space
    depends on where the break lands, so ordinary prose passes or fails on its
    own wording.
  - **Back works on the review now.** `goBack` has handled the review phase
    since it was written and is unit-tested, but no renderer ever called it —
    so the one transition a reader most expects from a summary screen was
    unreachable. Found while making Back part of the frame rather than a
    per-step hint.
- **The primary action says what Enter does, in words, from the STATE.** On a
  prepopulated walk most screens are "accept what is already here", and a bare
  `↵ choose` invites the reader to think nothing is selected yet — so it reads
  `Keep this` when Enter commits the value the step opened on and `Choose this`
  when it commits a different one. `WizardStep.nextLabel` overrides it for the
  case the renderer cannot see: an API-key field on a provider that already has
  one, where Enter on a blank buffer is not skipping a question but keeping the
  stored key. The Enter hint is correspondingly dropped from the key legend —
  one statement, in the reader's words rather than as a key.
- **Narrowing the frame exposed a latent review bug.** `WizardReview`'s
  docstring claimed each row is bounded to one terminal row "by
  `summarizeAnswer`" — which caps the ANSWER at 60 characters and never touched
  the QUESTION. At full width the sum happened to fit; inside a 68-column card a
  long label wrapped to two rows and the window overflowed the budget it had
  been given, because the arithmetic counts ITEMS and assumes one row each. The
  composed row is truncated now, and the invariant has its own test.
- **`WizardStep.section`** carries the group label ("Tool safety") as its own
  field rather than as a prefix baked into `question`. The setup flow built
  `Tool safety — Tool mode` first; the renderer would then have to split on a
  delimiter to style the halves differently, and any question legitimately
  containing an em dash would break it.
- **`WizardStep.initial` and `.validate` were added for this** and are generic:
  `initial` is prepopulation, `validate` is what `runAddProviderInk` still wants
  (it discards four steps of typing when step three fails). Validation runs
  BEFORE the empty-answer rule, so a hook can own the empty case and say
  something — reversed, a required numeric field holds silently and reads as a
  broken Enter key. The message row is reserved unconditionally, `OverlayFooter`'s
  rule, so being refused does not reflow the frame under a reader mid-correction.
  Branching and typed answers are still deliberately absent — setup keeps its own
  label↔value mapping rather than pushing its domain into the type every
  `ask_user` batch is built from.
- **The Theme question shows you the theme.** Arrowing down it repaints the whole wizard — border, rail, header, rows, footer — in the highlighted row's colours, and the row you leave selected is what the rest of the walk is drawn in. It is the one question in the flow whose answer the screen can simply BE.
  - **The one-line version is the wrong one, and both ways it fails are worth knowing.** `setTheme(key)` on cursor move looks sufficient, since all 85 `getThemeColors()` call sites read a module-level `activeThemeKey` at render. It repaints the wrong half of the frame: the cursor lives in `useListCursor` inside `WizardChoiceStep`, a CHILD of `WizardCard`, so the rows recolour and the border, rail, header and footer do not. And it writes a process global, so Esc, Back and an abandoned `/setup` each need a restore path, and a missed one leaves the REPL in a theme nobody chose.
  - **`src/ui/ThemeContext.tsx` is the answer, shaped like `DimensionsContext.tsx`.** It sits above the card, so the whole frame agrees; and reverting is _not doing anything_, because the provider unmounts with the overlay. `useThemeColors()` is `useContext(ThemeContext) ?? getThemeColors()`, and **that fallback is what makes adoption piecemeal** — outside a provider it returns the same OBJECT, so the ~70 unconverted sites and `markdown.ts`'s `cachedColors === colors` cache cannot tell the difference. Eleven sites converted: the wizard's own eight, plus `MenuRow`, `hints` and `BoundedLine`, which render inside it and are shared with every other overlay. `mastheadBlock` takes colours as an ARGUMENT — it is a plain function called from JSX, so a hook there would be one outside a render, and after an early return at that.
  - **It reads the row's VALUE, never its label**, through a new index-aligned `WizardChoiceField.values`. The renderer otherwise sees only labels by design, and for this one field label and value are identical (`profiles-wizard-data.ts` maps the theme ids to themselves) — so reading the label works, by coincidence, until someone gives the rows prettier names. The test uses a fixture where they differ, which is the only way that case can fail.
  - **Declared, not special-cased**: `WizardFieldData.livePreview?: 'theme'` → `WizardStep.preview?: 'theme'`, a closed set of one in the `apps/manifest.ts` idiom. Keying the renderer on `step.id === 'theme'` is the special case this registry exists to remove.
  - **On an option row it is that row; off the list it is the row SELECTED.** Stepping onto Continue shows what you are about to keep, not the last thing the cursor passed — which is how this first shipped, leaving the screen claiming a theme the `✓` disagreed with at exactly the moment you decide whether to commit. `↑` from a control lands on the LAST option rather than the one you left, and the preview follows it there, which a fix written only for "leaving the list" would miss. All three are pinned.
  - **A chosen theme then sticks for the rest of the walk**, because once the step has an answer the preview falls back to it — the same rule, one step later.
  - **`getActiveThemeKey()` is asserted unchanged through previewing and through Esc.** That is the safety argument as an assertion rather than a comment. The preview becomes real only through the saved answer, on the path that already existed (`applyProfileToConfig` + `reapplyRuntimeSettings`).
  - **Colour tests need long ticks, which reads exactly like the feature being broken.** A preview takes two renders — the keypress moves the cursor, the effect that reports it then sets state at the root — and Ink throttles writes at 32 ms, so at the suite's usual 10 ms tick the second render has not flushed and the frame still carries the old theme. Cost an hour of debugging a working feature.
  - **Nine themes, and the three added last carry a constraint worth not tidying away.** `blossom` is pink and `ember` is red, so each has an accent in the same family as `error` — the one colour that must never blend into the chrome. Blossom takes a plain red error against its pink accent; ember, whose accent IS red, separates them by lightness instead (deep `#dc2626` accent, bright `#ff6b6b` error, so the alarming one is the one that jumps). `theme.test.ts` asserts `error !== accent` for every theme, which is what makes a later "tidy-up" toward each other fail.
  - **`graphite` took three cuts, and `src/color.ts` is what settled it.** Measured against a `#0d1117` terminal, every theme built on hex puts `text` BRIGHTER than `accent` (text 10.8-16.1, accent 5.4-8.3) — the accent marks a few characters, the text is the page. The first cut had accent and text a shade apart, so the accent did no work; the second had a near-white accent at **17.27** over text at 7.38, more than double any other theme's accent and inverted, which is exactly why it read as `high-contrast` rather than as a dark theme. It now sits below the family on both (accent 6.40, text 7.50, muted 5.41) while keeping the order, and its accent is a HUE rather than a brightness — a muted violet reads as an accent against grey-blue prose without being the brightest thing on screen. `theme.test.ts` pins the ordering, with a floor so a version that measured nothing cannot pass quietly. `error`/`success`/`warning` keep their vivid colours, and `toolCall`/`prefixColors` keep hues rather than becoming four greys: a restrained theme is a choice about chrome, not a reason to stop signalling or to make sub-agent prefixes untellable apart.
  - **`ember`'s accent is the dimmest of the set at 3.92, measured and accepted.** Brightening it into the family band puts it within a shade of its own error, which is the one thing that must not happen on a red theme; 3.92 clears the 3:1 floor for the large and non-text uses an accent has here. Recorded beside the palette so it reads as a trade rather than an oversight.
  - **`fantastic` is named for what it is rather than whose it is** — a cobalt uniform against the Torch's flame, on the white of the logo. Two colours carry it, `accent` blue and `toolCall` orange, which is why its `error` is a rose rather than a red: a failure must not read as more tool output.
  - **The theme-count test was replaced rather than bumped.** `returns all 6 theme keys` is what a new theme breaks while telling you nothing. What replaced it names the invariants: the default and the accessibility pair (which `/theme` splits its menu on by name) must survive, and `THEME_COLORS` and `THEMES` must agree in BOTH directions — a named theme with no palette silently renders as `bernard` through `getThemeColorsFor`'s fallback, and a palette with no name is unreachable by any menu. The palette keys are read out of the source rather than exporting a module-private record for one test, the move `settings-coverage.test.ts` already makes.
  - **Not done: `/theme`.** The same mechanism would work, but `useListCursor` exposes no movement callback and `MenuOverlay` serves every menu in the product, so the hook cannot be added without touching all of them. Ink's `<Static>` transcript can never repaint regardless, so a whole-tree theme context would not buy a live switch anyway.
- **An option row says the answer; the sentence above says what it means.** The
  coordinator rows read `Auto (qualifier picks per turn)` and `On (always
coordinator)`, which translated one piece of jargon into another beside every
  option — a reader who does not know what a coordinator is learns nothing from
  being told they always get one. The rows are bare and the description names all
  three, so each is explained by the time it is read. `/agent-options` asks the
  same question and was given the same words, since two vocabularies for one
  setting is the drift these questions keep being rewritten to remove.
  - **This line used to carve out an exception, and the exception was wrong.**
    It said `Read-only (least privilege)` and `Strict (also medium-risk)` were
    disambiguating an answer that is genuinely ambiguous alone, rather than
    glossing a term. Both went bare too. The test is not whether the gloss is
    informative — it is whether the SENTENCE can carry it, and it always can:
    two words beside a row cannot say what four lines above the list can, and
    `Auto` is no more ambiguous than `On` once the description names all three.
    What the carve-out actually protected was a copy of the answer in a second
    place, which is the drift the label-is-the-answer-vocabulary rule exists to
    refuse — and it had already produced `Write (allow all tools)`, describing
    `write` as what `unrestricted` does.
  - **`src/tool-modes.ts` is the table**, in the `remote-messages.ts` shape and
    at `src/` root for its stated reason. Three surfaces had grown three
    spellings of these three answers — setup, the `/agent-options` menu, and
    that menu's own parent-row description — and the sentinel for the third row
    was `'unrestricted'` in one and `'skip'` in the other. `ProfileSettings.toolMode`
    holds two values; the third answer is `skipPermissions`, and presenting it
    as a row is right (a mode you can set and then contradict on the next screen
    is not a mode), so the sentinel is written down once rather than invented
    per caller.
  - **`src/coordinator-modes.ts` is the same treatment for the planning
    question**, which had the same two hand-written copies plus a third
    paraphrase on the menu's parent row. Its rows are `Auto` / `Always on` /
    `Always off`: the VALUES stay `auto`/`on`/`off` (they are on disk and in
    `BERNARD_COORDINATOR_MODE`), but a bare `On` beside `Auto` invites the
    reading that `Auto` is somehow less on, and the word that distinguishes them
    is `Always`. It belongs in the label rather than being left for the note.
  - **The formula is written on `WizardFieldData.description`**, because that
    is where the next person adding a field looks. Three parts, in order: what
    it is (glossing any word that is OURS rather than English), what you get
    from it in terms of the work rather than the mechanism, and what it costs
    plus when that cost is not worth paying — the last only where there is a
    real cost. Casual register throughout: this is a first-run screen, not a
    reference page.
  - **Tool mode is asked in permission language now, and defaults to `write`.**
    `Read-only` / `Write` / `⚠ Unrestricted` name the MECHANISM: they are the
    values on disk, and a reader has to work out what each one does to them.
    The rows are `Ask before every change` / `Ask only about risky things` /
    `⚠ Never ask`, which is the question actually being asked. Note the
    description correspondingly stops naming the rows — the inverse of the
    coordinator question's rule and for the same reason: `Auto` says nothing
    alone so that one must name all three, while a row that is already a
    sentence would just be quoted back.
    - **Tool mode and confirm mode are one question now.** The middle row was
      not true on its own: `Ask only about risky things` describes
      `toolMode: 'write'` PLUS `confirmMode: 'auto'`, and the confirm question
      was the very next screen, so a reader could accept that label and then
      answer what "risky" means with "never" — with nothing on either screen
      connecting them. The split is an implementation fact ("is it allowed to
      run" against "do I get a prompt"), not a distinction anybody chooses
      between. `TOOL_MODE_SETTINGS` is the decode and `toolModeFor` the
      inverse, both in `tool-modes.ts`, because a decode written at each of the
      two call sites is two decodes — and that had already happened, with the
      `/agent-options` menu writing two keys where the wizard wrote three.
      - **Three rows, not four.** The obvious merge has one row per coherent
        combination. It collapses because of what `risk.ts` classifies: an
        ordinary local write is `medium` and an unclassified MCP tool is
        `medium`, so "block every write until allowed" (`read-only`) and
        "confirm at medium and up" (`write`+`strict`) select the IDENTICAL
        population. What differs is the prompt's wording and the breadth of
        the allowance it offers — the block gate's session allowance is keyed
        on the tool NAME, the confirm gate's on `name:hash(args)`, so
        `read-only`'s is the coarser, which is not an argument for keeping it
        as a row.
      - **But `toolModeFor` does NOT read `write`+`strict` back as that row**,
        and it used to — "they stop the same calls" is a claim about what the
        two postures STOP, which is not what that function decides. It is the
        PRESELECTOR, and both surfaces decode a row through
        `{...TOOL_MODE_SETTINGS[value]}`, which writes all three keys: so a
        `write`+`strict` user opened `/setup` on a row that was not their
        state and, by accepting what was shown, wrote `read-only`+`auto` over
        it — writes lost one way, `strict` the other, from a keystroke that
        changed nothing. That is this wizard's own "a step never invents the
        answer it opens on", which is a rule about what Continue WRITES; and
        it is the `⚠ Never ask` row's own argument applied consistently, since
        `confirmMode` is the value left holding the answer when the safeguards
        come back. Both un-representable pairs answer `null` now and the step
        opens unticked. The invariant is stated over the whole space rather
        than for the pair that broke it: a row is offered as preselected only
        when re-applying it reproduces the state it was read from.
      - **`confirmMode` is NOT inert under `read-only`**, and the sentence that
        said so was false about the mechanism it named. `runBlockGate` and
        `runGate` are independent and `runGate` never reads `toolMode`, so a
        call the block gate PASSES still meets the confirm gate at its own
        threshold. The diverging population is precisely the one
        `shouldBlockInReadOnly` lets through on purpose — a tool with no meta
        (so "legacy/foreign tools without classification don't get bricked
        silently") and a `kind:'read'` tool declaring `risk:'medium'`; both
        measure `medium`, which `strict` confirms and `auto` does not.
        **Latent, not live**: nothing in-tree declares `risk:'medium'`,
        `riskForCall` can only answer `'high'` or `null`, and everything
        in-tree is classified. So the true statement is about the tool TABLE,
        which is weaker and can change without anyone touching `tool-modes.ts`
        — the row is withheld rather than resting on it, and both armed modes
        now behave the same way. The earlier objection that preserving it
        would need "a row that writes some of its keys" was wrong: `null`
        writes nothing, which is the mechanism the `write` half already uses.
        The `skipPermissions` rows still normalise by design, which is the
        `⚠ Never ask` decision and is why that row writes `auto` and must not
        write `off`. The invariant is pinned over the whole 12-state space.
      - **It was very nearly a silent capability removal.** `strict` and `off`
        lose their setup rows, and the registry they left is the ONLY wizard
        surface — `OPTIONS_REGISTRY` is the four numeric settings, and
        `/agent-options` had no confirm-mode row at all. So dropping the
        question would have left `BERNARD_CONFIRM_MODE` and the per-job cron
        field as the only doors to either value. `CONFIRM_MODES` and the new
        `/agent-options` row are what make "it stays reachable" true, and the
        setup description names that door, because a reader who wants to be
        stopped more often would otherwise conclude it is not possible.
      - **`write`+`off` is a state no row represents**, and is deliberately not
        folded into `⚠ Never ask`: `skipPermissions` short-circuits the
        profile's own `deny` rules too, so reading it as that row would turn a
        bare Enter on a ticked row into an escalation. `toolModeFor` returns
        `null`, the step opens with nothing ticked, and the reader chooses —
        this wizard's existing rule that a step never invents the answer it
        opens on.
      - **The last row leaves `confirmMode: 'auto'`, not `'off'`.** `'off'` is
        what that row MEANS and is the one value it must not store, which is a
        defect this shipped with for about ten minutes: the level is inert
        while `skipPermissions` is set, and `/tool-permissions` re-arms the
        safeguards by writing `skipPermissions` ALONE — so `'off'` would hand
        someone who turned the safeguards back on a session that still never
        asks, in exactly the un-representable state above. What an inert field
        should hold is whatever is correct the moment it stops being inert, and
        the property is pinned for every row rather than for the one that
        failed.
      - **`readCurrent`'s provenance loop walks `WIZARD_FIELDS`**, so a key
        that is `covers`ed rather than asked is invisible to it. `confirmMode`
        needed adding there beside `skipPermissions` — which had the same gap
        and had therefore made `covers: ['skipPermissions']` inert since it was
        written, because nothing ever added that key to the explicit set.
    - **Nothing pinned `DEFAULT_TOOL_MODE`** before this — a security-relevant
      default changeable with the whole suite green, which is exactly how it
      got changed during a copy pass. `tool-modes.test.ts` reads it out of the
      source (`settings-coverage.test.ts`'s move, since the constant is private
      and `loadConfig` throws without a key) and pins it to the row the wizard
      marks, so the default and the recommendation cannot drift apart.
    - **Three tests were pinning the LABELS while claiming to test the decode.**
      `setup-wizard.test.ts` wrote `'⚠ Unrestricted'` and `'Read-only'` as
      literals, so a copy edit broke a test about whether one row writes two
      settings keys. They read the label off `TOOL_MODES` now; which words are
      on a row is that module's own test's business.
  - **The part-2 audit found six more, and what they had in common is worth the
    line.** Every one described its own MECHANISM well and never said what the
    mechanism is for: tool mode explained what each of its three rows does
    without saying that read-only means nothing reaches your machine unseen;
    confirm mode named the thresholds but never that a prompt is your chance to
    stop a call; the rewriter said you get "a better first answer", which is a
    tautology; natural speech said what it rewrites but, worse, its closing
    clause ("speech stays intelligible either way") argued AGAINST turning it
    on. `autoCreateSpecialists` and `autoCreateApplets` never said what a
    specialist or an applet gets you at all — only whether Bernard asks first.
    The tell is the same each time: the sentence answers "what does this do"
    twice and "why would I want it" never.
  - **Part 2 of the formula is the one no test can hold, and it is the one that
    goes missing.** Memory consolidation shipped this pass reading "Leave it off
    and that pile only grows" — a consequence of NOT doing it, phrased as a
    vague threat, with no statement of what doing it gets you and no cost at
    all. Both are checkable-looking and neither is checkable: a word floor and a
    second sentence pass happily on a description that says what a thing is
    twice. The remedy is that the missing benefit is usually a measured fact
    nobody put in the copy — here, that memory is re-sent on every DISPATCH (a
    turn with three sub-agents pays four times), so a dead note costs tokens
    forever, and past `MAX_PERSISTENT_MEMORY_CHARS` a live one starts being
    dropped to make room for it. The cost has a mitigation worth naming too:
    the pass runs in the detached exit worker, so it costs a call and no
    latency.
  - **Three stores were all called "notes" or "facts", and the copy could not
    tell them apart.** `recallFilter` said "saved facts" (the RAG store),
    `memoryConsolidation` "notes it has saved" (the memory store),
    `specialistRecall` "notes from its own runs" (a per-specialist RAG store
    plus owned memory notes) and `scratchSubjectThreshold` "working notes"
    (in-memory scratch). Four questions, three stores, one vocabulary. They now
    name their own: what Bernard **picked up from past conversations**, the
    notes **you asked it to keep**, a specialist's **own** notes, and **rough
    working** notes.
  - **"Facts" is banned outright**, by test. It is what we call the RAG store
    (`bernard facts`, `RAGStore`) and the word claims something the contents
    have not earned — they are assertions a cheap model extracted from past
    conversations, with a TTL and a dedup threshold, not truths.
  - **The recall filter filters the RAG side and never the memory side**, and
    the copy now says so, because the inverse is the natural reading. `#371`
    hands it the `MemoryStore` read-only and takes back `memoryPriority`, which
    `renderPersistentMemory` consults ONLY as packing order, and only once
    `packMemory` already reports a drop — so it decides WHICH note is dropped
    when you are over budget and never THAT one is. The sentence is pinned,
    because it reads as padding and is the one thing on the screen that answers
    "will this throw away what I told it to remember".
  - **`sub-agent`, `specialist`, `applet` and `lineup` are ours**, and each is
    glossed at the FIRST question that uses it, so a reader walking the sections
    in order has met it before it is used plainly. The test asserts on the first
    field to mention each term rather than on every field, which means moving a
    section can fail it — correctly, since that is exactly what would put a term
    in front of its own explanation. It caught one on arrival: `provider` and
    `model` both said "lineup" two questions before `activeLineupId` explained
    it.
  - **No label or description may use one of our acronyms.** `Sub-agent PAC
pipeline` was a live LABEL — PAC names three phases of an internal pipeline
    to someone who already knows the pipeline, and nothing at all to the person
    meeting the screen on their first run. It is `Sub-agent self-review`, and
    the banned list is short on purpose: the acronyms this repo uses about
    itself, not a general prose rule.
  - **Every question owes the trade, not only the mechanism**, and the sweep to
    make that true is what turned three one-off rewrites into a rule. The old
    copy named what a setting was and stopped — `Integer 1-20.` was a real
    description, and `Which colors the terminal uses.` was as much as most of
    the rest said — which answers a question nobody is asking. A reader at a
    settings page is asking "is this one for me", and that needs four things:
    what it is for, what it buys, what it costs, and the condition under which
    the cost is not worth paying. `settings-coverage.test.ts` asserts the SHAPE
    rather than the judgement — a word floor that the type-naming descriptions
    would fail, a second sentence (one sentence can only say what a thing is),
    and no parenthetical gloss on any row label anywhere. Word counts land
    between 21 and 62; the long end is a list question that has to name four
    rows, and the short end is the theme picker, which genuinely has no trade.
  - **A description for a mode question owes the TRADE, not examples.** The
    question a reader brings is "which of these is right for me", and a list of
    examples cannot answer it — the examples are always someone else's work. So
    the coordinator question states what planning buys (reliability on a task
    with several steps), what it costs (turns and time), and the condition under
    which the cost buys nothing (work that was only ever one step). A reader who
    knows the shape of their own work can then settle it, and the two `Always`
    rows are the two ends of that same sentence. `coordinator-modes.test.ts`
    asserts the four claims rather than the sentence, because the wording will
    be revised and the obligation will not.
  - **The reserved note row is reserved as exactly ONE row, and had to be
    truncated to keep that true.** The comment above it already claimed the
    height could not depend on the cursor; it could, through the CONTENT — a
    note wider than the card wrapped to two rows, so the card grew as the
    cursor passed and shrank on the way back. Bounding it is the structural
    guard; keeping each note under about fifty characters is what stops the
    guard from firing and cutting a sentence mid-word.
- **The provenance note says where a value came FROM, never what it IS.** It
  read `Currently On, saved in this profile.` above a row already carrying a `✓`
  on `On` — the same fact twice, and on a text step the buffer shows it too. A
  sentence that has to point at what is already on screen is a sign the screen
  was not obvious enough, not a fix for it. What is left is the half a reader
  cannot see: `Saved in this profile.`, `Set by BERNARD_X — changing it here
overrides that.`, or `Recommended.` — the last being useful where `(default)`
  was not, since "default" repeats where the value came from and "recommended"
  answers the question the reader is actually asking. `Not set.` survives as its
  own case, because it is the one thing no row can show: a blank buffer looks the
  same whether the value is empty or absent.
- **Each question says what the setting is FOR, not only what it does.** The
  descriptions were one terse line apiece (`How aggressively to prompt before
running risky tools.`), which tells a reader what the words mean and nothing
  about whether to change it. They are two short sentences now — what it does,
  then why you would want it — in plain words, which is `PLAIN_LANGUAGE_RULE`'s
  register applied to the surface a new user meets first.
  - **That growth exposed a wrapping defect the short lines had hidden.** Ink
    wraps with `trim: false`, keeping the break space at the START of a
    continuation line — and only where the break lands after one, so the left
    edge came out ragged on some lines and straight on others. `StepHeader`
    pre-wraps through `wrapText` now, which is what the info step already did
    for exactly this reason. The guard needs a fixture with a RAIL: the rail
    narrows the content column, and at the full width the same text wraps
    cleanly and the test passes with the pre-wrap deleted.
- **`WizardSpec.masthead` signs the screen** — a small line, `BERNARD_BANNER`'s
  block lettering, and the tagline under it on the right. The block is CENTRED in
  the card and its parts hang on the BLOCK's own edges, not the card's, so the
  small line sits at the lettering's left shoulder and the tagline at its right —
  which is what makes them read as belonging to the name rather than to the box
  below it. Sized to its widest part rather than to the banner, or a tagline
  longer than the lettering would be right-aligned into space the block does not
  own and spill past it. Opt-in, and every part supplied by the caller: `WizardCard` also
  draws every `ask_user` batch the model raises mid-turn, and a product splash
  over a clarifying question would be signing the wrong thing — a hard-coded
  banner in the overlay would make that unavoidable rather than a choice.
  `runSetupFlow` adds it in ONE place rather than each spec builder, because
  setup is five wizards and one journey: a builder that forgot would put an
  unsigned screen mid-sequence with nothing to notice.
  - **Dropped whole below its own width**, the rule the rail follows and for the
    same reason: block lettering cannot reflow, so a banner that does not fit is
    worse present than absent. Measured with `stringWidth`, not `.length` — the
    rows are box-drawing today and a future banner need not be.
- **Quick and full, and the quick set is THREE (#582).** #447 left this open —
  "a starting point, not the answer", to be settled once someone had walked it —
  and the count it deferred was wrong in both directions: the issue says 30 and
  `setup-flow.ts` said 35, where the real stage-B figure is **29** (30 declared
  fields minus `provider`, which stage A settles), deciding 31 settings because
  `toolMode` `covers` two more. `WizardFieldData.tier?: 'quick'` is the marker,
  `inTier` the one predicate, and a mode screen between the welcome and the
  provider hub is where the reader chooses.
  - **The bar is two clauses, not "important".** A question earns the quick path
    only when **no default can be right for everyone** AND **it is answerable
    from the screen by somebody who has not used Bernard yet**. Importance alone
    argues for a good default, not for a question; and a question nobody can
    answer yet is a screen they press Enter on. `toolMode` (the security
    posture, silent until it bites, and `covers` makes it settle all three
    permission keys), `modelMode` (what every turn costs) and `theme` (the
    screen IS the answer, and no default serves high-contrast or colorblind).
  - **`model` is the one that looks essential and is a TRAP.** `SITE_ROLE.main`
    is `orchestrator`, whose `balanced` tier — the default `modelMode` — is
    `premium`, so on a default install `config.model` decides nothing for the
    turn a reader is having. A reader who picked the cheap model on a short walk
    to save money would still be billed for the premium one, which is worse than
    not being asked. That is also the positive argument for `modelMode` being
    quick instead: it is the only one of the three model-family questions whose
    answer changes anything given the other defaults. `activeLineupId` fails the
    second clause — the fallback (`resolveActiveLineup`) is already correct and
    nobody can judge a lineup before using one.
    - **What `config.model` is, exactly**, because the loose version of that
      sentence — "the fallback for when model mode is OFF" — supports a stronger
      claim than the code makes, and the stronger claim is what a later reader
      would act on. `resolveSiteModel` reaches it for `main` on exactly one
      branch: the resolved lineup slot's provider has **no key**, so it falls
      through to the session global with `source: 'fallback'` — **at any mode**.
      That branch cannot fire on a first run, which has one key and a
      provider-named lineup, so "on a default install" is the correct scope; it
      becomes reachable the moment a mixed lineup exists. And `'off'` is a
      LEGACY mode value that `normalizeStoredModelMode` migrates to
      `'optimize-performance'` at the read boundary, so there is no
      mode-is-off branch at the resolver to appeal to at all. Both directions
      strengthen the drop rather than weakening it: `config.model` decides even
      less than the original sentence claimed.
  - **The frozen-array objection does not survive contact.** #582 assumed
    branching was the constraint; `buildSettingsSpec` already builds a fresh
    array per call from a filter over the registry and already drops steps
    (`STAGE_A_KEYS`, and `built === null`). A tier is one more term in that
    filter. What it is NOT is "skip steps in one spec": the two specs are built
    up front and `railContext` still spans the seams.
  - **The rail derives from the FILTERED list, and that is the whole reason the
    mode screen is SECOND.** `settingsSections(tier)` shares `inTier` with the
    question loop, so a quick walk is never told it is about to visit "Memory &
    context". Every stage from the hub onwards paints that rail, so the choice
    has to precede them — asked any later, four screens would promise a walk the
    reader had already shortened. Before the answer there is no tier at all, so
    the welcome and the mode screen name the **superset**: the rail losing its
    expert-only sections immediately afterwards is the clearest confirmation of
    what was just picked.
  - **The counts on the rows are COMPUTED, never written.** Each row's trailing
    detail is `buildSettingsSpec(ctx, tier).spec.steps.length`, so a hand-typed
    "3 questions" cannot go stale — it is the same registry the walk reads.
    Exact for the quick row by construction (none of its three fields is a list
    that can be dropped for having no options) and off by one on the full row
    only where a catalog cannot be read.
  - **The choice is deliberately NOT remembered per profile.** It is not a
    setting about Bernard's behaviour — storing it makes it the 41st
    `ProfileSettings` field and obliges `settings-coverage.test.ts` to demand a
    wizard question about which wizard you get — and, worse, remembering it
    makes the other path unreachable by the route people take: someone who ran
    quick on Monday and wants to change a limit on Friday would be handed the
    quick walk again with nothing on screen saying the long one exists. The
    same argument #447 made for `^o` opening the mode menu when nothing is
    pending. `bernard setup --expert` exists for someone who already knows;
    there is no `--quick`, because that is the row the screen opens on.
  - **"Does the expert path start from the quick answers?" dissolves.** The
    choice is made before any settings question, so there is nothing in hand to
    carry — and a later `--expert` run opens every step on what the quick run
    stored, which is the same thing by way of disk.
  - **`settings-coverage.test.ts` is the named guard and gained two directions.**
    Expert-only is fine; unreachable from **either** path is the regression, and
    those assertions do not read `tier` at all, so quick-⊆-expert is asserted
    separately along with the exact quick set (written out, record-to-table) and
    a value check, since `tier: true` would read as expert-only and silently
    shrink the walk. `setup-flow.test.ts` additionally pins Back out of the hub
    landing on the **mode** screen: the generic Back walk cannot see that, since
    with the hub returning to the welcome instead `mode` is still reached twice.
- **A setting nobody chose announces itself once (#583).** #582's quick path is
  what makes this necessary rather than nice: a first run now settles three
  questions and leaves Bernard on a couple of dozen defaults nobody has seen.
  `WizardFieldData.hint` is the data, `src/setting-hints.ts` the mechanism, and
  the existing `speechNoticeShownRef` toast in `App.tsx` — the one hand-rolled
  instance — is now one of its three consumers.
  - **There is no chokepoint where a setting is READ, and a read-hook would be
    the wrong signal anyway.** `BernardConfig` is a plain resolved object: 58
    `config.X` reads across 14 non-test files, no getter, no proxy. And
    `config.toolDetails` is read on every transcript-item push, so "someone read
    the field" would fire constantly and mean nothing. What is worth announcing
    is that Bernard **did** something, which only the code path knows.
  - **So the acceptance criterion is met for two of its three parts, and cannot
    be met for the third.** The SENTENCE and the LATCH are a registry edit; the
    TRIGGER is intrinsically a line of code in a runtime path, and no registry
    can supply a call site. Adding a hint to a setting that already has a named
    moment is one data edit; adding one to a setting whose moment nobody has
    named is that plus a call. Said plainly rather than claimed as complete.
  - **The sentence is carried, not derived.** #583 hoped `label` plus a surface
    would compose one; what a reader needs is _what just happened_, which is
    prose about a runtime moment and not a restatement of the setting's name.
    What IS composed is the signpost — `renderHint` appends the surface — so a
    hint can never be written without a door out of it, which is the one thing
    it must never be.
  - **Toast, not `pushAssistantNotice`, and that is a decision.** The memory-cap
    and `provider-wiped` notices use the transcript because "your settings are
    not doing what you think" is a CORRECTION and has to outlive a keystroke. A
    first-use hint explains something that just happened, is at its most useful
    while it is on screen, and names a command that stays available — so what a
    missed one costs is only what it would have taught. It also keeps the words
    out from behind the `❮` chevron, which is Bernard's voice for answers.
  - **Once ever, per profile, in `ProfileSettings.shownHints`** — once per
    session is noise by the third session. Written through `saveActiveSettings`
    the way `app-grants.ts` writes its map, so `config.ts` gains nothing, and a
    deleted profile takes the record with it. It is bookkeeping rather than a
    preference, which is why `settings-coverage.test.ts` **excludes** it with
    that reason: the meta-test correctly refuses to let a record of what you have
    been told pass as a setting.
  - **The rate limit is load-bearing, not polish, precisely BECAUSE "once ever"
    means a missed hint never returns.** At most one per turn — the rewriter and
    recall triggers fire milliseconds apart in `runPreTurnPipeline`, so without
    it the first toast is replaced by the second and marked shown unseen. And a
    session cap of **2**, which BINDS against three declared hints: a cap set at
    or above the number of hints is inert, i.e. code that cannot run and a test
    that cannot fail. The refused hint is not spent, which is the guard that
    matters — a cap that destroyed what it declined would be worse than the
    burst.
  - **`beginTurn()` is reset from the pre-turn pipeline, not `runAgentTurn`.**
    Same boundary (the pipeline is the first thing every turn does), and it keeps
    the reset in the file with two of the three triggers it bounds.
  - **The three hints, and why those.** `rewriter:first-rewrite` (the model is
    asked something other than what was typed, and the transcript keeps showing
    the original — correctly, which is exactly why it is worth a sentence),
    `recall:first-injection` (an answer drew on something the reader never said
    in this conversation, which otherwise reads as the model knowing things it
    should not — and only when facts were actually KEPT, since `filtered` with an
    empty set changes nothing), and `voice:first-readback` (the migrated one,
    still latched on a real `'normalized'` outcome rather than on the setting).
  - **A hint can only hang on a field the registry declares, and that costs one
    case.** The eight settings `settings-coverage.test.ts` excludes have no entry
    to carry one — harmless for the three permission maps, which are consulted
    constantly and have no first use, and visible exactly once: `voiceNormalizer`
    is what the voice hint is ABOUT, and it hangs on `voiceTts` because the
    observable moment is a readback and `/voice` owns every part of it. Lossy in
    the direction of the home rather than of the sentence.
  - **The union is reconciled to the registry, in the direction that fails
    silently.** A `HintTrigger` with no declaring field is a `take()` somewhere
    that can never fire and errors nowhere; `settings-coverage.test.ts` reads the
    union out of the source (the `declaredSettingKeys` move) and fails on one.
    The inverse — a sentence whose trigger nothing calls — is not checkable from
    there, since a source scan for `take('x')` would pass on a commented-out
    line, so the App-level case drives two real triggers instead.
  - **Not attempted: #441.** Three registries still describe these settings and
    only `settings-coverage.test.ts` reconciles them; this adds a field to one of
    them rather than a fourth table, which is the direction #441 wants.
