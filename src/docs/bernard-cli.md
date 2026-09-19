---
title: The bernard command line
description: What you can do from a shell rather than from the prompt, grouped by what it is for, with the handful of commands most people actually type. Read when the user asks how to do something without opening a session.
---

# The command line

`bernard` with no arguments opens the REPL. Everything else is a subcommand,
and they exist for the things that either have to happen before a session
starts, or have to happen with no session at all — setting a key, granting a
permission, running a job by hand, reading a log.

**`bernard --help` is the complete list**, and `bernard <command> --help`
explains one, including every option. That output is rendered from the real
command table, so it cannot go stale. What follows is a map of it, not a
replacement.

## The ones people actually type

| command                            | what it does                                               |
| ---------------------------------- | ---------------------------------------------------------- |
| `bernard`                          | Open a session.                                            |
| `bernard -r`                       | Open a session and pick up the last conversation.          |
| `bernard setup`                    | Walk provider, key and settings, then check a call works.  |
| `bernard add-key <provider> <key>` | Store an API key.                                          |
| `bernard providers`                | Which providers are installed, and which have a key.       |
| `bernard usage`                    | What the last session cost, by call site and model.        |
| `bernard facts`                    | Browse what Bernard has picked up from past conversations. |
| `bernard cron-list`                | Every scheduled job and how it is doing.                   |
| `bernard app list`                 | Your applets.                                              |
| `bernard update`                   | Check for a new version and install it.                    |

## Starting a session differently

Flags on `bernard` itself, not on a subcommand. `-p` and `-m` override the
provider and model for one session; `-r` resumes; `--tool-details` shows the
full arguments and output of every tool call instead of a one-line summary;
`--voice` reads replies aloud. `--accept-remote-prompts` lets `bernard say
--run` start turns in that session — see `bernard-permissions`.

## Keys, providers and models

`add-key` and `remove-key` for the three built-in providers.
`add-provider` and `remove-provider` register anything else that speaks one of
their APIs. `set-model-mode` moves the cost ladder, and `validate-lineup`
probes every model in a lineup for real. See `bernard-models`.

## Settings and profiles

`list-options` prints the configurable options and their current values;
`reset-option` and `reset-options` put them back, and `set-max-concurrent`
caps how many sub-agents may run at once. `profiles` lists the saved settings
profiles. `bernard-settings` has the full table, and `/agent-options`
inside a session is the friendlier way to change any of it.

## Scheduled jobs

`cron-list`, `cron-run` to fire one by hand now, `cron-delete`,
`cron-delete-all`, and `cron-stop` / `cron-bounce` for the daemon or for
individual jobs. `cron-grant` is how a job is given somewhere extra to write or
a tool it otherwise could not run. See `bernard-cron`.

## Applets

`app` is the family: `app list`, `app open`, `app allow`, `app csp`,
`app logs`, `app delete`, `app path`. `app-grant` sets the permission rules one
applet runs under, and `applet-host` manages the little web server that serves
them — `status`, `start`, `stop`, and `install` / `uninstall` to run it as a
login service. `script` runs one applet action from a shell and prints a single
JSON object. See `applet-host`.

## Knowledge libraries

`knowledge` is the family: `list`, `create`, `add`, `search`, `read`, `remove`,
`stats`. These are your documents, ingested and searchable. See
`bernard-knowledge`.

## Memory

`facts` browses what Bernard has picked up from conversations, and
`clear-facts` **permanently deletes all of it** — there is no undo, and `-s
<id>` scopes either one to a single specialist's own store instead of yours.
Written memory — the notes you asked Bernard to keep — is separate and lives
under `/memory` inside a session. See `bernard-memory`.

## Connected services

`mcp-list` shows the configured MCP servers and `remove-mcp` removes one.
Adding and testing them happens inside a session, where Bernard can do the
work. See `bernard-mcp`.

## Reaching a running session

`bernard say <text>` puts a message in front of a session that is already open
— a build finished, a deploy settled. `--list` shows which sessions are live,
`--all` reaches every one of them, and `--run` asks the session to act on the
message rather than just show it, which only works if it was started to accept
that. See `bernard-permissions`.

## Diagnostics

`tool-profiles` shows what Bernard has learned about each tool's reliability —
successes, the mistakes it corrected, and failures it could not learn from.
`voice-test` speaks a phrase to check the text-to-speech backend works at all.
Both exist to answer "why is this not working", and neither changes anything.
