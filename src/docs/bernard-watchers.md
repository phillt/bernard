---
title: Reacting to a change instead of being asked
description: Acting when something changes rather than on a clock, what can be watched, and what happens when one fires. Read when the user wants telling when something happens, or asks why a watcher never fired.
---

# Watchers

A watcher is a standing "when this changes, do that". You describe what to
watch for and what to do about it, and Bernard goes and does it when it
happens — a new turn appears in the session with a panel saying which watcher
woke it and why.

Ask for one in plain words: _"watch for a reply from John and draft an
answer"_, _"tell me when that page changes"_.

## What it can watch

- A **connected service**, through a read-only call on an MCP server — a
  mailbox, a chat, an issue tracker.
- A **web page**.
- A **file** on this machine.
- The **clock**, which is what `/sleep 2h check the deploy` is.

Only read-only calls are allowed as the thing being watched, so a watcher can
never change something by looking at it.

## What counts as a change

- **Something new appeared** — a message, an issue, a row. This is what "tell
  me when John replies" needs. It compares against what was there when the
  watcher was made, so it does not fire immediately on a mailbox that already
  has mail, and it does not fire when something is deleted.
- **Anything changed at all** — the page is not what it was.
- **Something matches** — the text now contains what you named.

## How it checks

Bernard looks at intervals, reads the current state, and compares it against
what it saw before. It does not subscribe to a feed, which is why a watcher
that misses eleven checks still fires correctly on the twelfth.

No model runs while it is watching — a check is one read. The model only runs
once something has actually happened, which is what makes a watcher that polls
all day affordable.

## Once, or every time

A watcher can stop after it fires, or stay armed. Staying armed is usually what
you want on a conversation: a one-shot watcher has to be re-made after every
reply, and anything arriving between the fire and the re-make is already there
when the new baseline is taken, so it is never reported.

Armed watchers are bounded anyway — by an expiry and by a maximum number of
fires — so one that is watching something that changes constantly cannot run
forever.

## Managing them

`/watchers` lists what is active and cancels one. A watcher that finished or
was cancelled drops off that list; one that **failed** stays, because the error
it recorded is the only thing that explains it.

## When one never fires

Almost always because it is watching the wrong thing. A watcher pointed at a
list that does not exist in the response polls cleanly forever and looks
perfectly healthy — so Bernard refuses one at creation when it cannot find the
list, and names what it did find instead. If a watcher has been quiet longer
than it should, `/watchers` shows what it last saw.

The honest limit is something that appears and is gone between two checks.
Nothing polling can catch that; the answer is to watch a durable record at the
source instead.

## Only while a session is open

Watchers are saved and survive restarts — one set at nine in the morning for a
reply that lands at four is still there. But the checking happens in a running
session. With no session open, nothing is polled; the watcher is picked up
again when one starts.

## Not cron

A watcher waits for a change. A cron job runs on a clock. "Check every five
minutes whether the build finished" is a watcher written as a schedule — say
what you are waiting for instead. See `bernard-cron`.
