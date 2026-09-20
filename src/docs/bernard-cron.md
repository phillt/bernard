---
title: Work that runs on a schedule
description: Scheduled jobs: how one is made, what it may do with nobody watching, and what happens to a fire the machine slept through. Read when the user wants something to happen daily, or asks why a job did nothing.
---

# Scheduled jobs

A cron job is a standing instruction with a clock on it: "every morning at
seven, check the overnight builds and tell me if any failed". It runs with
nobody watching, which is the fact everything else here follows from.

## Making one

Ask. Bernard writes the schedule and the instruction itself; you do not have to
know cron syntax, though `0 7 * * *` works if you do.

`bernard cron-list` shows every job with how it is doing. `/cron` shows the
same inside a session. `bernard cron-run <id>` fires one by hand now, which is
the right way to find out whether an instruction actually works before waiting
a day for it.

Bernard refuses to create a second enabled job with the same schedule and the
same instruction, and names the one that already exists. That refusal exists
because the alternative was measured: 42 identical jobs, same name, same
midnight schedule, all still firing months later.

## What a job may do

A job has its own permissions, separate from yours. By default it may write,
and it is stopped before anything genuinely dangerous — and because there is
nobody to answer a prompt, "stopped" means denied rather than asked.

Each job gets its **own workspace directory**, may write there, and may not
write anywhere else. `bernard cron-grant <id> <path>` adds somewhere else;
`bernard cron-grant <id> --allow 'shell:gh *'` lets it run one command it
otherwise could not. Both are commands you type — a job cannot widen its own
permissions. See `bernard-permissions`.

Workspaces are kept for a month after a job last used one, so output a job
writes for its own next run is still there, and output from a job nobody runs
any more does not accumulate forever.

## Notes across runs

A job keeps notes between runs, so tomorrow's run can see what yesterday's did
and avoid repeating it. This is what stops a job that sends a summary sending
the same summary again after a restart.

## When the machine was asleep

The daemon is an ordinary local process. It does not run while the machine is
suspended and it does not run while the machine is off — nothing catches up
during either. On wake it notices within half a minute and decides per job.

By default a fire that was missed is **skipped**, and the job says so rather
than passing over it silently. Turn on catch-up for a job and one missed fire
runs on wake — one, not the queue, because a laptop shut over a weekend owes an
hourly job sixty runs and replaying them is sixty passes over the same inbox to
reach the answer the first one gives.

`bernard cron-list` shows how many fires a job has dropped lately, and resets
that count when one runs on time.

## When something goes wrong

A failed run raises a notification whose urgency depends on what failed — an
expired key is not the same as a flaky network. A job that fails three times in
a row is flagged in the listing.

A run that completed but was **refused the tool it existed to use** is a
failure too, and says so. That distinction was expensive to learn: one job ran
ten times over forty-five minutes, logged success every time, and did nothing.

## Stopping and starting

`bernard cron-stop` stops the daemon; `bernard cron-stop <id>` disables one
job. `bernard cron-bounce` restarts the daemon, or bounces individual jobs.
`bernard cron-delete <id>` removes a job and everything it left behind — logs,
notes, workspace — and `bernard cron-delete-all` removes every job, which
cannot be undone.

## Cron, a watcher, or waiting

Three different things, and picking the wrong one is the usual mistake.

- **Cron** is for a clock: every morning, every Monday, on the hour.
- **A watcher** is for a change: when John replies, when that page updates,
  when the file appears. See `bernard-watchers`.
- **Waiting inside a turn** is for seconds, not hours — Bernard pausing a
  moment before checking something again, in a turn you are sitting in front
  of.

"Every five minutes, check whether the build finished" is a watcher wearing a
cron costume. Say what you are waiting for and let Bernard watch for it.
