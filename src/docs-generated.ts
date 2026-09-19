import {
  APPLET_COLOR_TOKENS,
  APPLET_SCALE_TOKENS,
  APPLET_STYLED_SELECTORS,
  TOKENS_PATH,
} from './host/tokens.js';
import { UI_RUNTIME_GLOBAL, UI_RUNTIME_PATH, UI_RUNTIME_RULE } from './host/ui-runtime.js';
import { INTENT_FIELDS, INTENT_FIELD_LABELS } from './apps/brief.js';
import { SLASH_COMMANDS } from './ui/slash-commands.js';
import { CONFIRM_MODES, TOOL_MODES } from './tool-modes.js';
import { COORDINATOR_MODES } from './coordinator-modes.js';
import { ACT_KEY, REMOTE_MESSAGE_MODES } from './remote-messages.js';
import { DEFAULT_ROLE_TIERS, MODEL_ROLES } from './model-roles.js';
import { WIZARD_CATEGORIES_DATA } from './profiles-wizard-data.js';
import type { DocEntry } from './docs-store.js';

/**
 * The documents that are DERIVED, not authored.
 *
 * Seven of the corpus restate records that already exist — the colour and scale
 * tokens with the styled selectors, the brief's intent fields, the
 * slash-command catalogue, the UI runtime's own path, global and rule, the
 * permission and planning mode tables, the model roles with their tier grid,
 * and the settings registry.
 * Writing those into a `.md` file makes the file a second copy of the artefact,
 * which is the drift #424 built the served stylesheet to end and
 * `applet-styler`'s token pin needs a test to police.
 *
 * Generated at runtime rather than by a build script for the same reason
 * `tokensStylesheet()` is: a checked-in generated file plus a test that
 * regenerates and compares is a copy with an alarm on it, where a function is
 * no copy at all. So there is no `scripts/build-docs.mjs` — every source is a
 * pure leaf costing 1-2 ms to import, and there is nothing to amortise.
 * `docs-store.ts` stays free of them: the merge happens one level up, so the
 * parser and the wrapper keep no dependency on any record they describe.
 *
 * Each still carries the front matter contract in code — `title` and a
 * `description` that says what it is AND when to read it — because the same
 * index test applies to every document regardless of where it came from.
 */

const TOKEN_NOTES: Partial<Record<string, string>> = {
  '--accent-fg': 'text on any solid fill — never assume white',
  '--border': 'the 3:1 boundary WCAG 1.4.11 requires; do not lighten it',
  '--accent-dim': 'translucent, for a subtle wash over --bg or --surface',
};

