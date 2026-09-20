---
title: Running and managing applets
description: Applets as a person uses them: opening one, what it may reach outside itself, and keeping the server running. Read when the user asks about a small app Bernard built, or why a button does nothing.
---

# Applets

An applet is a small local web app Bernard builds for you. It has a page you
open in a browser, and its buttons run Bernard actions. Someone who cannot
write software can describe what they want and get something they can use.

The documents on **building** one are `applet-page`, `applet-actions`,
`applet-styling`, `applet-ui-runtime` and `applet-brief`. This one is about
having them.

## Getting one

Ask. Bernard interviews you briefly — a handful of questions, not a form —
then plans the thing, builds it, styles it and opens it.

`bernard app list` shows your applets. `bernard app list --bundled` shows the
examples Bernard ships, and `--all` shows both, grouped, so a seeded example is
never mistaken for something you asked for. `/applets` does the same inside a
session.

`bernard app open <id>` opens one, `bernard app path <id>` prints where its
files live, and `bernard app delete <id>` removes it along with its data, its
permissions and anything bound to it.

## The host

Applets are served by a small local web server. Each applet gets its **own
port**, which is what keeps one applet's stored data out of another's reach —
a shared address would mean shared browser storage.

Ports are remembered, so an applet keeps the same address across restarts. That
matters more than it sounds: change an applet's address and the browser throws
away everything it had stored there.

`bernard applet-host status` says whether it is up, `start` and `stop` do the
obvious, and `bernard applet-host install` makes it start when you log in —
a user service, no administrator rights needed. `uninstall` undoes that.

## What an applet may do

Two separate questions.

**Which tools its buttons may use** — `bernard app allow <id> <action>
--tools <names>`, and `bernard app-grant <id> <tools...>` for finer rules with
`--deny` for the other direction. By default an action is read-only and has no
tools at all, so an applet Bernard builds cannot do anything until you say so.

**What the page may reach outside itself** — by default nothing. No images from
other sites, no fonts, no links out. `bernard app csp <id>` shows the grants and
`--img-src`, `--font-src`, `--media-src`, `--connect-src` and `--sandbox` add
them. `--clear` removes them all.

`--connect-src` is the one to think about: it is a two-way channel, so it can
send data out as well as fetch it in.

An applet may **ask** for one of these, and asking is not the same as being
granted. The request is shown with what it actually means, and the applet's own
explanation is quoted and attributed rather than presented as fact.

## When a button does nothing

`bernard app logs <id>` is the first place to look — it shows what each
invocation did in Bernard's own words, including the actual error, and it says
when an action was refused a tool it needed.

The usual cause is the second one: an action whose tool list and whose
specialist do not overlap ends up with nothing, and a run with no tools does
not fail loudly. It answers badly.

## Running one from a script

`bernard script --app <id> --action <name> --args '{"...":"..."}'` runs one
action and prints a single JSON object. `--describe` lists the actions and what
arguments each takes.

The caller supplies an app, an action name and typed arguments — never free
text. That is the security boundary rather than a convenience: an action name
somebody invents simply does not resolve.
