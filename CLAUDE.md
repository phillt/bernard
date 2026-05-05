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
- **src/agent.ts** — Agent loop using AI SDK `generateText` + `maxSteps` + auto-continue on truncation + optional critic verification
- **src/config.ts** — .env loading, defaults, validation
- **src/output.ts** — Chalk-based terminal formatting
- **src/menu.ts** — Ephemeral arrow-key selection UI rendered via `setPinnedRegion('menu', ...)` (`selectFromMenu`, `promptValue`). Arrow keys move the highlight; Enter commits; Esc/q/Ctrl-C cancel; digits 1-9 commit immediately. Non-TTY or `BERNARD_PLAIN_MENU=1` falls back to a numbered-list + `rl.question` path.
- **src/theme.ts** — Color theme definitions (bernard, ocean, forest, synthwave, high-contrast, colorblind)
- **src/domains.ts** — Memory domain registry (tool-usage, user-preferences, general) with specialized extraction prompts
- **src/routines.ts** — RoutineStore class: per-file JSON storage for named multi-step workflows
- **src/specialist-matcher.ts** — Keyword scorer matching user input to saved specialists for auto-dispatch
- **src/correction.ts** — Orchestrates the `correction-agent` meta-specialist at REPL shutdown to learn from tool-wrapper failures
- **src/correction-candidates.ts** — `CorrectionCandidateStore`: queue of failed tool-wrapper invocations for post-session review
- **src/structured-output.ts** — `{status, result, error?, reasoning?}` JSON parser for tool-wrapper output
- **src/os-info.ts** — OS detection helper; `osPromptBlock()` is injected into tool-wrapper system prompts
- **src/reasoning-log.ts** — Appends one JSONL entry per `tool_wrapper_run` to `logs/tool-wrappers.jsonl`
- **src/builtin-specialists/** — Bundled specialists (shell/file/web wrappers + correction-agent + specialist-creator) seeded on first run
- **src/tool-profiles.ts** — `ToolProfileStore`: per-tool profiles with guidelines and good/bad examples, auto-learned from errors
- **src/tools/augment.ts** — `augmentTools()`: transparent execute-wrapper that observes every tool call, records errors, and patches fixes on retry
- **src/cron/notes-store.ts** — `CronNotesStore`: per-job persistent notes (JSON per job, capped at 100 entries, atomic writes). Daemon runner injects `cron_notes_read` / `cron_notes_write` scoped to `job.id` + `runId` so cron runs can avoid duplicate work across restarts; `cron_logs_get` appends a `## Notes written during this run` section.
- **src/critic.ts** — Standalone critic functions: `extractToolCallLog`, `runCritic`, and critic constants/types
- **src/pac.ts** — Plan-Act-Critic loop wrapper (`runPACLoop`) for sub-agents and specialists
- **src/overlap-checker.ts** — Token-based Jaccard overlap detection for specialist candidates
- **src/reference-resolver.ts** — Pre-turn LLM pass that resolves user-named entities (e.g. "my daughter") against persistent memory; returns `resolved`, `ambiguous` (menu), `unknown` (prompts user), or `noop`. Invoked from `src/repl.ts` before `agent.processInput` and rendered as a `## Resolved References` block in the system prompt (agent-visible, user-hidden).
- **src/reference-tool-lookup.ts** — Pre-fallback module that runs only when the resolver returns `unknown`. Picks one read-only allowlisted lookup tool (MCP `*_search`/`*_list`/`*_read`/etc., plus `web_search`/`web_read`) via an LLM call, executes it with a 5 s hard timeout, and interprets the result into `{none|found|ambiguous}`. On `found`, the REPL shows a Save/Edit/Skip menu before persisting to memory. Fails open at every stage. Gated by `config.referenceLookup` (default on).
- **src/prompt-rewriter.ts** — Pre-turn LLM pass that rewrites the user's message for the active model family (see `ModelProfile.rewriterHint` in `src/providers/profiles.ts`). Runs after reference-resolution so resolved entities can be inlined. Temperature 0, fail-open to the original prompt, gated by `config.promptRewriter` (default on; toggle via `/agent-options` or `BERNARD_PROMPT_REWRITER=false`).
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
- Agent system prompt includes a context-gathering protocol (follow threads, search memory, flag inferred numbers, ask when uncertain). See the `## Context Gathering` section in `BASE_SYSTEM_PROMPT` (src/agent.ts).
- Reference resolver (pre-turn): expands user-named entities against memory via one `generateText` call; asks via `selectFromMenu` on ambiguity; persists hints to `rewriter-hints.md`. Fails open (returns `noop`) on LLM error. See `src/reference-resolver.ts` and the hook in `src/repl.ts`.

## Evals

Behavioral evals live in `scripts/eval-*.ts`. They run real API calls and are gated behind `BERNARD_EVAL=1` so they never run in CI or day-to-day development. Set an absolute `BERNARD_HOME` so the eval uses an isolated data directory.

- `scripts/eval-context-gathering.ts` — measures whether the context-gathering protocol (`src/agent.ts` `BASE_SYSTEM_PROMPT`) gets the agent to read named memory before answering count-dependent questions. Informs the ship/defer decision on issue #123.

## File Locations (XDG Base Directory)

Bernard follows the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/). All paths are centralized in `src/paths.ts`.

| Category   | Default Location          | Contents                                                                                                                                                                      |
| ---------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Config** | `~/.config/bernard/`      | `preferences.json`, `keys.json`, `.env`, `mcp.json`                                                                                                                           |
| **Data**   | `~/.local/share/bernard/` | `memory/*.md`, `rag/`, `routines/*.json`, `specialists/*.json`, `correction-candidates/*.json`, `tool-profiles/*.json`, `cron/jobs.json`, `cron/alerts/`, `cron/notes/*.json` |
| **Cache**  | `~/.cache/bernard/`       | `models/` (embeddings), `update-check.json`                                                                                                                                   |
| **State**  | `~/.local/state/bernard/` | `conversation-history.json`, `logs/*.jsonl`, `cron-daemon.pid`, `cron-daemon.log`                                                                                             |

Override with `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` (must be absolute).

Set `BERNARD_HOME=/path` to force a flat layout (all categories under one directory), like the old `~/.bernard/`.

On first run, files are auto-migrated from `~/.bernard/` to XDG locations. A `~/.bernard/MIGRATED` marker is left behind.

## Environment Variables

- `BERNARD_PROVIDER` — anthropic | openai | xai (default: anthropic)
- `BERNARD_MODEL` — Model name (default: provider-specific)
- `BERNARD_MAX_TOKENS` — Response token limit (default: 4096)
- `BERNARD_SHELL_TIMEOUT` — Shell command timeout ms (default: 30000)
- `BERNARD_TOKEN_WINDOW` — Context window size for compression, 0 = auto-detect (default: 0)
- `BERNARD_MAX_STEPS` — Max agent loop iterations per request (default: 25)
- `BERNARD_HOME` — Override all XDG directories with a single flat path
- `BERNARD_CRITIC_MODE` — Enable critic mode for verification (default: false)
- `BERNARD_REACT_MODE` — Enable coordinator (ReAct) mode for iterative reasoning with subagent delegation (default: false). When on, the per-turn step budget is `min(BERNARD_MAX_STEPS * 3, 150)` to accommodate the think → act → evaluate → decide loop, and an enforcement loop may re-prompt up to 2 extra times if the plan still has unresolved steps. Worst-case step count per turn is therefore `effectiveMaxSteps * 3`. Subagent budgets are unaffected.
- `BERNARD_SUBAGENT_RESULT_MAX_CHARS` — Max characters returned from a sub-agent / specialist into the parent agent's context, default 4000. The user still sees full output in the terminal.
- `BERNARD_AUTO_CREATE_SPECIALISTS` — Auto-create specialists above confidence threshold (default: false)
- `BERNARD_AUTO_CREATE_THRESHOLD` — Confidence threshold for auto-creating specialists, 0-1 (default: 0.8)
- `BERNARD_CORRECTION_ENABLED` — Run the correction agent at session close to learn from tool-wrapper failures (default: true)
- `BERNARD_PROMPT_REWRITER` — Run the model-specific prompt rewriter as a pre-turn LLM pass (default: true). Fails open to the original prompt on any error.
- `BERNARD_REFERENCE_LOOKUP` — When the reference resolver returns `unknown`, attempt one read-only tool lookup (e.g. a Google Contacts MCP) before prompting the user for free-form text (default: true). Hard 5 s timeout, fail-open. See `src/reference-tool-lookup.ts`.
- `BERNARD_LOOKUP_TOOLS` — Comma-separated tool-name allowlist additions for the resolver lookup pass (additive over the built-in MCP read-only suffix patterns + `web_search` / `web_read`). Use sparingly — only allow tools that are read-only.
- **OpenAI strict-schema mode** is disabled for all `generateText` calls (see `getProviderOptions` in `src/providers/index.ts`). MCP tool schemas come from third parties and use full JSON Schema features that strict mode rejects at preflight. Trade-off: tool calls become advisory rather than enforced — minor reliability cost, large UX win. To re-enable for a specific call, pass `providerOptions: { openai: { strictSchemas: true } }` directly.
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `XAI_API_KEY` — Provider API keys
- `BRAVE_API_KEY` — Optional: Brave Search API key for `web_search` (first provider tried)
- `TAVILY_API_KEY` — Optional: Tavily API key for `web_search` (fallback when Brave is absent)

## Tool-Wrapper Specialists

Specialists have a `kind` field: `persona` (default, historic behavior), `tool-wrapper` (fronts a concrete tool or CLI with OS-aware examples and strict JSON output), or `meta` (operates on other specialists).

- **`tool_wrapper_run`** — Dispatch tool that the main agent uses to invoke tool-wrapper or meta specialists. Returns strict JSON `{status, result, error?, reasoning?}`. Isolates tools by `targetTools` so e.g. `shell-wrapper` cannot call `web_read`.
- **`web_search`** — Provider chain (Brave → Tavily → DuckDuckGo scrape); returns `[{title,url,snippet}]`. Used by `web-wrapper` and `specialist-creator`.
- **Bundled specialists** seeded on first run into `specialists/`: `shell-wrapper`, `file-wrapper`, `web-wrapper`, `correction-agent`, `specialist-creator`. Users can edit them freely; `.seeded-v1` marker prevents re-seeding.
- **Correction flow**: when `tool_wrapper_run` returns `status: 'error'`, a candidate is enqueued in `correction-candidates/`. At REPL shutdown, the `correction-agent` proposes a fix, **validates it by actually executing `tool_wrapper_run`**, and only on successful validation appends new good/bad examples to the target specialist (capped at 10 each, oldest drops). This prevents hallucinated examples from entering system prompts.
- **Organic tool discovery**: the `specialist-creator` meta-agent researches unknown tools via `shell` (man/--help), `web_search`, and `web_read`, drafts a new tool-wrapper, validates it with `tool_wrapper_run`, and only then commits. Invoke via `tool_wrapper_run { specialistId: 'specialist-creator', input: 'create a specialist for jq' }`.

## Tool Augmentation Layer

A transparent layer that wraps every tool's `execute` function to observe errors and inject usage guidance into the system prompt. Completely separate from the specialist system.

- **Profiles**: Each tool gets a JSON profile at `tool-profiles/<key>.json` with guidelines, good/bad examples (max 5 each). Profiles are auto-created on first error — no pre-configuration needed for new tools or MCP servers.
- **Shell sub-categories**: Shell commands are classified by prefix regex (`git` → `shell.git`, `gh` → `shell.gh`, `docker` → `shell.docker`, `npm` → `shell.npm`, `ls`/`find`/etc. → `shell.fs`, `curl`/`wget` → `shell.http`). Each sub-category has its own profile.
- **Error learning**: When a tool returns an error, the actual args and error text are recorded as a bad example (no hallucination — only real observed errors). When the model retries successfully, the bad example's `fix` field is patched with the working args.
- **System prompt injection**: `buildToolProfilesPrompt()` renders a compact `## Tool Usage Profiles` block showing guidelines and the 2 most recent bad examples per tool (~800 tokens worst case).
- **MCP tools**: Augmented automatically. Identified by `__` in tool name (the `@ai-sdk/mcp` convention). Profiles stored at `mcp.<name>.json`.
- **Seeded defaults**: Guidelines for `shell.git`, `shell.fs`, `shell.npm`, `web_read`, `file_read_lines`, `file_edit_lines` ship built-in and are seeded on first run (`.seeded-v1` marker).