function stylingDoc(): DocEntry {
  const tokens = Object.entries(APPLET_COLOR_TOKENS)
    .map(([name, value]) => {
      const note = TOKEN_NOTES[name];
      return `| \`${name}\` | \`${value}\` | ${note ?? ''} |`;
    })
    .join('\n');
  const selectors = APPLET_STYLED_SELECTORS.map((s) => `\`${s}\``).join(', ');
  const scale = Object.entries(APPLET_SCALE_TOKENS)
    .map(([name, value]) => `| \`${name}\` | \`${value}\` |`)
    .join('\n');

  return {
    id: 'applet-styling',
    title: 'Colours and the styles you get for free',
    description:
      'The colour variables an applet may use and the elements the served stylesheet already styles. Read before writing any CSS for an applet.',
    body: `# Styling an applet

Every applet links one stylesheet, \`${TOKENS_PATH}\`, and it is the ONLY styling
that reaches the page unless the applet ships its own \`.css\` file. Inline
\`<style>\` blocks and \`style="..."\` attributes are discarded by the browser's
content security policy — silently, so the page renders unstyled with no error
anywhere. The page write path refuses both rather than let that happen.

## Write no CSS at all in the common case

These are already styled by the served sheet. Use the plain element, or the
class, and you get the product look with nothing to maintain:

${selectors}

So an input row is \`<label>\` + \`<input>\` inside a \`<div class="field">\` —
never a \`<form>\` element, which can never submit and is refused when the page
is saved. A button row is
\`.actions\`, a result block is \`<pre class="output">\`, and a list of things is
\`<ul class="cards"><li>\`. \`button.secondary\` and \`button.danger\` are the two
button variants. \`.hidden\` hides an element; toggle it with
\`el.classList.toggle('hidden')\` rather than writing display rules.

## The layout the floor already does, and must keep doing

The sheet targets a DESKTOP browser — that is the only place an applet runs —
and three rules carry that. They are the ones an applet's own \`.css\` is most
likely to undo by accident, so they are stated rather than left to be
rediscovered:

- \`main\` / \`.app\` is capped at a desktop width, not a reading column, and
  centred. Do not narrow it and do not remove the cap.
- \`.cards\` is a GRID, not a flex column: it lays out as many columns as fit
  and collapses to one in a narrow window, with no breakpoint. Writing
  \`.cards { display: flex; flex-direction: column }\` in an applet's own CSS
  undoes this for that applet, and \`.cards > li { flex: 1 }\` is inert under
  a grid — it silently does nothing rather than failing. Note a grid also
  equalises row heights, so cards in one row are as tall as the tallest.
- \`.field\` is bounded well below the page width, which is what stops a wider
  page becoming a wider text input. Do not widen it to fill the page.

The floor carries no width \`@media\` rule, by design: one layout that reflows,
not a desktop one and a mobile one. Do not add a width breakpoint in an
applet's CSS either — it is a second breakpoint nobody maintains, and the
classes above already collapse on their own.

## When you do need CSS, use these variables

Never a hex value. A literal colour survives no theme change and is the one
mistake that is expensive to undo once a page ships.

| variable | value | notes |
| --- | --- | --- |
${tokens}

Text on a solid fill is \`var(--accent-fg)\`, on every state colour, not white —
white on \`--accent\` measures 2.80:1 and fails WCAG AA outright.

## Spacing, type and the rest of the scale

| variable | value |
| --- | --- |
${scale}

Use these names rather than raw \`rem\` values, so two applets share a rhythm.
Do not override \`:focus-visible\` — the floor gives every control a focus ring,
and replacing it is how keyboard users lose their place.

## Where custom CSS goes

A separate file, passed alongside the page, and linked from it:

\`\`\`html
<link rel="stylesheet" href="${TOKENS_PATH}" />
<link rel="stylesheet" href="app.css" />
\`\`\`

A \`.css\` file that nothing links is served and never loaded, and an
\`@import\` of an off-origin stylesheet is dropped by the policy. Both fail
silently, so both are refused at the write path.

Setting a property from JavaScript — \`el.style.color = ...\` — does work, and is
the escape hatch for something genuinely dynamic. Setting \`style\` as an
attribute, or assigning \`cssText\`, does not.`,
  };
}

function briefDoc(): DocEntry {
  const fields = INTENT_FIELDS.map((f) => `| \`${f}\` | ${INTENT_FIELD_LABELS[f]} |`).join('\n');

  return {
    id: 'applet-brief',
    title: 'The brief: what an applet is for',
    description:
      'The twelve fields recording who an applet is for and what it must do, and how they survive a rebuild. Read when creating or revising an applet.',
    body: `# The applet brief

Every applet has a brief — the standing record of what it is for. It survives
rebuilds, so a later turn revising the page does not have to re-derive the
intent from the HTML.

Read it with \`applet {"action":"brief","id":"<app-id>"}\`, and write to it on
\`create\` or \`update\` by passing an \`intent\` object.

## The fields

Fill only what you actually learned. An empty field is honest; a guessed one is
not — put guesses in \`assumptions\`, which is what separates them from what you
were told.

| field | what it records |
| --- | --- |
${fields}

## Notes

Alongside the intent, the brief accumulates dated notes — a correction the
person gave, a constraint discovered mid-build. Add one by passing \`note\` on an
update. They are what turn "make the buttons bigger" into something the next
rebuild still honours.

## The one that matters most

\`assumptions\`. An applet built on an unstated guess looks finished and is
wrong, and nobody can tell which part to argue with. Write the guess down and
the person can correct it in one sentence.`,
  };
}

function commandsDoc(): DocEntry {
  const rows = SLASH_COMMANDS.map((c) => `| \`${c.name}\` | ${c.description} |`).join('\n');

  return {
    id: 'bernard-commands',
    title: 'Every slash command in the REPL',
    description:
      "Bernard's complete slash-command catalogue with what each one does. Read when the user asks how to do something in the REPL, or what a command is called.",
    body: `# Slash commands

Typed at the Bernard prompt. This is the complete list — if a command is not
here, it does not exist, so say so rather than inventing a plausible one.

| command | what it does |
| --- | --- |
${rows}

Commands are for the person at the keyboard, not for you: you cannot run one.
When something needs doing that only a command can do, name the exact command
and let them type it.`,
  };
}

