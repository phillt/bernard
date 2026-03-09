# Bernard — Local CLI AI Agent

## Quick Reference

```bash
npm run build        # Compile TypeScript → dist/
npm run dev          # Run via tsx (no build needed)
npm link             # Install "bernard" command globally
bernard              # Start the REPL
bernard -p openai -m gpt-4o  # Use specific provider/model
```

## Architecture

- **src/index.ts** — CLI entry point (Commander, shebang)
- **src/repl.ts** — Interactive REPL loop (readline)
- **src/agent.ts** — Agent loop using AI SDK `generateText` + `maxSteps`
- **src/config.ts** — .env loading, defaults, validation
- **src/output.ts** — Chalk-based terminal formatting
- **src/theme.ts** — Color theme definitions (bernard, ocean, forest, synthwave, high-contrast, colorblind)
- **src/domains.ts** — Memory domain registry (tool-usage, user-preferences, general) with specialized extraction prompts
- **src/routines.ts** — RoutineStore class: per-file JSON storage for named multi-step workflows
- **src/providers/** — `getModel()` factory returning AI SDK `LanguageModel`
- **src/tools/** — Tool registry; each tool is a separate file using `tool()` from `ai`

## Key Patterns

- **Vercel AI SDK** (`ai` package) provides unified tool calling across Anthropic/OpenAI/xAI
- Adding a provider: one import + one case in `src/providers/index.ts`
- Adding a tool: create `src/tools/newtool.ts`, register in `src/tools/index.ts`
- Config loads `.env` from cwd first, then `$XDG_CONFIG_HOME/bernard/.env`, then legacy `~/.bernard/.env`
- **src/paths.ts** centralizes all file paths using XDG Base Directory Specification
- CommonJS (no `"type": "module"` in package.json) for chalk v4 compatibility
- TypeScript with `module: "Node16"` and `.js` extensions in imports

## File Locations (XDG Base Directory)

Bernard follows the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/). All paths are centralized in `src/paths.ts`.

| Category   | Default Location          | Contents                                                                          |
| ---------- | ------------------------- | --------------------------------------------------------------------------------- |
| **Config** | `~/.config/bernard/`      | `preferences.json`, `keys.json`, `.env`, `mcp.json`                               |
| **Data**   | `~/.local/share/bernard/` | `memory/*.md`, `rag/`, `routines/*.json`, `cron/jobs.json`, `cron/alerts/`        |
| **Cache**  | `~/.cache/bernard/`       | `models/` (embeddings), `update-check.json`                                       |
| **State**  | `~/.local/state/bernard/` | `conversation-history.json`, `logs/*.jsonl`, `cron-daemon.pid`, `cron-daemon.log` |

Override with `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` (must be absolute).

Set `BERNARD_HOME=/path` to force a flat layout (all categories under one directory), like the old `~/.bernard/`.

On first run, files are auto-migrated from `~/.bernard/` to XDG locations. A `~/.bernard/MIGRATED` marker is left behind.

## Environment Variables

- `BERNARD_PROVIDER` — anthropic | openai | xai (default: anthropic)
- `BERNARD_MODEL` — Model name (default: provider-specific)
- `BERNARD_MAX_TOKENS` — Response token limit (default: 4096)
- `BERNARD_SHELL_TIMEOUT` — Shell command timeout ms (default: 30000)
- `BERNARD_TOKEN_WINDOW` — Context window size for compression, 0 = auto-detect (default: 0)
- `BERNARD_HOME` — Override all XDG directories with a single flat path
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `XAI_API_KEY` — Provider API keys
