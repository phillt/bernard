---
title: Saved agents for recurring work
description: Saved agents with their own instructions and a narrow set of tools, how one is made, and how Bernard learns from their mistakes. Read when the user asks how to make a job come out the same way each time.
---

# Specialists

A specialist is a saved agent: its own instructions, its own narrow set of
tools, and a name. When the same kind of work keeps coming back, saving one
means it comes out the same way each time instead of being explained again.

They come in two shapes. Some carry a **persona** — how to do a kind of work,
what good looks like. Others **front one tool or command line**, holding worked
examples of how to call it properly on this machine.

## Getting one

Three ways, in increasing order of effort.

- **Let Bernard offer.** At the end of a session it notices when the same kind
  of work keeps recurring and offers to save a specialist for it. Whether it
  offers or just does it is a setting; whether it offers at all is the
  Auto-create specialists setting.
- **`/create-specialist`** walks you through making one.
- **Ask.** "Make me a specialist that reviews SQL migrations" is enough.

`/specialists` lists them, shows one in full, and edits or deletes one.

## Tools

A specialist names the tools it is allowed to use, and gets those and nothing
else — not the whole toolbox narrowed by good manners, but a smaller toolbox.
That is what makes one safe to hand a job to: it can be talked into something
and still cannot act on it.

The failure worth knowing about is the quiet one. If a specialist's tool list
does not include something it needs, the run does not error — it answers badly.
So when a specialist is doing a worse job than expected, the first thing to
check is what it was allowed to use.

## Which model runs it

A specialist can say **what kind of work it does** — orchestration, code,
classification — and the active profile picks the model. It can instead pin one
specific model, which goes stale the moment your lineup changes. Saying the
kind is almost always right. See `bernard-models`.

It can also say how much of a step budget it needs and whether it should plan
before acting, which matters for a specialist doing something genuinely
multi-step.

## Learning from mistakes

When a tool-fronting specialist calls its tool wrongly, that failure is queued.
At the end of the session Bernard works out what the right call would have
been and adds it as a worked example, so the same mistake is less likely next
time.

Only **call-shape** mistakes are learned from. A 404, a rate limit, an expired
key — those are not things a better-written call would have avoided, and
filling a specialist's examples with them would teach it nothing.

## The ones that ship

Bernard ships a few: wrappers for the shell, files and the web, the agent that
does the learning above, and the ones that build specialists and applets. Those
are protected — you cannot delete them or rewrite their instructions, and they
show a lock in the listing. They do still learn examples.

## Specialist, sub-agent, or task

- A **specialist** is saved and reused. It has a name and you can list it.
- A **sub-agent** is spun up for one piece of the current job and is gone
  afterwards. You do not create one; Bernard does, mid-turn. See
  `bernard-delegation`.
- A **task** is a one-off run with no conversation history, used when you want
  a clean answer uncontaminated by what you have been discussing.
  `/create-task` and `/task` are those.

If you want it to exist tomorrow, it is a specialist.
