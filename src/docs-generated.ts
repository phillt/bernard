import { APPLET_COLOR_TOKENS, APPLET_STYLED_SELECTORS, TOKENS_PATH } from './host/tokens.js';
import { INTENT_FIELDS, INTENT_FIELD_LABELS } from './apps/brief.js';
import { SLASH_COMMANDS } from './ui/slash-commands.js';
import type { DocEntry } from './docs-store.js';

/**
 * The documents that are DERIVED, not authored.
 *
 * Three of the corpus restate records that already exist — the colour tokens
 * and styled selectors, the brief's intent fields, the slash-command
 * catalogue. Writing those into a `.md` file would make the file a second copy
 * of the artefact, which is exactly the drift `#424` built the served
 * stylesheet to end and `applet-styler`'s token pin needs a test to police.
 *
 * Generated at runtime rather than by a build script for the same reason
 * `tokensStylesheet()` is: a checked-in generated file plus a test that
 * regenerates and compares is a copy with an alarm on it, where a function is
 * no copy at all. The plan's `scripts/build-docs.mjs` is therefore not built —
 * all three sources are pure leaves costing 1-2 ms to import, so there is
 * nothing to amortise. `docs-store.ts` stays free of them: the merge happens
 * one level up, so the parser and the wrapper keep no dependency on any
 * record they might one day describe.
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
  const fields = INTENT_FIELDS.map(
    (f) => `| \`${f}\` | ${INTENT_FIELD_LABELS[f]} |`,
  ).join('\n');

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

/** The derived documents, built fresh — they are cached one level up. */
export function generatedDocs(): DocEntry[] {
  return [stylingDoc(), briefDoc(), commandsDoc()];
}
