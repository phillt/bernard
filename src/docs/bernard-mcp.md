---
title: Connecting Bernard to other services
description: MCP servers: adding mail, calendars and browsers, what becomes of their tools, and telling a broken one from a slow one. Read when the user wants Bernard to reach another service, or one stops working.
---

# Connected services

Bernard reaches things beyond your own files through **MCP servers** — small
programs that expose a service as a set of tools. Mail, calendars, chat, a
browser, an issue tracker: whatever you have, or can install.

## Adding one

Ask Bernard. It can write the configuration, check the server actually starts,
and list what it exports. That is the recommended route, because the two things
that go wrong — a bad command line and a server that starts but exports
nothing — are both things Bernard can see and you cannot.

`/mcp` lists the configured servers and their tools inside a session.
`bernard mcp-list` does the same from a shell, and `bernard remove-mcp <key>`
removes one.

The configuration is a file in your config directory, shared across every
profile, so a server added once is available everywhere.

## What happens at startup

Every server is connected when a session starts, with a time limit — one that
never finishes is skipped and the session opens without it, rather than hanging
forever. The startup banner says which failed and why.

A server that is slow the first time it runs, because it is downloading itself,
can time out at startup and then work perfectly when probed afterwards. That is
worth knowing before concluding the configuration is wrong.

## One door per server

Bernard does not carry every server's tools in its own head. It carries one
door per server and steps through it when it needs that server, handing the
work to a helper that has those tools and only those.

This is why a dozen connected servers do not make every message you send more
expensive. The visible effect is that the transcript shows a delegated step
rather than a direct call. See `bernard-delegation`.

Tool names are namespaced per server, so two servers can both export a tool
called `search` without either one shadowing the other.

## Permissions

An MCP tool Bernard cannot classify from its name counts as **medium risk** —
enough to be stopped under the strict confirmation level and not under the
default one. A tool whose name reads like a lookup is treated as a read.

That is a guess made from a name, which is worth remembering when deciding how
much to trust the default. See `bernard-permissions`.

Bernard also refuses to repeat an identical call to a tool that **emits**
something — sending a message, creating an event — when the same call already
succeeded this turn, and says the first one worked. Asking again anyway goes
through, which is how you say you meant it.

## When something stops working

Ask Bernard to verify the server. It probes it in isolation and then reconciles
that against the running session, so it can tell you the difference between:

- the server is broken,
- the server is fine but this session never loaded it — restart, and
- the server is fine and loaded, so the problem is the call.

Those three look identical from the outside and have completely different
fixes. A verification that reports a warning about a healthy server is not a
reason to delete its configuration.

## Results are trimmed

A very large result from a connected service is shortened before it enters the
conversation, keeping the identifying parts — who a message is from, what it is
about — rather than the first N characters. An oversized result says it was
shortened.
