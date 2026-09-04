import {
  APPLET_COLOR_TOKENS,
  APPLET_SCALE_TOKENS,
  APPLET_STYLED_SELECTORS,
  TOKENS_PATH,
} from './host/tokens.js';
import { UI_RUNTIME_GLOBAL, UI_RUNTIME_PATH, UI_RUNTIME_RULE } from './host/ui-runtime.js';
import { INTENT_FIELDS, INTENT_FIELD_LABELS } from './apps/brief.js';
import { SLASH_COMMANDS } from './ui/slash-commands.js';
import type { DocEntry } from './docs-store.js';

/**
 * The documents that are DERIVED, not authored.
 *
 * Four of the corpus restate records that already exist — the colour and scale
 * tokens with the styled selectors, the brief's intent fields, the
 * slash-command catalogue, and the UI runtime's own path, global and rule.
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

So a form is \`<label>\` + \`<input>\` inside \`.field\`, a button row is
\`.actions\`, a result block is \`<pre class="output">\`, and a list of things is
\`<ul class="cards"><li>\`. \`button.secondary\` and \`button.danger\` are the two
button variants. \`.hidden\` hides an element; toggle it with
\`el.classList.toggle('hidden')\` rather than writing display rules.

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

Most applets need no library. One form, one button, one result block — write
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

/** The derived documents, built fresh — they are cached one level up. */
export function generatedDocs(): DocEntry[] {
  return [stylingDoc(), briefDoc(), commandsDoc(), uiRuntimeDoc()];
}
