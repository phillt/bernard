---
title: Applet actions and what they may do
description: How to declare the buttons an applet can press — argument types, agent versus direct-tool dispatch, and why an action ends up with no tools. Read when creating an applet or when an action fails at the click.
---

# Actions

An action is the only way an applet reaches Bernard. The page cannot send a
prompt; it names a declared action and passes typed arguments. That is the
security boundary — an action the caller invents simply does not resolve.

Declare them on `applet` `create` or `update`:

```json
{
  "action": "create",
  "id": "recipe-scaler",
  "name": "Recipe Scaler",
  "description": "Rescales a recipe for a different number of servings.",
  "actions": {
    "scale": {
      "description": "Rescale the ingredient list.",
      "args": {
        "recipe": { "type": "string", "description": "The ingredient list", "maxLength": 4000 },
        "servings": { "type": "number", "description": "How many people" }
      }
    }
  }
}
```

Action names are lowercase, `a-z0-9_-`. Argument names are lowercase,
`a-z0-9_`.

## Argument types

Six, and no more: `string`, `number`, `boolean`, `enum`, `list`, `object`. An
`enum` requires `values`, a `list` requires `of`, an `object` requires
`fields`. `maxLength` applies only to `string`, `maxItems` only to `list`.

Prefer `number`, `boolean` and `enum` wherever the answer allows it — those
three admit no prose at all, so an action built only from them cannot carry an
injected instruction. Reach for `string` when you genuinely need free text, and
give it a `maxLength`.

Mark an argument `"required": true` when the action cannot run without it.
Unknown arguments are rejected, so the page cannot smuggle a field past the
declaration.

### Nested arguments

Reach for a `list` when the count is genuinely variable; if the action takes
exactly two numbers, declare two arguments. `object` is legal only INSIDE a
`list`, because at the top level a record is always two arguments instead,
while inside a variable-length list it is the only way to give an element a
shape.

Nesting stops at three levels, which is exactly deep enough for a line edit:

```json
"edits": {
  "type": "list", "required": true, "maxItems": 50,
  "of": {
    "type": "object",
    "fields": {
      "action": { "type": "enum", "required": true,
                  "values": ["replace", "insert", "delete", "append"] },
      "line": { "type": "number" },
      "lines": { "type": "list", "of": { "type": "number" } },
      "content": { "type": "string", "maxLength": 4000 }
    }
  }
}
```

Every level is checked the way a top-level argument is: an undeclared key
inside an element is rejected, not ignored. What reaches the tool is a
reconstruction of what you declared, never the caller's own object.

## Two kinds of dispatch

**An agent**, when the work needs judgement. Give the action `instructions`
and name a specialist to run them:

```json
"summarize": {
  "description": "Summarise the pasted text.",
  "dispatch": {
    "kind": "agent",
    "specialistId": "text-summarizer",
    "instructions": "Summarise the provided text in three sentences."
  },
  "args": { "text": { "type": "string", "required": true } }
}
```

**A tool**, when the work has a known shape. No model runs at all — it is
faster, cheaper, and deterministic:

```json
"lookup": {
  "description": "Search the web.",
  "dispatch": {
    "kind": "tool",
    "tool": "web_search",
    "args": { "query": "$.question" }
  },
  "args": { "question": { "type": "string", "required": true } }
}
```

Each tool parameter names `$.<declaredArg>` or a literal. Arguments are
mapped, never passed through wholesale.

Not every tool is eligible for direct dispatch, and the ones that are take only
arguments the six types above can name — which is most shapes, but not a union,
an open-keyed record, or anything nested deeper than three levels. If a
manifest names an ineligible tool the write is refused with the reason — read
it rather than guessing at a substitute.

## When a button fails, read the log first

```
applet {"action":"logs","id":"<app-id>"}
```

It records, per invocation, what the action was granted against what it
declared, and why it failed. Read it before forming a theory — the two failures
below look identical from the browser and have nothing in common.

**`No tools available…`** — the action ran with no tools. See the intersection
rule below.

**`Expected a JSON {status, result} envelope; the specialist returned an object
with keys: …`** — the agent did the work and the answer was thrown away on
formatting. A specialist either emits that envelope or it does not, and the two
must agree:

- Leave `structuredOutput` unset on the specialist and its raw output is
  returned to the page as-is. This is the default for anything that is not a
  `tool-wrapper`, and it is what you want when the page parses the result
  itself.
- Set `structuredOutput: true` and its system prompt must say so, spelling out
  `{status, result, error?, reasoning?}`.

Declaring one and prompting the other fails every single time, after the whole
dispatch is paid for.

**`timeout`** — raise `timeoutMs` on the action, or narrow what it does.

**Nothing in the log at all** — the click never reached Bernard. That is a page
problem: a hand-rolled request instead of `bernard.invoke`, or an action name
the manifest does not declare.

## Why an action ends up unable to do anything

The commonest failure, and it is invisible from the manifest alone.

An action's tools are the **intersection** of two lists: the app's
`toolAllowlist` and the backing specialist's own `targetTools`. Name a tool in
one and not the other and the action gets neither — it runs with fewer tools
than the manifest promises, sometimes none, and fails as a bad answer rather
than an error.

So when an action misbehaves, read `applet {"action":"logs","id":"<app-id>"}`
first. It records what was granted against what was declared and says when the
two do not meet.

## What you may not set

`toolAllowlist`, `toolMode`, `confirmMode` and external origins are the
person's to decide, at the command line. An applet cannot widen its own
authority, and neither can you on its behalf. Build the applet; if it needs a
tool it does not have, say which command grants it:

```
bernard app allow <app-id> <action> --tools web_search
```

A new applet's actions are read-only and tool-less by default. That is
deliberate — it works, it is safe, and widening it is one command away.

Deleting an applet you may do, with `applet {"action":"delete","id":"…"}`, and
the person is asked first. It is a full sweep: page, brief, data store,
workspace and any specialist bound to it. The port is kept, so re-creating the
same id restores the same origin — and with it whatever the browser stored
there.
