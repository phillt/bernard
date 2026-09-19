---
title: Installing Bernard and the first run
description: Installing Bernard, what the first run asks, where it keeps your files, and how it updates itself. Read when the user is setting Bernard up or asks where something is stored.
---

# Getting started

## Install

```
npm install -g bernard-agent
```

That puts a `bernard` command on your path. Running it with no arguments opens
the REPL — the prompt where you type and Bernard answers.

Bernard needs an API key for at least one of Anthropic, OpenAI or xAI, or an
endpoint that speaks one of those three APIs. Nothing works without one.

## The first run

A fresh install opens the setup walk before the prompt. You can run it again at
any time with `bernard setup`, or `/setup` from inside a session.

It has two halves. First, **which providers you have keys for** — one page per
provider, each optional, so a single walk can add a second and a third. Then
**your settings**, and it asks how many of those you want:

- **Quick** is three questions. What Bernard may do without asking, how much it
  spends per turn, and which colours the terminal uses. They are the three
  where no default can be right for everyone and where you can answer from the
  screen on the first day.
- **Full** walks every setting. `bernard setup --expert` skips straight to it.

Everything else is left at a default, and you can change any of it later from
`/agent-options` — see `bernard-settings` for the whole list.

Two things worth knowing about the walk. Every question opens on the value
that is in force right now, and only what you actually change is saved: a
setting you leave alone keeps reading whatever `BERNARD_*` variable you had
set for it. And the walk ends by making one real call, to check the key works
— `bernard setup --no-verify` skips that.

## Where your things live

Bernard follows the XDG directory convention, so nothing lands in your home
directory directly.

| what                                                         | where                                 |
| ------------------------------------------------------------ | ------------------------------------- |
| keys, profiles, custom providers, MCP servers                | `XDG_CONFIG_HOME`, or `~/.config`     |
| memory, knowledge libraries, cron jobs, applets, specialists | `XDG_DATA_HOME`, or `~/.local/share`  |
| the model catalogue and downloaded models                    | `XDG_CACHE_HOME`, or `~/.cache`       |
| conversation history, logs, running-session records          | `XDG_STATE_HOME`, or `~/.local/state` |

Each gets a `bernard` subdirectory. Setting any of those four variables moves
that category; they must be absolute paths, and a relative one is ignored.

Set `BERNARD_HOME` instead and all four collapse into that one directory. That
is the setting to use for a portable install, a throwaway sandbox, or a second
Bernard whose data must not touch the first one's.

Keys and connected services are shared across every profile. Settings are not
— see `bernard-settings`.

## Staying up to date

Bernard checks for a new version while you work and installs it **when you
close the session**, not in the middle of one. It tells you to restart; there
is nothing else to do.

`bernard update` checks and installs now. `bernard auto-update off` stops the
automatic half, and `bernard auto-update on` restores it.

## Getting unstuck

`bernard --help` lists every command, and `<command> --help` explains one.
Inside a session, `/help` lists the slash commands.

If Bernard cannot make a call at all, `bernard providers` shows which providers
have a key stored, and `bernard validate-lineup` actually tries each model in
the active lineup — which is the only thing that answers "is this model real
and can I call it".
