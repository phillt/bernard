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

Four, and no more: `string`, `number`, `boolean`, `enum`. An `enum` requires
`values`. `maxLength` applies only to `string`.

Prefer `number`, `boolean` and `enum` wherever the answer allows it — those
three admit no prose at all, so an action built only from them cannot carry an
injected instruction. Reach for `string` when you genuinely need free text, and
give it a `maxLength`.

Mark an argument `"required": true` when the action cannot run without it.
Unknown arguments are rejected, so the page cannot smuggle a field past the
declaration.

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
simple arguments. If a manifest names an ineligible tool the write is refused
with the reason — read it rather than guessing at a substitute.

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
