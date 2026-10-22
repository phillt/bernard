---
title: Working in a session
description: What one turn is, resuming, queueing work while Bernard is busy, interrupting it, and attaching images. Read when the user asks about the prompt itself rather than about a subsystem.
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

`/talk` is a spoken conversation where you decide when you are done. What
you say is typed into the prompt as you go, a piece at each pause, and nothing
is sent until you press Enter — so a pause to think cannot send half a
sentence, and a mis-heard word can be fixed first. Bernard reads its reply
aloud, closing the microphone while it does, then listens again. Esc or
`/talk` again stops it. It records through PipeWire or PulseAudio, so it is
Linux only for now, and it sends what you say to ElevenLabs to be transcribed —
add a key first with `bernard add-key elevenlabs <key>` or the row in `/voice`.
Once the key is in, the `auto` backend speaks answers with ElevenLabs too; pick
a local backend in `/voice` to keep the local voice. A cough, a click or any
other sound with no words in it is ignored rather than typed.

While it works, Bernard also says what it is doing, in a few words — "let me
draft that up for you", "let me see what this says" — so a long task is not
minutes of silence. Its reasoning is never read out. `/talk minimal` turns
that off and reads only the final reply.

The **Speed** row in `/voice` sets how fast it talks: slow, regular (the
voice's own pace), fast or fastest. It applies to every voice, ElevenLabs
included. ElevenLabs tops out a little above regular, so fastest speeds its
audio up further on your machine, with the pitch kept, when ffmpeg is installed.

With an ElevenLabs voice, the **Voice** row in `/voice` lists every voice your
account can use — the stock library and your own clones — with its accent and
style, and speaks a line in the one you pick. A restricted key needs the
"Voices: read" permission for the list; without it you can still type a voice
id. The **Tuning** row adjusts that voice: **Stability** (expressive to steady),
**Similarity**, **Style** and **Speaker boost**. Each starts at the voice's own
setting, and anything you leave alone stays that way.

`/talk hands-free` drops the Enter: Bernard listens, notices when you stop,
answers, and listens again, and a couple of minutes of silence ends it. It is
opted into each time because a long pause can still send a request half-said.
It narrates the same way, and takes `minimal` too: `/talk hands-free minimal`.
The microphone stays open while Bernard thinks, so if you carry on after a
pause, what you add reaches the work in progress the way a typed follow-up
does; it is closed while Bernard speaks, so talking over it does not interrupt
it yet.

## Everything else

`/help` lists every slash command, and `bernard-commands` is the same list with
what each one does.