/**
 * Moved out of `src/docs/applet-ui-runtime.md` because a hand-written copy had
 * already drifted on the day it was written: it said "or more than about four
 * controls" against {@link UI_RUNTIME_RULE}'s "or HAS more than about four
 * controls", making it a fourth unbound statement of a rule whose own docstring
 * exists because two prompts stated it and nothing bound them.
 *
 * That matters more here than anywhere else, because the base system prompt now
 * tells the agent to trust this document over its own reconstruction. A doc is
 * the worst possible place for an unbound copy.
 */
function uiRuntimeDoc(): DocEntry {
  return {
    id: 'applet-ui-runtime',
    title: 'Building an applet with a UI runtime',
    description:
      'When plain DOM code stops being enough, and how to use the served Preact runtime instead. Read before hand-writing innerHTML or a render loop in an applet.',
    body: `# The UI runtime

Most applets need no library. One input, one button, one result block — write
plain DOM code and stop.

Reach for the runtime when the page has **${UI_RUNTIME_RULE}**. That is the
point where hand-written \`innerHTML\` starts producing subtle bugs: stale rows,
lost focus, event handlers wired twice.

## Loading it

\`\`\`html
<script src="${UI_RUNTIME_PATH}"></script>
\`\`\`

A plain \`<script src>\`, before your own inline script, exactly like the applet
client. It attaches one global, \`${UI_RUNTIME_GLOBAL}\`.

## Using it

\`\`\`html
<div id="root"></div>
<script>
  const { html, render, useState, useEffect } = ${UI_RUNTIME_GLOBAL};

  function App() {
    const [items, setItems] = useState([]);
    const [text, setText] = useState('');

    useEffect(() => {
      // resolves to the value, or null — not an entry wrapper
      bernard.store.get('items').then((saved) => setItems(saved || []));
    }, []);

    async function add() {
      const next = [...items, { id: Date.now(), text }];
      setItems(next);
      setText('');
      await bernard.store.set('items', next);
    }

    return html\`
      <div class="field">
        <label for="t">New item</label>
        <input id="t" value=\${text} onInput=\${(e) => setText(e.target.value)} />
      </div>
      <div class="actions">
        <button onClick=\${add} disabled=\${!text}>Add</button>
      </div>
      <ul class="cards">
        \${items.map((i) => html\`<li key=\${i.id}>\${i.text}</li>\`)}
      </ul>
    \`;
  }

  render(html\`<\${App} />\`, document.getElementById('root'));
</script>
\`\`\`

\`html\` is a tagged template — no build step, no JSX, no compiler. Interpolate
with \`\${}\`. A component is \`<\${Name} />\`, with the closing tag written
\`<//>\` when it wraps children.

## What it gives you

\`html\`, \`render\`, \`h\`, \`Component\`, \`createContext\`, and the hooks:
\`useState\`, \`useEffect\`, \`useRef\`, \`useMemo\`, \`useCallback\`,
\`useReducer\`, \`useContext\`, \`useLayoutEffect\`, \`useImperativeHandle\`,
\`useErrorBoundary\`, \`useDebugValue\`.

There is no \`Fragment\` export. Return an array, or wrap in an element.

That is Preact's API. Anything written for React hooks works, with two
differences worth knowing: the DOM property is \`onInput\`, not \`onChange\`, and
\`class\` works as well as \`className\`.

## Styling stays the same

The runtime changes nothing about CSS. Use the classes the served stylesheet
already handles — \`.field\`, \`.actions\`, \`.cards\`, \`.output\` — and the
components look right with no styles of your own. Never write a \`style\`
attribute in a template; the policy discards it exactly as it discards one in
static markup.

## Why this one

The security policy has no \`unsafe-eval\`, so anything that compiles templates
at runtime cannot run — that rules out Vue's full build and Alpine. This
runtime contains no dynamic evaluation at all, which is asserted against the
bytes actually served.

Do not load a library from a CDN. Nothing off-origin loads without the person
granting that origin first, and a script tag that silently does not run is the
worst failure available.`,
  };
}

