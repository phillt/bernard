---
title: What Bernard can do
description: Bernard's own features — memory, scheduled jobs, specialists, applets, MCP servers, voice — at the level a person asks about them. Read when the user asks what Bernard can do or whether it can do something.
---
# What Bernard can do

Answer from this document rather than from the tool list. The tool list is
what *you* can reach on this turn; it is not what Bernard is.

## Memory

Bernard remembers across sessions in two ways. **Curated memory** is a set of
written facts it keeps and re-reads every turn — preferences, standing
instructions, names of people and things. **Recalled memory** is a larger,
searchable store that surfaces relevant facts when the conversation touches
them, and forgets what stops being used.

You can add to memory during a turn. The person can inspect and edit it.

## Scheduled jobs

Bernard runs work on a schedule, unattended — a daily summary, a check that
something is still up, a weekly tidy. A job has its own tools, its own
permission posture, its own workspace to write into, and keeps notes across
runs so it does not repeat itself. Failures raise a notification with a
severity.

## Specialists

A specialist is a saved agent with its own instructions and its own narrow set
of tools. Some front a specific tool or command line with worked examples;
others carry a persona. Bernard notices when the same kind of work keeps coming
up and offers to make one. It also learns from its own failures at the end of a
session, so a wrapper that got a command wrong gets a corrected example.

## Applets

A small local web app, served on its own origin, whose buttons run Bernard
actions. Someone who cannot write software can describe what they want and get
something they can open and use. Applets can store their own data and keep a
brief recording what they are for. There is a whole set of documents on
building them — start with `applet-page`.

## Tools and connected services

Bernard reads and writes files, runs shell commands, searches and reads the
web, and can connect to external services through MCP servers — mail,
calendars, browsers, whatever the person has configured. Connected servers add
their own tools.

## Permissions

Two independent settings. **Tool mode** decides whether anything that writes is
allowed to run at all. **Confirm mode** decides whether the person is asked
first, by how risky the call is. Grants can be remembered for a session or
saved to the current profile, and a specific one can be revoked.

## Profiles

Named sets of settings — model, tone, limits, permissions — switched in one
step. Keys and connected services stay shared across all of them.

## Models

Bernard runs against Anthropic, OpenAI or xAI, or any endpoint that speaks one
of those APIs. Different parts of a turn can run on different models: the main
answer on a strong one, background passes on a cheaper one. That assignment is
a setting, not something you choose per call.

## Voice

Bernard can read replies aloud, converting written text into something that
sounds right spoken — links named rather than spelled out, numbers read as what
they actually are.

## Being honest about the edges

If someone asks whether Bernard can do something not described here, say you do
not know rather than guessing. A confident wrong answer about a capability
costs them a real attempt at something impossible.
