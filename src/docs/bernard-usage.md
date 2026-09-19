---
title: What a session cost, and why
description: Reading the token and cost breakdown, what makes a turn expensive, and the levers that change it. Read when the user asks what Bernard is costing them, or why one session cost much more than another.
---

# Cost and usage

## Where to look

`bernard usage` prints the breakdown for the last session — by where the spend
happened and by model — and `bernard usage <sessionId>` for an older one.
Inside a session, `/usage` shows the last turn, and `Shift+Tab` →
**Usage & Cost** shows the running total.

The status bar carries the session total while you work.

## Reading it

Three numbers matter and they are priced differently.

- **Input** — everything sent: the instructions, the tool definitions, the
  conversation so far, and whatever was attached this turn.
- **Cached input** — the part of that which the provider recognised from last
  time and billed at a fraction of the price.
- **Output** — what the model wrote.

Input dominates, which surprises people. A long conversation re-sends itself on
every step of every turn, so the thing that makes a session expensive is
usually its length rather than any single answer.

A cost shown as `n/a` means the model is missing from the price catalogue, not
that it was free. `/refresh-models` refetches it.

## What makes a turn expensive

- **The model.** By default the main answer runs on the most expensive model
  your provider sells. `bernard-models` explains the ladder and how to move it.
- **The conversation's length.** `/compact` compresses the older part; `/clear`
  starts fresh, saving what is worth keeping first.
- **Steps.** A turn that plans, calls six tools and re-reads its own output
  pays for the conversation again at each step.
- **Fan-out.** Six sub-agents are six runs. Each one is cheaper than doing the
  work in the main conversation, but there are six.
- **Connected services.** Kept cheap by giving each server one door rather than
  carrying every server's tools — see `bernard-mcp` — but a very large result
  still costs what it costs.

## Caching, and when you lose it

The instructions, the tool definitions and the settled part of a conversation
are identical from one step to the next, so Bernard marks them reusable and the
provider bills them at a discount. Anthropic and OpenAI both do this.

A custom endpoint may not, and then the same text is billed in full on every
step. Bernard says so once, when a session's re-sent portion gets large enough
to be worth saying — treat that as a prompt to delegate more, or to shorten the
conversation.

## Turning things down

The settings with the biggest effect are Model mode, Max agent steps per turn,
Max concurrent sub-agents and Max response tokens. `bernard-settings` has all
of them; `/agent-options` changes them live.

Turning off the small pre-turn passes — the rewriter, the recall filter — saves
very little and costs accuracy. They run on the cheapest model in your lineup
by design.

## A number for a session, not a bill

These are Bernard's own counts, priced from a catalogue it fetches. They should
track your provider's invoice closely and are not that invoice. Where a session
predates a fix to how something was counted, `bernard usage` says the figure
may be understated rather than quietly presenting it as certain.