/** A label/description record rendered as a two-column table. */
function modeRows(modes: ReadonlyArray<{ label: string; description: string }>): string {
  return modes.map((m) => `| **${m.label}** | ${m.description} |`).join('\n');
}

/**
 * The permission tables, read from the records every settings surface reads.
 *
 * `tool-modes.ts`' own docstring is about exactly this failure: three surfaces
 * spelled the same three answers three different ways and one of them was
 * simply wrong, describing `write` as what `unrestricted` does. A manual is the
 * fourth surface and the one a reader trusts most, so it renders the same rows
 * the menus render rather than a fifth paraphrase of them.
 *
 * Coordinator mode is here because the question is the same one — how much
 * Bernard settles on its own before involving you — and because the alternative
 * is a hand-written copy of those three rows in an authored document, which is
 * the drift this module exists to end. It is labelled as not a permission.
 */
function permissionsDoc(): DocEntry {
  return {
    id: 'bernard-permissions',
    title: 'What Bernard may do on its own',
    description:
      'Tool mode, when Bernard stops to ask, how a grant is remembered, and where an unattended write may land. Read when the user asks how to stop Bernard doing something, or why it asked permission.',
    body: `# What Bernard may do on its own

Bernard runs commands and writes files on the machine it is installed on. Four
settings decide how much of that happens without you, and they are independent
— changing one does not change the others.

## What it may do at all

One question, and it settles the whole permission posture. It is a screen in
\`bernard setup\` and a row in \`/agent-options\`.

| answer | what it means |
| --- | --- |
${modeRows(TOOL_MODES)}

The middle answer is the default. What counts as risky is decided by the tool
AND the arguments, never the tool alone — \`git status\` is a read, even though
it arrives through the same shell tool as \`rm -rf\`.

The last answer is not a stronger version of the middle one. It switches off
the block, the prompt, **and** any deny rule you saved, so a rule written to
keep something out of Bernard's reach stops applying.

## When it stops to ask

Every call is scored before it runs.

- **low** — reads. Reading a file, a web search, a lookup on a connected
  service.
- **medium** — ordinary local writes, and any connected-service tool Bernard
  cannot classify from its name.
- **high** — a shell command that is not a plain read, and anything whose
  effect leaves the machine.

A tool that says nothing about itself counts as **medium**, deliberately: the
strict level stops on it and the default one does not, so an unrecognised tool
is neither silently trusted nor bricked.

\`/agent-options → Confirm mode\` moves the line:

| level | stops on |
| --- | --- |
${modeRows(CONFIRM_MODES)}

## Saying yes once, or for good

Every prompt offers the same choices: **Allow once**, **Allow for session**,
and — where Bernard can name a stable thing to allow — **Always allow … for
this profile**. Cancel refuses.

"For session" is forgotten when you quit. A profile grant is written to the
active profile and survives restarts; \`/tool-permissions\` lists what you have
saved and removes any of it.

Shell is remembered per command rather than wholesale, so allowing \`git\` does
not allow \`rm\`. A command line with a pipe, a redirect or a subshell has no
stable name, so it is never offered as something to remember — it is asked
about every time.

## Writes with nobody watching

A cron job, an applet button and \`bernard script\` all run tools with nobody
there to answer a prompt. They are scoped by **where** they may write, not only
by what: each gets its own workspace directory, may write there, and may not
write anywhere else unless you say so. A refusal names the workspace, because
the caller is generated code — a bare "denied" gets retried against the same
path until the job runs out of steps.

\`bernard cron-grant <id> [paths...]\` shows or adds the extra places one job
may write, and \`--allow\` lets it run a tool it otherwise cannot, scoped as
narrowly as a single command. \`bernard app-grant <appId> [tools...]\` does the
tool half for an applet, with \`--deny\` for the other direction and
\`--clear\` to remove everything.

Both are commands the person types, and neither is a tool Bernard can call. An
agent that can widen its own permissions does not have any.

The shell tool is deliberately **not** path-scoped. Working out what an
arbitrary command line will write is not reliably possible, and a containment
check that is sometimes wrong is worse than none — it grants confidence it has
not earned.

## What another program may ask of a session

\`bernard say\` puts a message in front of a running session. What happens next
is a setting, under \`/agent-options → Messages from other processes\`:

| answer | what it means |
| --- | --- |
${modeRows(REMOTE_MESSAGE_MODES)}

Acting on a message you are looking at is always available and gated by
nothing: pressing \`${ACT_KEY}\` runs it. That is consent to one message, which
is stronger than any of these rows, so the setting only governs what happens
with nobody watching.

## How much it plans first

Not a permission, and the fourth answer to the same question — how much Bernard
settles on its own before it starts. Under \`/agent-options → Coordinator
mode\`.

| answer | what it means |
| --- | --- |
${modeRows(COORDINATOR_MODES)}

Planning makes a job of several steps considerably more reliable, and costs
turns and time on a job that was only ever one step.`,
  };
}

