---
title: How Bernard splits work up
description: Sub-agents, tasks and delegated calls: what happens when Bernard hands a piece of a job to something else, and what it costs. Read when the user asks why a turn spawned other agents.
---

# Delegation

Bernard does not do everything in one conversation. When a job is big, or when
a piece of it needs a different tool set, it hands that piece to something
else, gets an answer back, and carries on. That is why a single turn can take a
minute and produce several lines of activity.

## The kinds

- **A sub-agent** is spun up mid-turn for one piece of work and is gone
  afterwards. It has no conversation history of its own — it gets the task, a
  bit of context, and the tools it needs.
- **A task** is the same idea, run deliberately: `/task` runs one with no
  history at all, which is what you want when the conversation so far would
  only mislead it.
- **A specialist** is a saved agent, reused across sessions. See
  `bernard-specialists`.
- **A connected-service helper** handles one MCP server's calls on Bernard's
  behalf. See below.

## Why, rather than doing it in the main conversation

Two reasons, and cost is both of them.

Everything in the main conversation is re-sent on every step of every turn. A
piece of work that involves reading six files and trying four things adds all
of that to the conversation permanently. Done in a sub-agent, only the answer
comes back.

And a sub-agent can be given a **narrower** tool set than the main agent has,
which is both cheaper and safer.

## Checking its own work

A sub-agent can run as three phases instead of one: plan, do, then check
against the plan. The checker uses read-only tools and says whether the work
actually meets what was asked. If it does not, the work is re-planned once and
tried again.

That is the **Sub-agent self-review** setting. It costs extra calls and catches
the confident-sounding wrong answer, which is the failure mode worth paying
for.

## Connected services

When MCP servers are connected, Bernard does not carry every server's tools in
its own head. It carries one door per server and steps through it when it needs
that server, with a helper that has those tools and only those. This keeps a
dozen connected servers from costing something on every message you send. See
`bernard-mcp`.

## Limits

Only a few sub-agents run at once — the **Max concurrent sub-agents** setting,
four by default, or `bernard set-max-concurrent <n>`. It is a rate-limit
guard, not a performance dial: fan out wider and the provider starts refusing
calls.

Delegation is also bounded in depth, so a chain of agents handing work down
cannot run away.

## What you see

The transcript shows each delegated piece and what came back. `--tool-details`
or the Tool details setting shows the full exchange instead of a summary.
`Shift+Tab` → **Dispatch Context** shows exactly what each delegated run was
handed, which is the place to look when one of them answers as though it had
been told something different.

`bernard usage` breaks a session's cost down by where it was spent, so a turn
that fanned out to six sub-agents shows up as six rows rather than one large
number.
