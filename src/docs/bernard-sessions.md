---
title: Working in a session
description: What one turn is, resuming, queueing work while Bernard is busy, interrupting it, attaching images, and how much of its working it shows you. Read when the user asks about the prompt itself rather than a subsystem.
---

# Working in a session

## A turn

You type, Bernard answers, and everything in between is one **turn**. A turn is
not one call to a model: within it Bernard may plan, call tools, hand pieces of
the work to sub-agents, and go round again — up to a step budget — before it
writes the answer. The spinner counts steps and tokens while that happens.

Your message is not necessarily the text sent to the model, either. Before the
turn starts Bernard may rewrite it for the model family it is about to ask, and
may attach things it remembers that look relevant. The transcript keeps showing
what **you** typed, which is correct and occasionally surprising —
`Shift+Tab` opens a set of tabs, and the **Prompt & Context** one shows what
was actually assembled for each turn, next to **Sources**, **Usage & Cost**,
**Agent Status** and **Dispatch Context**.

## Ending one and starting another

`/clear` starts a fresh conversation, saving what is worth keeping to memory
first. `/compact` keeps the conversation but compresses the older part of it,
which Bernard also does on its own when the history gets long.

`bernard -r` picks up where the last session left off.

## While Bernard is busy

You can keep typing.

- **`+ <request>`** queues a new request to run when the current turn finishes.
  It is a new job, not a correction to the one in flight. The leading `+` needs
  a space after it, so `+1 to that` is ordinary text.
- **`/queue`** shows what is waiting and lets you drop one.
- **Enter on its own** acts on a message another program delivered, if one is
  on screen.
- **Esc** interrupts. The turn stops, whatever was typed stays in the prompt,
  and the conversation records that you stopped it rather than pretending the
  question was never asked. Esc also silences speech mid-sentence.

Plain text typed mid-turn is refused rather than queued, and says so — press
`↑` to get it back and send it with `+` if that is what you meant.

`/sleep 2h check whether the deploy settled` sets a turn to run later. It is
the same mechanism as a watcher, with a clock instead of an event — see
`bernard-watchers`.

## Attaching an image

`/image <path>` attaches a picture, with an optional prompt after it. Pasting a
path to an image into the prompt works too. Not every model can read one;
Bernard warns when the model the turn will actually run on cannot.

## Reading the transcript

The transcript scrolls with the mouse wheel, `PgUp` / `PgDn`, and `Home` /
`End` when the prompt is empty. A marker above it says where you are and how
much is above, so a long answer that opens mid-thought reads as scrolled
rather than as a worse answer.

Tool calls are summarised to one line each by default. `--tool-details` at
startup, or the **Tool details** setting, shows the full arguments and output
instead — useful when a tool is doing something you did not expect, noisy the
rest of the time.

`/scratch` lists the rough working notes Bernard keeps during a task and throws
away when the subject changes. `/session-log` prints the path to the debug log,
which only exists when the session was started with `BERNARD_DEBUG=1`.

## How it looks and sounds

`/theme` switches colours, and the list previews each one as you arrow through
it — two of them are built for high contrast and for colourblind-safe
distinctions. `/voice` turns spoken replies on and off, picks a backend and a
speaking rate, and has a row that speaks a test phrase, which is the only
reliable way to tell whether a voice name your system does not have is the
reason you are hearing nothing.

Replies are rewritten before they are spoken, so links are named rather than
spelled out and a phone number is read as a phone number. That rewriting is a
setting; turning it off still strips the markdown.

## Everything else

`/help` lists every slash command, and `bernard-commands` is the same list with
what each one does.
