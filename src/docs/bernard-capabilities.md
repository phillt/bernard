---
title: What Bernard can do
description: A map of everything Bernard does, each pointing at the document that covers it, plus the three distinctions people get wrong. Read first when the user asks what Bernard can do or whether it can do something.
---

# What Bernard can do

Answer from this document rather than from the tool list. The tool list is what
_you_ can reach on this turn; it is not what Bernard is.

This is a map. Each entry says what the thing is and names the document that
covers it — read that one before answering anything specific.

## The map

**Being installed.** Getting set up, what the first run asks, where files are
kept, and how updates arrive: `bernard-getting-started`.

**Remembering.** Bernard keeps short notes you asked it to keep, picks up facts
from conversations on its own, and can be given whole documents to search.
Three different mechanisms, three different lifetimes — `bernard-memory` for
the first two, `bernard-knowledge` for documents.

**Doing things on your machine.** Reading and writing files, running shell
commands, searching and reading the web. What it may do without asking is a
setting, not a fixed answer: `bernard-permissions`.

**Working unattended.** Jobs on a schedule (`bernard-cron`) and watchers that
react to a change (`bernard-watchers`). Both run with nobody there, which is
why both are scoped by where they may write.

**Handing work to something else.** Sub-agents and tasks for one piece of a
job (`bernard-delegation`), and specialists — saved agents with their own
instructions and their own narrow tool set — for work that keeps coming back
(`bernard-specialists`).

**Building small apps.** An applet is a local web app whose buttons run Bernard
actions; someone who cannot write software can describe what they want and get
something they can open. `applet-host` for having them; `applet-page`,
`applet-actions`, `applet-styling`, `applet-ui-runtime` and `applet-brief` for
building them.

**Connecting to other services.** Mail, calendars, chat, a browser — anything
with an MCP server. `bernard-mcp`.

**Models and cost.** Bernard runs against Anthropic, OpenAI or xAI, or any
endpoint speaking one of those APIs, and spreads one turn's work across models
of different cost. `bernard-models`, and `bernard-usage` for what it came to.

**Settings and profiles.** Everything configurable, grouped, with the variable
behind each one: `bernard-settings`. A profile is a named set of all of it.

**The session itself.** Turns, interrupting, queueing work, images, themes and
spoken replies: `bernard-sessions`. Commands live in `bernard-commands` (typed
at the prompt) and `bernard-cli` (typed at a shell).

## Three distinctions people get wrong

These live in no single document because each one spans several, and picking
the wrong side is the usual mistake.

**A schedule, a change, or a moment.** Cron is a clock: every morning, every
Monday. A watcher is a change: when John replies, when that page updates.
Waiting inside a turn is seconds, not hours. "Check every five minutes whether
the build finished" is a watcher written as a schedule — ask what they are
waiting for.

**A note, a picked-up fact, or a library.** A note is something the user asked
Bernard to keep, and it is sent on every call, so it should be a thing that
stays true. A picked-up fact was extracted from a conversation and surfaces
only when relevant; it expires. A library is documents the user owns, searched
on demand and quoted exactly, never sent unasked. "Remember I prefer dark
themes" is a note. "Here are our six runbooks" is a library.

**A specialist, a sub-agent, or a task.** A specialist is saved and reused, has
a name, and exists tomorrow. A sub-agent is spun up for one piece of the
current job and is gone afterwards. A task is a deliberate one-off run with no
conversation history, for when what has been discussed would only mislead it.
If the user wants it to exist tomorrow, it is a specialist.

## Being honest about the edges

If someone asks whether Bernard can do something not described here, say you do
not know rather than guessing. A confident wrong answer about a capability
costs them a real attempt at something impossible.

The index is a reasonable test. If nothing in it covers what they are asking
about, Bernard most likely does not do it — say so, rather than assembling a
plausible-sounding answer out of tool names.
