---
title: What Bernard remembers about you
description: The notes Bernard keeps because you asked, the facts it picks up on its own, and the working notes it discards. Read when the user asks whether Bernard remembers something, or how to make it forget.
---

# Memory

Three different things get called memory, they behave differently, and telling
them apart is most of what anyone needs to know.

## Notes you asked it to keep

Short written notes — a standing instruction, a preference, the name of
something. Bernard writes one when you say "remember that…", and **every note
is sent to the model on every call**, so these are the things that should hold
true next month rather than the things that merely happened today.

`/memory` lists them. Ask Bernard to change or drop one in plain words; it can
write, retire and replace them.

A retired note is archived rather than deleted — it stops being sent and stays
on disk. That is deliberate: a note that turns out to have been retired by
mistake is one line away from coming back.

Because they are re-sent constantly there is a size budget, and past it Bernard
drops whole notes rather than cutting one in half — a fact that stops
mid-sentence still reads as authoritative. It says which ones it dropped, and
names the variable that raises the budget.

**Housekeeping.** At the end of a session Bernard looks over the pile and
suggests what could go: two notes saying the same thing, or one about a job
that finished in the spring. It only ever suggests. Nothing is retired without
you agreeing, because a standing instruction that quietly stops being sent
fails silently — Bernard simply behaves differently one day, with no error.

## Facts it picked up on its own

Separately, Bernard extracts facts from conversations as they end and keeps
them in a searchable store. When a later conversation touches one, it surfaces.
This is what is happening when Bernard knows something you never said in the
current session.

These are not notes you wrote, and the word "facts" is doing a lot of work —
they are assertions a cheap model pulled out of a transcript. They expire if
nothing ever retrieves them, and re-learning one extends its life.

`bernard facts` browses them and `bernard facts <query>` searches.
`bernard clear-facts` **deletes all of them permanently**, with no undo.
`/rag` toggles the store off for a session and `/facts` shows what was pulled
into the current context.

Not every stored fact is offered to the model. A cheap pass reads what the
conversation is actually about and keeps only what bears on it, which is what
stops a question about your calendar arriving alongside six facts about a
deployment. If that pass fails, Bernard falls back to a plain search.

Specialists keep their own separate store of what they learned from their own
runs — `bernard facts -s <id>`, and `bernard clear-facts -s <id>`.

## Working notes, thrown away

Scratch notes: what Bernard jots down mid-task, and drops when you change the
subject. `/scratch` lists them. Nothing here survives the session, and nothing
here is meant to.

## Making it forget

- One note: ask.
- All the picked-up facts: `bernard clear-facts`.
- The conversation: `/clear`, which saves what is worth keeping first.

There is no single command that erases everything, because the three stores
answer different questions and clearing one rarely means clearing the others.

## Documents are not memory

If you want Bernard to read your files — a manual, a book, a folder of specs —
that is a knowledge library, not memory. Libraries do not expire, do not
deduplicate, and are never sent unasked. See `bernard-knowledge`.
