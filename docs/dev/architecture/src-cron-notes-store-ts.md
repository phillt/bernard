<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

# src/cron/notes-store.ts

- **src/cron/notes-store.ts** — `CronNotesStore`: per-job persistent notes (JSON per job, capped at 100 entries, atomic writes). Daemon runner injects `cron_notes_read` / `cron_notes_write` scoped to `job.id` + `runId` so cron runs can avoid duplicate work across restarts; `cron_logs_get` appends a `## Notes written during this run` section.