/**
 * The model roles and the tier grid, from {@link MODEL_ROLES}.
 *
 * `model-roles.ts` calls itself the single source of truth for roles and
 * derives the lineup slots, the tier table, the editor menu and the snapshot
 * logging from one list. A manual restating six labels and eighteen tier cells
 * by hand is the one copy that cannot be checked by running Bernard.
 *
 * `lineups.ts`' `DEFAULT_TIERS` — the provider-to-model grid — is deliberately
 * NOT rendered. Those ids churn, catalogue membership settles nothing about
 * whether a model can actually be called (that file says so at length), and a
 * manual naming a retired model is the failure this corpus exists to prevent.
 * `/lineup` shows the live binding and `bernard validate-lineup` probes it.
 */
function modelsDoc(): DocEntry {
  const roles = MODEL_ROLES.map((r) => `| **${r.label}** | ${r.description} | ${r.lookFor} |`).join(
    '\n',
  );
  const modes = ['optimize-tokens', 'balanced', 'optimize-performance'] as const;
  const tiers = MODEL_ROLES.map(
    (r) => `| **${r.label}** | ${modes.map((m) => DEFAULT_ROLE_TIERS[m][r.id]).join(' | ')} |`,
  ).join('\n');

  return {
    id: 'bernard-models',
    title: 'Which model answers, and what it costs',
    description:
      'Providers and keys, custom endpoints, and how one turn spreads its work across models of different cost. Read when the user asks which model is answering, why a turn cost what it did, or how to use another endpoint.',
    body: `# Models

## Which company answers you

Bernard talks to Anthropic, OpenAI and xAI directly, and to anything else that
speaks one of those three APIs — a local Ollama, an OpenRouter account, a
gateway at work.

\`bernard add-key <provider> <key>\` stores a key; \`bernard providers\` lists
what is installed and which of them have one. Keys are shared by every profile,
so adding one is done once.

For anything else:

\`\`\`
bernard add-provider ollama --sdk openai \\
  --base-url http://localhost:11434/v1 --model llama3.2
\`\`\`

\`--sdk\` says which of the three wire formats the endpoint speaks, not who made
the model behind it. A custom provider then behaves like a built-in one
everywhere: \`/provider\` switches to it, \`/model\` picks a model on it.

## One turn is not one model

A turn is not one call. Bernard rewrites the message for the model family it is
about to ask, decides which remembered facts are worth including, hands pieces
of the work to sub-agents, and compresses the conversation when it gets long.
Each of those is its own call, and none of them needs the model that writes the
answer.

So every call site is labelled with the **kind of work** it does, and the
profile decides which model each kind gets.

| role | what runs there | what to look for |
| --- | --- | --- |
${roles}

## The ladder

A **lineup** binds three models for one provider — a strong one, a middling
one and a cheap one. **Model mode** then says how far up that ladder each role
reaches:

| role | optimize-tokens | balanced | optimize-performance |
| --- | --- | --- | --- |
${tiers}

\`balanced\` is the default, and it is worth reading the orchestrator row: that
is every turn you have, and it resolves to the **premium** slot — the most
expensive model the provider sells, on every message, with the bill arriving at
the provider rather than in the terminal.

\`/lineup\` edits the active lineup and \`/lineups\` switches between them.
\`bernard set-model-mode <mode>\`, or \`/agent-options → Model mode\`, moves the
ladder.

## Asking for a kind of model, not a named one

A saved specialist may say which model it wants, in one of two ways, and they
are not interchangeable. A **role** is an intent — "this writes code" — and the
active profile keeps choosing correctly when the lineup changes. A
**provider/model pin** freezes one specific model, and goes stale the moment
the lineup moves; Bernard drops a pin that no longer belongs to the active
lineup rather than calling a model nobody chose. Declaring both is refused.

## Where the model list comes from

Context windows and prices come from a catalogue fetched about once a day and
cached. A model missing from it still runs — Bernard assumes a 128k window and
reports its cost as \`n/a\`. \`/refresh-models\` refetches it.

Being in the catalogue is not the same as being callable, in either direction.
\`bernard validate-lineup\` probes every model in a lineup for real, and is the
only thing that answers "can this actually be called".

## Repeated input is discounted, where the provider allows it

The instructions, the tool definitions and the settled part of a conversation
are identical from one step to the next, so Bernard marks them as reusable and
the provider bills them at a fraction of the price. Anthropic and OpenAI both
do this; a custom endpoint may not, in which case the same text is billed in
full on every step, and Bernard says so once when a session's prefix gets large
enough for it to matter.

\`bernard usage\` breaks a session down by call site and by model, which is the
place to look when a session cost more than expected.`,
  };
}

