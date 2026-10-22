<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

## File Locations (XDG Base Directory)

Bernard follows the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/). All paths are centralized in `src/paths.ts`.

| Category   | Default Location          | Contents                                                                                                                                                                                                          |
| ---------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Config** | `~/.config/bernard/`      | `profiles.json`, `preferences.json` (legacy, see below), `keys.json`, `custom-providers.json`, `.env`, `mcp.json`                                                                                                 |
| **Data**   | `~/.local/share/bernard/` | `memory/*.md`, `rag/`, `knowledge/<library>/library.db`, `routines/*.json`, `specialists/*.json`, `apps/*.json`, `tool-profiles/*.json`, `cron/jobs.json`, `cron/alerts/`, `cron/notes/*.json`, `watchers/*.json` |
| **Cache**  | `~/.cache/bernard/`       | `models/` (embeddings), `update-check.json`                                                                                                                                                                       |
| **State**  | `~/.local/state/bernard/` | `conversation-history.json`, `provenance-history.json`, `turn-context.json`, `logs/*.jsonl` (incl. `script-invocations.jsonl`), `cron-daemon.pid`, `cron-daemon.log`, `sessions/*.json`, `inbox/<session>/*.json` |

Override with `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` (must be absolute).

Set `BERNARD_HOME=/path` to force a flat layout (all categories under one directory), like the old `~/.bernard/`.

On first run, files are auto-migrated from `~/.bernard/` to XDG locations. A `~/.bernard/MIGRATED` marker is left behind.
