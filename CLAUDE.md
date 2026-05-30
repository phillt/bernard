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
- **src/agent.ts** — Agent loop using AI SDK `generateText` + `maxSteps` + auto-continue on truncation
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
- **src/overlap-checker.ts** — Token-based Jaccard overlap detection for specialist candidates
- **src/reference-resolver.ts** — Pre-turn LLM pass that resolves user-named entities (e.g. "my daughter") against persistent memory; returns `resolved`, `ambiguous` (menu), `unknown` (prompts user), or `noop`. Invoked from `src/repl.ts` before `agent.processInput` and rendered as a `## Resolved References` block in the system prompt (agent-visible, user-hidden).
- **src/reference-tool-lookup.ts** — Pre-fallback module that runs only when the resolver returns `unknown`. Picks one read-only allowlisted lookup tool (MCP `*_search`/`*_list`/`*_read`/etc., plus `web_search`/`web_read`) via an LLM call, executes it with a 5 s hard timeout enforced via `Promise.race` (so even MCP tools that ignore `abortSignal` can't stall the REPL), and interprets the result into `{none|found|ambiguous}`. The `select` and `interpret` LLM calls respect the parent abort signal (Esc cancels) but are otherwise bounded by the AI SDK's API timeout. On `found`, the REPL shows a Save/Edit/Skip menu before persisting to memory. Fails open at every stage. Gated by `config.referenceLookup` (default on).
- **src/prompt-rewriter.ts** — Pre-turn LLM pass that rewrites the user's message for the active model family (see `ModelProfile.rewriterHint` in `src/providers/profiles.ts`). Runs after reference-resolution so resolved entities can be inlined. Temperature 0, fail-open to the original prompt, gated by `config.promptRewriter` (default on; toggle via `/agent-options` or `BERNARD_PROMPT_REWRITER=false`).
- **src/providers/** — `getModel()` factory returning AI SDK `LanguageModel`. `getModelForConfig(config, provider, model)` wraps it to consult `config.customProviders` and route through `createOpenAI` / `createAnthropic` / `createXai` with `{ baseURL, apiKey }` when the active provider is user-defined.
- **src/custom-providers.ts** — `CustomProviderStore`: single-file JSON store at `~/.config/bernard/custom-providers.json`. Each entry binds a user-chosen `name` to one of the three installed SDKs (`openai` / `anthropic` / `xai`), a `baseURL`, a `defaultModel`, and a remembered `models[]` list that grows as the user types new names in `/model`. Reserved names: `anthropic`, `openai`, `xai`.
- **src/tool-call-repair.ts** — `makeRepairHook()`: one-shot `ToolCallRepairFunction` wired into every `generateText` site (main, specialist, subagent, tool-wrapper, cron). Re-prompts the model on `InvalidToolArgumentsError` / `NoSuchToolError`. Detects argument truncation (e.g. a 16 KB heredoc cut mid-string) and steers the retry toward `file_write` + `shell` instead of inlining payloads. Forwards the parent abort signal so user-cancel (Esc) also cancels the repair call.
- **src/tools/wrap-with-specialist.ts** — Transparent shim that routes the main agent's direct `shell`, `web_read`, and `file_*_lines` calls through their wrapper specialists (same tool name/schema; only `execute` changes). On `status: 'ok'` returns the wrapper's `result` as-is; on `status: 'error'` maps to the _native_ tool's error shape so `detectToolError` and tool-profile learning still see the right format. Falls through to the raw tool when the specialist is missing or wrong kind. Only active on the main agent — sub-agents and wrappers themselves bypass it.
- **src/tools/ask-user.ts** — `ask_user` tool: pauses the agent loop to ask the user one or more clarifying questions and waits for their answers. Accepts a `questions` array (1-10 entries), each with optional `choices` / `allow_other` / `other_label`. For batches of 2+ the REPL pins a tab strip above the menu. Returns `{answers: [...]}`, `{cancelled: true, answered: [...]}` on Esc, or `{unavailable: true}` when running headless. Exists so the agent stops writing clarifying questions as prose (which leaves the turn idle and, in coordinator mode, trips the plan-enforcement loop).
- **src/framework/agents/pac-planner.ts**, **pac-actor.ts**, **pac-critic.ts** — Three `AgentDefinition`s that compose the sub-agent **PAC pipeline** (Planner → Actor → Critic). Each phase is ephemeral with its own system prompt, strictly-scoped tool set, and step budget (planner 20%, actor 60%, critic 20% of `ceil(maxSteps * SUBAGENT_STEP_RATIO)`). Planner outputs a numbered plan + success criteria; Actor executes against the plan; Critic verifies with read-only tools and emits a `{verdict, reason}` JSON. Phases do not share LLM history — outputs flow forward as plain strings.
- **src/framework/pac/run-pac.ts** — `runPAC()` orchestrator: invokes the three definitions in sequence. On Critic `fail` with retry budget remaining (`PAC_MAX_RETRIES = 1`), re-runs the Planner with the prior plan + critic feedback and then the Actor + Critic again. After retries exhausted, returns the Actor's last output with a `## Critic Verdict: FAIL` footer so the main agent can see verification failed.
- **src/provenance.ts** — Per-turn `ProvenanceStore` that collects cite-able sources (`web` / `rag` / `memory` / `file` / `tool-result` / `user`). Retrieval tools (`web_read`, `web_search`, `file_read_lines`, `memory.read`, `scratch.read`) auto-register entries; RAG hits are registered by `Agent.processInput`. The store lives on `AgentContext.provenance`, is cleared at the start of every turn, and is shared by reference with sub-agent / tool-wrapper contexts (via `ToolWrapperDeps.provenance` → `depsToCtx`) so retrieval inside a wrapper specialist shows up in the parent's viewer. Treated as **untrusted data** (OWASP LLM01): `<available_sources>` lives in the per-turn user-role context message, not the SYSTEM channel, and every label/preview/rawRef is XML-escaped before interpolation. When the policy engine sets `citations.requireForFactualClaims` (issue #173 default) the SYSTEM prompt instructs the model to attach `[^Sn]` markers to factual claims or to prefix with `[unverified]` when no source matches. Use the `cite` tool to inspect the store mid-turn. **Shift+Tab** in the REPL toggles a pinned `<sources>` overlay showing the citations resolved against the last response (falls back to all-available when nothing was cited). The skip-inline-markers gate `REASONING_FAMILIES` keeps reasoning-family models from being told to narrate citation markers.
- **src/tools/** — Tool registry; each tool is a separate file using `tool()` from `ai`

## Custom Providers

Users can register named **custom providers** that wrap one of the installed SDKs (`openai`, `anthropic`, `xai`) and point it at a non-default endpoint — Ollama, LM Studio, OpenRouter, internal proxies, etc. Multiple custom providers can coexist with the built-ins.

```bash
# CLI:
bernard add-provider ollama --sdk openai --base-url http://localhost:11434/v1 --model llama3.2 [--key <api-key>]
bernard remove-provider ollama
bernard providers                # lists built-ins and custom side-by-side

# REPL:
/provider                        # menu now ends with "+ Add custom provider…" (interactive wizard)
/model                           # for a custom provider, menu ends with "+ Type a new model name…"
```

Keys for custom providers are stored in `keys.json` (same path as built-ins) and never injected into `process.env`. Built-in providers are unaffected.

## Model Mode (multi-model assignment)

`config.modelMode` (#170) tiers the (provider, model) used by each LLM call site within the active provider's model lineup. Four presets:

- `off` (default) — every site uses `config.provider`/`config.model`. Legacy behavior, zero overhead.
- `optimize-tokens` — aggressive cost-saving. Main uses **mid**, every sub-agent/wrapper/router site uses **cheap**.
- `balanced` — main **premium**; specialist/tool-wrapper/compressor **mid**; rewriter/reference-resolver/reference-lookup/specialist-detector **cheap**.
- `optimize-performance` — every site uses **premium**.

Per-provider tier → model mapping (in `src/model-policy.ts`):

| Provider  | premium                 | mid                        | cheap                     |
| --------- | ----------------------- | -------------------------- | ------------------------- |
| anthropic | claude-opus-4-6         | claude-sonnet-4-5-20250929 | claude-haiku-4-5-20251001 |
| openai    | gpt-5.2                 | gpt-4.1                    | gpt-4.1-mini              |
| xai       | grok-4-1-fast-reasoning | grok-4-fast-non-reasoning  | grok-3-mini               |

Custom providers fall back to `config.model` for every site (no tier mapping). Invocation-level overrides and per-specialist `provider`/`model` records always win over the policy. When `modelMode !== 'off'` and a specialist is created without an explicit provider/model, the policy-resolved `specialist`-tier model is persisted onto the new record so later mode changes don't silently re-tier it.

```bash
bernard set-model-mode balanced            # CLI
# REPL: /agent-options → Model mode
```

The single source of truth is `resolveSiteModel(config, site, opts?)` in `src/model-policy.ts`. Every `generateText` call site routes through it. Set `BERNARD_DEBUG=1` to see `model-policy:resolve` log entries per site.

## Key Patterns

- **Vercel AI SDK** (`ai` package) provides unified tool calling across Anthropic/OpenAI/xAI
- Adding a built-in provider: one import + one case in `src/providers/index.ts`. To wrap an existing SDK at a different endpoint, use **Custom Providers** (`bernard add-provider`) instead — no code change.
- Adding a tool: create `src/tools/newtool.ts`, register in `src/tools/index.ts`
- All `generateText` call sites use `getModelForConfig(config, provider, model)` + `getProviderOptionsForConfig(config, provider)` rather than calling `getModel`/`getProviderOptions` directly, so custom-provider endpoints are routed transparently.
- Config loads `.env` from cwd first, then `$XDG_CONFIG_HOME/bernard/.env`, then legacy `~/.bernard/.env`
- **src/paths.ts** centralizes all file paths using XDG Base Directory Specification
- CommonJS (no `"type": "module"` in package.json) for chalk v4 compatibility
- TypeScript with `module: "Node16"` and `.js` extensions in imports
- Agent system prompt includes a context-gathering protocol (follow threads, search memory, flag inferred numbers, ask when uncertain). See the `## Context Gathering` section in `BASE_SYSTEM_PROMPT` (src/agent.ts).
- Reference resolver (pre-turn): expands user-named entities against memory via one `generateText` call; asks via `selectFromMenu` on ambiguity; persists hints to `rewriter-hints.md`. Fails open (returns `noop`) on LLM error. See `src/reference-resolver.ts` and the hook in `src/repl.ts`.
- Wrapper-routing shim: on the main agent only, `shell` / `web_read` / `file_read_lines` / `file_edit_lines` are transparently routed through their bundled wrapper specialists. Same tool name and schema — only `execute` changes — so the model can't tell the difference, but the wrapper adds OS-aware examples, schema validation, and structured-output capping. See `src/tools/wrap-with-specialist.ts`.
- Tool-call repair: every `generateText` site installs `makeRepairHook(...)` (see `src/tool-call-repair.ts`). On `InvalidToolArgumentsError` / `NoSuchToolError` a one-shot re-prompt asks the model to fix the arguments; truncation errors (huge inline strings cut mid-JSON) get a hint to use `file_write` + `shell` instead of inlining payloads.
- Per-turn execution-strategy selection (#167): `config.coordinatorMode` is tri-state (`on | off | auto`, default `auto`). The Policy Engine's `strategyPolicy` (`src/policy/strategy.ts`) short-circuits on `on`/`off` and delegates to the **Qualifier** (`src/qualifier/`) on `auto`. `DefaultQualifier` is rule-based with feature extractors grounded in LLM-routing research (`src/qualifier/signals.ts`: tool-invocation verbs from Topaz/MoMA, multi-step phrasing + numbered lists from RouteLLM, token tiers from RouterArena/RouterBench, question count from FrugalGPT, Bloom's-Taxonomy levels from RouterArena). The decision tree escalates on multi-step language, tool-keyword + complexity, 2+ sub-questions, or Apply/Analyze/Evaluate Bloom levels; otherwise defaults to Normal (FrugalGPT-style "try the cheap path first" cascade). `isReactEffective` (`src/policy/effective.ts`) is the single source of truth for "is React active right now" — main-agent tool-set assembly (`framework/agents/main.ts`) gates `plan` / `evaluate` on the same value the strategy uses, so qualifier decisions never drift from the wired tool surface. Telemetry: `debugLog('policy:decide', …)` records the decision + reason map every turn; `debugLog('qualifier:outcome', …)` adds `{strategyId, reason, steps, hitStepLimit, coordinatorMode}` at per-turn stats flush.
- Dangerous-command safelist: shell commands whose target path starts with `BERNARD_TMP_PREFIX` (an internal constant exported from `src/tools/shell.ts`, equal to `path.join(os.tmpdir(), 'bernard-')` — not a user-facing env var) and contain no shell metacharacters skip the confirmation menu. Intentionally narrow so Bernard's own scratch-script cleanup doesn't pop a prompt; arbitrary `rm` still confirms.

## Evals

Behavioral evals live in `scripts/eval-*.ts`. They run real API calls and are gated behind `BERNARD_EVAL=1` so they never run in CI or day-to-day development. Set an absolute `BERNARD_HOME` so the eval uses an isolated data directory.

- `scripts/eval-context-gathering.ts` — measures whether the context-gathering protocol (`src/agent.ts` `BASE_SYSTEM_PROMPT`) gets the agent to read named memory before answering count-dependent questions. Informs the ship/defer decision on issue #123.

## File Locations (XDG Base Directory)

Bernard follows the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/). All paths are centralized in `src/paths.ts`.

| Category   | Default Location          | Contents                                                                                                                                                                      |
| ---------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Config** | `~/.config/bernard/`      | `preferences.json`, `keys.json`, `custom-providers.json`, `.env`, `mcp.json`                                                                                                  |
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
- `BERNARD_COORDINATOR_MODE` — Tri-state execution-strategy selector: `on | off | auto` (default: `auto`). `on` runs ReAct every turn (think → act → evaluate → decide loop with plan tool + enforcement, per-turn step budget `min(BERNARD_MAX_STEPS * 3, 150)`, up to 2 extra re-prompts if the plan still has unresolved steps — worst-case step count `effectiveMaxSteps * 3`, subagent budgets unaffected). `off` runs single-shot Normal every turn. `auto` runs the per-turn Qualifier (`src/qualifier/`) which classifies the user message via rule-based features grounded in LLM-routing research (RouteLLM, FrugalGPT, Topaz, MoMA, RouterArena) and emits `strategyId: 'normal' | 'react'` plus a kebab-case reason that flows through `policy:decide` + `qualifier:outcome` debug logs.
- `BERNARD_REACT_MODE` — Deprecated alias for `BERNARD_COORDINATOR_MODE`: `true` → `on`, `false` → `off`. Use `BERNARD_COORDINATOR_MODE` directly.
- `BERNARD_MODEL_MODE` — Multi-model assignment policy (#170): `off | optimize-tokens | balanced | optimize-performance` (default: `off`). See the "Model Mode" section above.
- `BERNARD_SUBAGENT_PAC` — Route sub-agent dispatch through the PAC (Planner → Actor → Critic) pipeline instead of the legacy single-agent path (default: true). Each phase is a distinct `AgentDefinition` with its own ephemeral history, tool subset, and step budget (20% / 60% / 20% of the sub-agent allotment). On critic `fail` the orchestrator re-plans with critic feedback and re-runs the actor once (`PAC_MAX_RETRIES = 1`); after final failure the actor output is returned with a `## Critic Verdict: FAIL` footer. Set to `false` to fall back to the legacy `sub` definition. See `src/framework/pac/run-pac.ts`.
- `BERNARD_SUBAGENT_RESULT_MAX_CHARS` — Max characters returned from a sub-agent / specialist into the parent agent's context, default 4000. The user still sees full output in the terminal.
- `BERNARD_AUTO_CREATE_SPECIALISTS` — Auto-create specialists above confidence threshold (default: false)
- `BERNARD_AUTO_CREATE_THRESHOLD` — Confidence threshold for auto-creating specialists, 0-1 (default: 0.8)
- `BERNARD_CORRECTION_ENABLED` — Run the correction agent at session close to learn from tool-wrapper failures (default: true)
- `BERNARD_PROMPT_REWRITER` — Run the model-specific prompt rewriter as a pre-turn LLM pass (default: true). Fails open to the original prompt on any error.
- `BERNARD_REFERENCE_LOOKUP` — When the reference resolver returns `unknown`, attempt one read-only tool lookup (e.g. a Google Contacts MCP) before prompting the user for free-form text (default: true). The tool-execution stage is hard-capped at 5 s via `Promise.race` (resilient to MCP tools that ignore `abortSignal`); the surrounding LLM `select`/`interpret` calls respect the parent abort signal. Fails open at every stage. See `src/reference-tool-lookup.ts`.
- `BERNARD_LOOKUP_TOOLS` — Comma-separated tool-name allowlist additions for the resolver lookup pass (additive over the built-in MCP read-only suffix patterns + `web_search` / `web_read`). Use sparingly — only allow tools that are read-only.
- `BERNARD_CONFIRM_MODE` — Risk-based confirmation policy (#144): `off | auto | strict` (default: `auto`). `off` never prompts; `auto` prompts only on **high**-risk calls (dangerous shell, write+external-api tools); `strict` also prompts on **medium**-risk calls (local writes, unclassified MCP). The Policy Engine's `toolMode.confirmThreshold` short-circuits to `never` on pure-question turns (rule-based `isPureQuestion` in `src/policy/tool-mode.ts`). REPL renders a three-option menu (Allow once / Allow for session / Cancel) with an in-memory per-`toolName:hash(args)` allowlist that clears on REPL restart. Cron silently proceeds through low/medium and auto-denies high. Risk tiers derive from `ToolMeta.kind` + `sideEffect` via `src/risk.ts`; tools can declare `meta.risk` to override. MCP tools default to `kind: 'write', sideEffect: 'local'` (medium), opting `*_search` / `*_list` / `*_find` / `*_get` / `*_query` / `*_read` / `*_lookup` to `read` (low).
- `BERNARD_TOOL_MODE` — Least-privilege tool mode (#179): `read-only | write` (default: `read-only`). In `read-only` mode any tool whose meta classifies it as a write (`kind` in `{'write','dangerous'}`) is blocked until the user picks **Allow once** or **Enable for this tool, this session** at the REPL block menu (rendered with the 🔒 prefix). `write` mode lets every tool run subject only to the `confirmMode` risk gate. The two settings are **orthogonal**: `toolMode` answers "is this allowed to run at all?" and `confirmMode` answers "do I want to be asked first?" — when both fire on the same call, the block gate runs first and the confirm gate may still fire on allowance. The per-tool session allowlist is owned by the REPL (`sessionToolAllowlist: Set<string>` on `ToolOptions`, threaded through to `augmentTools` in `src/tools/augment.ts`) so an "Enable for this tool, this session" decision survives across turns and across nested sub-agent / tool-wrapper dispatches; it clears on REPL restart. When no shared Set is provided (tests, cron), `augmentTools` falls back to a closure-local Set. Tools without classified meta (legacy / foreign) fall through the block gate so they don't get bricked silently — MCP tools already get `kind: 'write'` by default via `wrapMCPTool()` so unclassified MCP writes still trip the gate. Pure-question turns bypass both gates via the existing `isPureQuestion` short-circuit. **Cron is exempt by design** — `cron/runner.ts` never assembles a `policyDecision`, so the augment layer defaults to `'write'` and write-tool jobs run as the user scheduled them.
- **OpenAI strict-schema mode** is disabled for all `generateText` calls (see `getProviderOptions` in `src/providers/index.ts`). MCP tool schemas come from third parties and use full JSON Schema features that strict mode rejects at preflight. Trade-off: tool calls become advisory rather than enforced — minor reliability cost, large UX win. To re-enable for a specific call, pass `providerOptions: { openai: { strictSchemas: true } }` directly.
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `XAI_API_KEY` — Provider API keys
- `BRAVE_API_KEY` — Optional: Brave Search API key for `web_search` (first provider tried)
- `TAVILY_API_KEY` — Optional: Tavily API key for `web_search` (fallback when Brave is absent)

## Tool-Wrapper Specialists

Specialists have a `kind` field: `persona` (default, historic behavior), `tool-wrapper` (fronts a concrete tool or CLI with OS-aware examples and strict JSON output), or `meta` (operates on other specialists).

- **`tool_wrapper_run`** — Dispatch tool that the main agent uses to invoke tool-wrapper or meta specialists. Returns strict JSON `{status, result, error?, reasoning?}`. Isolates tools by `targetTools` so e.g. `shell-wrapper` cannot call `web_read`.
- **`web_search`** — Provider chain (Brave → Tavily → DuckDuckGo scrape); returns `[{title,url,snippet}]`. Used by `web-wrapper` and `specialist-creator`.
- **Bundled specialists** seeded on first run into `specialists/`: `shell-wrapper`, `file-wrapper`, `web-wrapper`, `correction-agent`, `specialist-creator`. Users can edit them freely; `.seeded-v1` marker prevents re-seeding.
- **Correction flow**: when `tool_wrapper_run` returns `status: 'error'`, the error is classified via `src/error-taxonomy.ts`; only **correctable** failures (call-shape mistakes: `invalid_args`, `exec_failed`, `not_found` in shell context) get enqueued in `correction-candidates/`. Environmental failures (HTTP 404, `rate_limit`, `auth`, `pool_exhausted`, `parse_failed`, etc.) are dismissed at the boundary and never pollute the queue. At REPL startup the store also runs `dismissNonCorrectable(classifyError)` to drain pre-existing non-correctable rows. At REPL shutdown the `correction-agent` proposes a fix and emits `proposedGoodCall: {specialistId, input}` alongside `applied: true`; the orchestrator (`src/correction.ts`) then **independently re-executes** that call via `tool_wrapper_run` and only marks the candidate `applied` if the re-run returns `status: 'ok'`. Otherwise it's marked `invalid` with a `re-validation failed` note. Good/bad examples are capped at 10 each, oldest drops.
- **Organic tool discovery**: the `specialist-creator` meta-agent researches unknown tools via `shell` (man/--help), `web_search`, and `web_read`, drafts a new tool-wrapper, validates it with `tool_wrapper_run`, and only then commits. Invoke via `tool_wrapper_run { specialistId: 'specialist-creator', input: 'create a specialist for jq' }`.

## Tool Augmentation Layer

A transparent layer that wraps every tool's `execute` function to observe errors and inject usage guidance into the system prompt. Completely separate from the specialist system.

- **Profiles**: Each tool gets a JSON profile at `tool-profiles/<key>.json` with guidelines, good/bad examples (max 5 each). Profiles are auto-created on first error — no pre-configuration needed for new tools or MCP servers.
- **Shell sub-categories**: Shell commands are classified by prefix regex (`git` → `shell.git`, `gh` → `shell.gh`, `docker` → `shell.docker`, `npm` → `shell.npm`, `ls`/`find`/etc. → `shell.fs`, `curl`/`wget` → `shell.http`). Each sub-category has its own profile.
- **Error learning**: When a tool returns an error, the error is classified via `src/error-taxonomy.ts`; only **correctable** errors (call-shape mistakes) become bad examples — environmental failures (HTTP 4xx/5xx, `rate_limit`, `pool_exhausted`, etc.) are dismissed so the playbook isn't polluted with "things the model can't fix." Successful tool calls always bump `successCount` (via `recordSuccess`), and when the model retries successfully after a recorded error, the bad example's `fix` field is patched with the working args.
- **System prompt injection**: `buildToolProfilesPrompt()` renders a compact `## Tool Usage Profiles` block showing guidelines and the 2 most recent bad examples per tool (~800 tokens worst case).
- **MCP tools**: Augmented automatically. Identified by `__` in tool name (the `@ai-sdk/mcp` convention). Profiles stored at `mcp.<name>.json`.
- **Seeded defaults**: Guidelines for `shell.git`, `shell.fs`, `shell.npm`, `web_read`, `file_read_lines`, `file_edit_lines` ship built-in and are seeded on first run (`.seeded-v1` marker).

## Failure Taxonomy

`src/error-taxonomy.ts` is a central classifier that turns a raw tool error (message, optional `toolName`/`errno`/`httpStatus`) into `{category, correctable, retryable, severity, playbook: {user, model}}`. Categories: `invalid_args | exec_failed | not_found | auth | rate_limit | permission | timeout | transient | parse_failed | pool_exhausted | cancelled | unknown`. `not_found` is correctable only when `toolName === 'shell'` (a command-not-found mistake the model can fix) — for web tools a 404 is "the URL is gone," not learnable.

The same classification drives four surfaces:

- **Correction queue gate**: `src/tools/tool-wrapper-run.ts` only enqueues a candidate when `cls.correctable === true`. Non-correctable failures are logged and dropped.
- **Profile gate**: `src/tools/augment.ts` only records bad examples when `cls.correctable === true`; success always bumps `recordSuccess`.
- **User render**: the wrapper-routing shim (`src/tools/wrap-with-specialist.ts`) calls `printToolFailure(category, snippet, playbook.user, severity)` so the terminal shows a two-line `category: snippet → recovery hint` block whose color follows severity.
- **Model hint**: the same shim prepends `[failure: <category>] <playbook.model>` to the error string the model sees on its next turn.
- **Cron alerts**: `src/cron/runner.ts` classifies any job-level throw and fires `sendNotification({severity, ...})` with the user-facing playbook so headless jobs surface failures with the right urgency.

Severity map — `critical`: `auth`, `permission`; `normal`: `rate_limit`, `not_found`, `invalid_args`, `exec_failed`; `low`: everything else.