/**
 * Every setting a person is meant to change, from the registry the wizard uses.
 *
 * FIRST SENTENCES only, and that is a budget rather than a style choice: the
 * full descriptions render at 10,089 characters, which is over the per-document
 * cap, and the first sentences at 4,568, which is not. The whole text is one
 * keystroke away in \`/agent-options\`, and the document says so.
 *
 * `OPTIONS_REGISTRY` is deliberately not imported. It lives in `config.ts`,
 * measured at **+85 ms** of module graph against **+27 ms** for this registry
 * and its three mode tables — above the 65 ms edge `docs-store.ts` already
 * declines to take for one number. Every variable it would contribute is
 * already here as `WizardFieldData.envVar`.
 */
function settingsDoc(): DocEntry {
  const groups = WIZARD_CATEGORIES_DATA.map((c) => {
    const rows = c.fields
      .map((f) => {
        // The first sentence, split on a full stop followed by whitespace.
        // Whitespace is then collapsed and any `|` escaped, because the cell
        // lands in a markdown table and a description is free prose written for
        // a wizard screen — today none of them wraps inside its first sentence
        // or contains a pipe, which is an accident of the current copy rather
        // than a rule anyone is keeping.
        const first = f.description
          .split(/(?<=[.!?])\s/)[0]
          .replace(/\s+/g, ' ')
          .replace(/\|/g, '\\|');
        return `| ${f.label} | ${f.envVar ? `\`${f.envVar}\`` : '—'} | ${first} |`;
      })
      .join('\n');
    return `## ${c.title}\n\n${c.description}\n\n| setting | variable | what it does |\n| --- | --- | --- |\n${rows}`;
  }).join('\n\n');

  return {
    id: 'bernard-settings',
    title: 'Every setting, and the variable behind it',
    description:
      'Every setting a person is meant to change, grouped as the setup wizard groups them, with the variable each one reads. Read when the user asks what they can configure, or what a variable is called.',
    body: `# Settings

This is the complete set of settings **meant for you**. Other \`BERNARD_*\`
variables exist and are internal — tuning knobs, test seams, and escape hatches
that are not part of what Bernard offers.

Three ways to change any of them, and they are the same settings:

- \`bernard setup\` walks them, opening each one on the value in force. A quick
  run asks three questions; \`bernard setup --expert\` asks all of them.
- \`/agent-options\` in a running session, which is also where the full
  explanation of each setting lives — the sentences below are the first line of
  it.
- The environment variable, which is only read when the profile leaves the
  setting unset.

Settings belong to a **profile**, so a profile is a named set of all of this
that you switch between in one step. \`/profiles\` lists and switches; keys and
connected services stay shared across all of them. A value saved into a profile
shadows the matching variable from then on, which is why \`bernard setup\`
saves only what you actually changed.

${groups}`,
  };
}

/** The derived documents, built fresh — they are cached one level up. */
export function generatedDocs(): DocEntry[] {
  return [
    stylingDoc(),
    briefDoc(),
    commandsDoc(),
    uiRuntimeDoc(),
    permissionsDoc(),
    modelsDoc(),
    settingsDoc(),
  ];
}
