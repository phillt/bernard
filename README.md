# Bernard

A local CLI AI agent that executes terminal commands, manages scheduled tasks, remembers context across sessions, and connects to external tool servers — all through natural language. Supports multiple LLM providers (Anthropic, OpenAI, xAI) via the Vercel AI SDK.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
  - [API Keys](#api-keys)
  - [Environment Variables](#environment-variables)
  - [Providers and Models](#providers-and-models)
  - [Runtime Options](#runtime-options)
- [Usage](#usage)
  - [CLI Flags](#cli-flags)
  - [CLI Management Commands](#cli-management-commands)
  - [Interactive REPL](#interactive-repl)
  - [REPL Slash Commands](#repl-slash-commands)
- [Tools](#tools)
  - [Shell Execution](#shell-execution)
  - [Web Reading](#web-reading)
  - [File Editing](#file-editing)
  - [Memory (Persistent)](#memory-persistent)
  - [Scratch Notes (Session)](#scratch-notes-session)
  - [Date and Time](#date-and-time)
  - [Time Range Calculations](#time-range-calculations)
  - [Sub-Agents](#sub-agents)
  - [Tasks](#tasks)
  - [Routines](#routines)
  - [Specialists](#specialists)
  - [Specialist Suggestions](#specialist-suggestions)
  - [Critic Mode](#critic-mode)
- [Cron Jobs (Scheduled Tasks)](#cron-jobs-scheduled-tasks)
  - [Creating Jobs](#creating-jobs)
  - [Managing Jobs](#managing-jobs)
  - [Execution Logs](#execution-logs)
  - [Notifications](#notifications)
- [MCP Servers (External Tools)](#mcp-servers-external-tools)
  - [Stdio Servers](#stdio-servers)
  - [URL-Based Servers (SSE/HTTP)](#url-based-servers-ssehttp)
  - [Managing MCP Servers](#managing-mcp-servers)
- [Context Management](#context-management)
  - [Automatic Compression](#automatic-compression)
  - [RAG Memory](#rag-memory)
  - [Conversation Resume](#conversation-resume)
- [File Structure](#file-structure)
- [Development](#development)
  - [Building](#building)
  - [Testing](#testing)
  - [Debug Logging](#debug-logging)
  - [Adding a New Provider](#adding-a-new-provider)
  - [Adding a New Tool](#adding-a-new-tool)
- [Contributing](#contributing)
- [Bug Reports](#bug-reports)
- [Third-Party Licenses](#third-party-licenses)
- [License](#license)

---

## Installation

```bash
npm install -g bernard-agent
```

This installs `bernard` as a global command available from any directory.

### From Source

```bash
git clone https://github.com/phillt/bernard.git && cd bernard
npm install
npm run build
npm link
```

## Quick Start

```bash
# Store an API key
bernard add-key anthropic sk-ant-...

# Start the REPL
bernard

# Or use a specific provider
bernard -p openai -m gpt-4o
```

Once inside the REPL, just type naturally:

```
bernard> what's in this directory?
  ▶ shell: ls -la
  ...

bernard> show me the git log for the last week
  ▶ shell: git log --since="1 week ago" --oneline
  ...

bernard> remember that this project uses pnpm, not npm
  ▶ memory: write "project-conventions" ...
  Got it — I'll remember that for future sessions.
```

---

## Configuration

### API Keys

The recommended way to store API keys is with the `add-key` command:

```bash
bernard add-key anthropic sk-ant-api03-...
bernard add-key openai sk-...
bernard add-key xai xai-...
```

Keys are stored in `~/.bernard/keys.json` with restricted file permissions (mode 0600). You can also set keys via environment variables if you prefer.

Check which providers have keys configured:

```bash
bernard providers
```

### Environment Variables

Bernard loads `.env` from the current directory first, then falls back to `~/.bernard/.env`.

| Variable                          | Description                                              | Default                   |
| --------------------------------- | -------------------------------------------------------- | ------------------------- |
| `BERNARD_PROVIDER`                | LLM provider (`anthropic`, `openai`, `xai`)              | `anthropic`               |
| `BERNARD_MODEL`                   | Model name                                               | Provider-specific default |
| `BERNARD_MAX_TOKENS`              | Max response tokens                                      | `4096`                    |
| `BERNARD_SHELL_TIMEOUT`           | Shell command timeout (ms)                               | `30000`                   |
| `BERNARD_TOKEN_WINDOW`            | Context window size for compression (0 = auto-detect)    | `0`                       |
| `BERNARD_RAG_ENABLED`             | Enable the RAG memory system                             | `true`                    |
| `BERNARD_CRITIC_MODE`             | Enable critic mode for response verification             | `false`                   |
| `BERNARD_AUTO_CREATE_SPECIALISTS` | Auto-create specialists above confidence threshold       | `false`                   |
| `BERNARD_AUTO_CREATE_THRESHOLD`   | Confidence threshold for auto-creating specialists (0-1) | `0.8`                     |
| `BERNARD_DEBUG`                   | Enable debug logging                                     | unset                     |
| `ANTHROPIC_API_KEY`               | Anthropic API key                                        | —                         |
| `OPENAI_API_KEY`                  | OpenAI API key                                           | —                         |
| `XAI_API_KEY`                     | xAI API key                                              | —                         |

### Providers and Models

| Provider    | Default Model                | Available Models                                                                                              |
| ----------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `anthropic` | `claude-sonnet-4-5-20250929` | `claude-sonnet-4-5-20250929`, `claude-opus-4-20250514`, `claude-sonnet-4-20250514`, `claude-3-5-haiku-latest` |
| `openai`    | `gpt-4o`                     | `gpt-4o`, `gpt-4o-mini`, `o3`, `o3-mini`, `o4-mini`, `gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano`                |
| `xai`       | `grok-3`                     | `grok-3`, `grok-3-fast`, `grok-3-mini`, `grok-3-mini-fast`                                                    |

You can switch providers and models at any time during a session with `/provider` and `/model`.

### Runtime Options

Options can be changed during a session with `/options` or persisted to `~/.bernard/preferences.json`:

| Option          | Default | Description                                           |
| --------------- | ------- | ----------------------------------------------------- |
| `max-tokens`    | `4096`  | Maximum tokens per AI response                        |
| `shell-timeout` | `30000` | Shell command timeout in milliseconds                 |
| `token-window`  | `0`     | Context window size for compression (0 = auto-detect) |

From the CLI:

```bash
bernard list-options       # Show current option values
bernard reset-option max-tokens   # Reset a single option
bernard reset-options      # Reset all options to defaults
```

---

## Usage

### CLI Flags

```bash
bernard                          # Start with defaults
bernard -p openai -m gpt-4o     # Specify provider and model
bernard -r                       # Resume previous conversation
bernard --alert <id>             # Open with cron alert context
```

| Flag                    | Description                           |
| ----------------------- | ------------------------------------- |
| `-p, --provider <name>` | LLM provider (anthropic, openai, xai) |
| `-m, --model <name>`    | Model name                            |
| `-r, --resume`          | Resume the previous conversation      |
| `--alert <id>`          | Load context from a cron alert        |

### CLI Management Commands

```bash
bernard add-key <provider> <key>   # Store an API key securely
bernard remove-key <provider>      # Remove a stored API key
bernard providers                  # List providers and key status
bernard list-options               # Show configurable options
bernard reset-option <option>      # Reset one option to default
bernard reset-options              # Reset all options (with confirmation)
bernard mcp-list                   # List configured MCP servers
bernard remove-mcp <key>           # Remove an MCP server

# Cron management
bernard cron-list                  # List all cron jobs with status
bernard cron-run <id>              # Manually run a cron job immediately
bernard cron-delete <ids...>       # Delete specific cron jobs by ID
bernard cron-delete-all            # Delete all cron jobs
bernard cron-stop [ids...]         # Stop the daemon (no args) or disable specific jobs
bernard cron-bounce [ids...]       # Restart the daemon (no args) or bounce specific jobs
```

### Interactive REPL

Once running, Bernard presents an interactive prompt where you type natural language requests. Bernard has access to a suite of tools it can call autonomously — shell commands, memory, web fetching, and more.

Features:

- **Multi-line paste support** — paste code blocks directly; Bernard detects bracket paste mode
- **Live command hints** — type `/` and matching slash commands appear as suggestions
- **Abort in progress** — press Escape to cancel an in-flight request
- **Ctrl+C** — graceful exit with cleanup

### REPL Slash Commands

| Command           | Description                                                               |
| ----------------- | ------------------------------------------------------------------------- |
| `/help`           | Show available commands                                                   |
| `/clear`          | Clear conversation history and scratch notes                              |
| `/compact`        | Compress conversation history in-place                                    |
| `/task`           | Run an isolated task (no history, structured output)                      |
| `/memory`         | List all persistent memories                                              |
| `/scratch`        | List session scratch notes                                                |
| `/mcp`            | List connected MCP servers and their tools                                |
| `/cron`           | Show cron jobs and daemon status                                          |
| `/rag`            | Show RAG memory stats and recent facts                                    |
| `/provider`       | Switch LLM provider interactively                                         |
| `/model`          | Switch model for the current provider                                     |
| `/theme`          | Switch color theme                                                        |
| `/routines`       | List saved routines                                                       |
| `/create-routine` | Create a routine with guided AI assistance                                |
| `/create-task`    | Create a task routine (`task-` prefixed) with guided AI assistance        |
| `/specialists`    | List saved specialists                                                    |
| `/candidates`     | Review auto-detected specialist suggestions _(v0.6.0+)_                   |
| `/critic`         | Toggle critic mode for response verification (on/off)                     |
| `/agent-options`  | Configure auto-creation for specialist agents                             |
| `/options`        | View and modify runtime options (max-tokens, shell-timeout, token-window) |
| `/debug`          | Print a diagnostic report for troubleshooting (no secrets leaked)         |
| `/exit`           | Quit Bernard (also: `exit`, `quit`)                                       |

Type `/{routine-id}` or `/{specialist-id}` to invoke a saved routine or specialist directly (e.g., `/deploy-staging`).

Prefix with `\` to send a `/`-prefixed message as text instead of a command (e.g., `\/etc/hosts` sends the literal string).

---

## Tools

Bernard has access to the following tools, which it calls automatically based on your requests.

### Shell Execution

Execute any terminal command in the current working directory.

```
bernard> what git branch am I on?
  ▶ shell: git branch --show-current
  main

You're on the main branch.
```

**Dangerous command protection:** Bernard detects risky patterns (`rm -rf`, `sudo`, `mkfs`, `dd`, `chmod 777`, `reboot`, `kill -9`, etc.) and asks for your confirmation before executing.

**Timeout:** Commands time out after 30 seconds by default (configurable via `shell-timeout` option).

**Output limit:** Command output is capped at 10MB.

### Web Reading

Fetch any web page and convert it to markdown for analysis.

```
bernard> read https://docs.example.com/api and summarize it
  ▶ web_read: https://docs.example.com/api
  ...

Here's a summary of the API docs: ...
```

Supports an optional CSS selector to target specific content (e.g., `article`, `main`, `.post-body`). Strips scripts, styles, navigation, footers, and other non-content elements.

### File Editing

Read and edit files with precision using `file_read_lines` and `file_edit_lines` — no need to shell out to `sed` or `awk`.

```
bernard> show me lines 10-20 of src/config.ts
  ▶ file_read_lines: src/config.ts (lines 10–20)
  ...

bernard> replace line 15 with "const timeout = 5000;"
  ▶ file_edit_lines: src/config.ts [replace line 15]
  Done — 1 edit applied.
```

`file_edit_lines` supports replace, insert, delete, and append operations. All edits in a single call are atomic — they all succeed or all fail. Binary files are detected and rejected. Files up to 50 MB are supported, with pagination for large reads.

### Memory (Persistent)

Long-term memory that persists across sessions. Stored as markdown files in `~/.bernard/memory/`.

```
bernard> remember that the staging server is at 10.0.1.50
  ▶ memory: write "staging-server" ...

bernard> what's the staging server IP?
  (reads from memory automatically via system prompt)
  The staging server is at 10.0.1.50.
```

Actions: `list`, `read`, `write`, `delete`. All persistent memories are automatically injected into Bernard's system prompt each turn, so they're always available without needing to be explicitly recalled.

### Scratch Notes (Session)

Temporary working notes that survive context compression but are discarded when the session ends. Useful for tracking multi-step task progress.

```
bernard> I need to migrate 5 database tables — track progress in scratch
  ▶ scratch: write "migration-progress" ...
```

Actions: `list`, `read`, `write`, `delete`. Scratch notes are also injected into the system prompt, so Bernard always knows the current session state.

### Date and Time

Returns the current date, time, and timezone. Bernard calls this automatically when needed.

### Time Range Calculations

Calculate durations between military times and total durations across multiple time ranges. Handles overnight wrapping (e.g., 2300 to 0100 = 2 hours).

```
bernard> how long is a shift from 0800 to 1730?
  ▶ time_range: 800 → 1730
  9 hours 30 minutes
```

### Sub-Agents

Bernard can delegate independent tasks to parallel sub-agents, each with their own tool set. Sub-agents run concurrently and report back when done.

```
bernard> check the disk usage on /, look up the weather in Austin, and count lines of code in this project
  ▶ agent: "Check disk usage on /"
  ▶ agent: "Look up weather in Austin"
  ▶ agent: "Count lines of code"
  [sub:1] ▶ shell: df -h /
  [sub:2] ▶ web_read: ...
  [sub:3] ▶ shell: find . -name "*.ts" | xargs wc -l
  ...
```

Up to 4 concurrent sub-agents. Each gets 10 max steps. Color-coded output in the terminal. Sub-agents accept per-invocation provider/model overrides to use a different LLM than the main session.

### Tasks _(v0.6.0+)_

Tasks are isolated, focused executions that return structured JSON output. Unlike sub-agents (which return free-form text), tasks always produce a `{status, output, details?}` response — making them ideal for machine-readable results, routine chaining, and conditional branching.

```
bernard> /task List all TypeScript files in the src directory
┌─ task — List all TypeScript files in the src directory
  ▶ shell: find src -name "*.ts" -type f
└─ task success: Found 23 .ts files

Found 23 .ts files
```

Key differences from sub-agents:

- **Single-step budget** (`maxSteps: 2` — one tool-use round + structured result) — tasks are meant to be quick and deterministic
- **Structured JSON output** — always returns `{status: "success"|"error", output: string, details?: string}`
- **Saved tasks** — create task routines with `/create-task`, then invoke them by ID via `/task-{id}` or programmatically with the `taskId` parameter
- **Auto-context injection** — working directory, available tools, memory, and RAG context are included automatically
- **No conversation history** — completely isolated from the current session
- **Available as both a tool and a command** — the agent can call `task` during routines for chaining, or users can run `/task` directly from the REPL
- **Shared concurrency pool** — tasks and sub-agents share the same 4-slot limit

### Routines _(v0.5.0+)_

Named, persistent multi-step workflows that you can teach Bernard and later invoke with a slash command. Routines capture procedures — deploy scripts, release checklists, onboarding flows — as free-form markdown.

```
bernard> save a routine called "deploy-staging" that runs our build, pushes the docker image, and updates the k8s deployment
  ▶ routine: create { id: "deploy-staging", name: "Deploy to Staging", ... }

Routine "Deploy to Staging" (/deploy-staging) created.
```

Invoke a routine by typing `/{routine-id}`:

```
bernard> /deploy-staging
  (Bernard follows the saved procedure with full tool access)

bernard> /deploy-staging to production
  (Bernard follows the routine with "to production" as additional context)
```

Manage routines:

```
bernard> list my routines
  ▶ routine: list

bernard> show the deploy-staging routine
  ▶ routine: read { id: "deploy-staging" }

bernard> update the deploy-staging routine to add a rollback step
  ▶ routine: update { id: "deploy-staging", content: "..." }

bernard> delete the deploy-staging routine
  ▶ routine: delete { id: "deploy-staging" }
```

Use `/routines` in the REPL for a quick list. Routine names also appear in the live hint/autocomplete system when typing `/`.

Storage: one JSON file per routine in `~/.local/share/bernard/routines/`. Max 100 routines. IDs must be lowercase kebab-case (1–60 chars).

### Specialists _(v0.6.0+)_

Specialists are reusable expert profiles — persistent personas with custom system prompts and behavioral guidelines that shape how a sub-agent approaches work. Unlike routines (which define _what_ steps to follow), specialists define _how_ to work.

```
bernard> create a specialist called "code-reviewer" that reviews code for correctness, style, and security
  ▶ specialist: create { id: "code-reviewer", name: "Code Reviewer", ... }

Specialist "Code Reviewer" (code-reviewer) created.
```

Run a specialist by typing `/{specialist-id}` or using the `specialist_run` tool:

```
bernard> /code-reviewer review the changes in src/agent.ts
┌─ spec:1 [Code Reviewer] — review the changes in src/agent.ts
  ▶ shell: git diff src/agent.ts
└─ spec:1 done
```

Each specialist run gets its own `generateText` loop with a 10-step budget, using the specialist's system prompt and guidelines as its persona. Specialists can have per-specialist model overrides — set a default provider/model at creation time, and it will be used every time that specialist runs. Specialists share the concurrency pool with sub-agents and tasks (4 slots max).

Manage specialists:

```
bernard> list my specialists
  ▶ specialist: list

bernard> show the code-reviewer specialist
  ▶ specialist: read { id: "code-reviewer" }

bernard> update the code-reviewer specialist to also check for accessibility
  ▶ specialist: update { id: "code-reviewer", guidelines: [...] }

bernard> delete the code-reviewer specialist
  ▶ specialist: delete { id: "code-reviewer" }
```

Use `/specialists` in the REPL for a quick list. Specialist names also appear in the live hint/autocomplete system when typing `/`.

Storage: one JSON file per specialist in `~/.local/share/bernard/specialists/`. Max 50 specialists. IDs must be lowercase kebab-case (1–60 chars).

### Specialist Suggestions _(v0.6.0+)_

Bernard automatically detects recurring delegation patterns in your conversations and suggests new specialists. Detection runs in the background when you exit a session or use `/clear --save`.

When candidates are detected, you'll see a notification at the start of your next session:

```
  2 specialist suggestion(s) pending. Use /candidates to review.
```

Use `/candidates` to see pending suggestions with their name, description, confidence score, and reasoning. You can then accept or reject candidates conversationally (e.g., "accept the code-review candidate"), and Bernard will create the specialist for you.

**Overlap detection** — Before suggesting a new specialist, Bernard computes a token-based similarity score against all existing specialists and pending candidates. If the overlap exceeds 60%, the candidate is suppressed. When a candidate partially overlaps with an existing specialist, Bernard may suggest enhancing the existing specialist instead.

**Auto-creation** — You can enable automatic specialist creation for high-confidence candidates:

```bash
/agent-options auto-create on       # Enable auto-creation
/agent-options auto-create off      # Disable auto-creation
/agent-options threshold 0.85       # Set confidence threshold (0-1)
/agent-options                      # Show current settings
```

Or via environment variables: `BERNARD_AUTO_CREATE_SPECIALISTS=true` and `BERNARD_AUTO_CREATE_THRESHOLD=0.85`.

Candidates are auto-dismissed after 30 days if not reviewed. Up to 10 pending candidates are stored at a time.

Storage: one JSON file per candidate in `~/.local/share/bernard/specialist-candidates/`.

### Critic Mode _(v0.6.0+)_

Critic mode adds planning, proactive scratch/memory usage, and post-response verification. Toggle it during a session:

```bash
/critic on    # Enable critic mode
/critic off   # Disable critic mode
/critic       # Show current status
```

When enabled:

- **Planning** — Bernard writes a plan to scratch before multi-step tasks
- **Proactive scratch** — Accumulates findings in scratch during complex work
- **Verification** — After tool-using responses, a critic agent reviews the work and prints a verdict (PASS/WARN/FAIL)

The critic checks that claimed actions match actual tool calls and flags any discrepancies. It adds one extra LLM call after tool-using responses. Simple knowledge answers are not verified.

**PAC System (Plan-Act-Critic)** — When critic mode is enabled, sub-agents and specialists also get critic verification via a reusable PAC loop. The PAC loop runs the critic after each sub-agent/specialist execution, and if the critic finds issues, it retries the task with feedback (up to 2 retries). This applies to:

- Sub-agents (`agent` tool)
- Specialist runs (`specialist_run` tool)
- Cron job executions (daemon mode)

Default: off. Recommended for high-stakes work (deployments, git operations, multi-file edits).

---

## Cron Jobs (Scheduled Tasks)

Bernard can create and manage scheduled background tasks that run on a cron schedule. Jobs are executed by a background daemon process with their own AI agent instance.

### Creating Jobs

Ask Bernard to set up a scheduled task:

```
bernard> every hour, check if the API at https://api.example.com/health returns 200 and notify me if it doesn't
  ▶ cron_create: { name: "api-health-check", schedule: "0 * * * *", prompt: "..." }

Created cron job "api-health-check" (runs hourly).
```

Or be explicit about the schedule:

```
bernard> create a cron job called "disk-check" that runs every 5 minutes and alerts me if disk usage exceeds 90%
  ▶ cron_create: { name: "disk-check", schedule: "*/5 * * * *", prompt: "..." }
```

### Managing Jobs

```
bernard> list my cron jobs
  ▶ cron_list

bernard> disable the disk-check job
  ▶ cron_disable: { id: "abc123" }

bernard> update the api health check to run every 30 minutes instead
  ▶ cron_update: { id: "def456", schedule: "*/30 * * * *" }

bernard> run the api health check right now
  ▶ cron_run: { id: "def456" }

bernard> delete the disk-check job
  ▶ cron_delete: { id: "abc123" }

bernard> what's the cron daemon status?
  ▶ cron_status
```

You can also run jobs manually from the CLI without entering the REPL:

```bash
bernard cron-run <id>
```

Use `/cron` in the REPL for a quick status overview.

Available cron tools: `cron_create`, `cron_list`, `cron_run`, `cron_get`, `cron_update`, `cron_delete`, `cron_enable`, `cron_disable`, `cron_status`, `cron_bounce`, `cron_logs_list`, `cron_logs_get`, `cron_logs_summary`, `cron_logs_cleanup`.

### Execution Logs

Every cron job run is logged with full execution traces:

```
bernard> show me the last 5 runs of the api health check
  ▶ cron_logs_list: { job_id: "def456", limit: 5 }

bernard> show me the full trace of that failed run
  ▶ cron_logs_get: { job_id: "def456", run_id: "run789" }

bernard> give me a summary of the api health check job performance
  ▶ cron_logs_summary: { job_id: "def456" }
```

Logs include: step-by-step traces, tool calls and results, token usage, durations, success/error status.

Log management: `cron_logs_cleanup` supports `rotate` (keep N recent entries) and `delete` (remove all logs for a job).

Cron jobs can self-disable when they determine their one-time task is complete, using `cron_self_disable` available in the runner context.

### Notifications

Cron jobs can send desktop notifications when they need your attention. The daemon uses `node-notifier` for cross-platform notification support. When you receive an alert, start Bernard with `--alert <id>` to load the alert context.

---

## MCP Servers (External Tools)

Bernard supports the [Model Context Protocol (MCP)](https://modelcontextprotocol.io) for connecting to external tool servers. MCP servers provide additional tools that Bernard can use alongside its built-in tools.

Configuration is stored in `~/.bernard/mcp.json`.

### Stdio Servers

Stdio-based MCP servers run as child processes:

```
bernard> add an MCP server for filesystem access using npx @modelcontextprotocol/server-filesystem with /home/user as the root
  ▶ mcp_config: add { key: "filesystem", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"] }
```

Resulting config:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
    }
  }
}
```

### URL-Based Servers (SSE/HTTP)

URL-based MCP servers connect over SSE or HTTP transport:

```
bernard> add this MCP server: http://localhost:6288/web/sse
  ▶ mcp_add_url: { key: "my-mcp", url: "http://localhost:6288/web/sse" }
```

Resulting config:

```json
{
  "mcpServers": {
    "my-mcp": {
      "url": "http://localhost:6288/web/sse"
    }
  }
}
```

URL servers support optional fields:

- `type` — `"sse"` (default) or `"http"` for Streamable HTTP transport
- `headers` — for authentication tokens or custom headers

Example with all fields:

```json
{
  "mcpServers": {
    "authenticated-server": {
      "url": "https://example.com/mcp",
      "type": "http",
      "headers": { "Authorization": "Bearer token123" }
    }
  }
}
```

### Managing MCP Servers

```
bernard> list my MCP servers
  ▶ mcp_config: list

bernard> show details for the filesystem server
  ▶ mcp_config: get { key: "filesystem" }

bernard> remove the filesystem server
  ▶ mcp_config: remove { key: "filesystem" }
```

From the CLI:

```bash
bernard mcp-list          # List all configured servers
bernard remove-mcp <key>  # Remove a server
```

Use `/mcp` in the REPL to see connected servers and their available tools.

Bernard automatically attempts to reconnect and retry if an MCP server tool call fails due to a connection issue, so transient network interruptions are handled without manual intervention.

**Note:** MCP server changes take effect after restarting Bernard. Servers are connected at startup.

---

## Context Management

### Automatic Compression

Bernard automatically compresses conversation history when it approaches 75% of the model's context window. During compression:

1. Recent messages (last 4 turns) are preserved in full
2. Older messages are summarized by the LLM into a concise recap
3. Key facts are extracted per domain (tool usage, user preferences, general knowledge) and stored in the RAG memory system
4. The conversation continues seamlessly with the compressed context

Summarization and domain-specific fact extraction run in parallel. Scratch notes survive compression, so multi-step task progress is never lost.

**Auto-continue on truncation:** If a response hits the `max-tokens` limit and is cut off, Bernard automatically continues where it left off (up to 3 continuations). After completing, it shows a recommended `max-tokens` value based on actual usage. If the response is still incomplete after 3 continuations, a warning is shown with instructions to increase the limit via `/options max-tokens <value>`.

When critic mode is enabled (`/critic on`), Bernard writes plans to scratch before complex tasks and verifies outcomes after tool use. See [Critic Mode](#critic-mode).

### RAG Memory

Bernard has a Retrieval-Augmented Generation (RAG) system that provides long-term memory beyond the current session:

- **Domain-specific extraction** — facts are extracted into four specialized domains, each with its own LLM prompt:
  - **Tool Usage Patterns** — command sequences, error resolutions, build/deploy workflows
  - **User Preferences** — communication style, workflow conventions, repeated instructions
  - **General Knowledge** — project structure, architecture decisions, environment info
  - **Conversation Summaries** — what was discussed, approaches taken, tools/specialists/routines used, outcomes
- **Parallel extraction** — all four domain extractors run concurrently via `Promise.allSettled`, so wall-clock latency is roughly the same as a single extraction
- **Per-domain retrieval** — search returns up to 5 results per domain (15 total max), preventing any single domain from crowding out others
- **Domain-grouped context** — recalled facts are organized by domain with headings in the system prompt, giving the LLM clear signal about what kind of knowledge each fact represents
- **Semantic search** — on each new user message, relevant facts are retrieved and injected into the system prompt as "Recalled Context"
- **Local embeddings** — uses FastEmbed (`AllMiniLML6V2`, 384 dimensions) for fully local embedding computation
- **Deduplication** — facts too similar to existing ones (>92% cosine similarity) are skipped
- **Pruning** — older, less-accessed facts decay over time (90-day half-life); the store caps at 5000 facts
- **Backward compatible** — existing memories without a domain are automatically assigned to "general" on load

Use `/rag` in the REPL to see RAG stats, per-domain breakdown, and recent facts.

Storage: `~/.bernard/rag/memories.json`

To disable RAG: set `BERNARD_RAG_ENABLED=false`.

### Conversation Resume

Bernard saves your conversation history when you exit. Resume where you left off:

```bash
bernard -r
# or
bernard --resume
```

The previous conversation is replayed in the terminal (truncated for readability) and the full context is restored.

Storage: `~/.bernard/conversation-history.json`

---

## File Structure

Bernard stores all data in `~/.bernard/`:

```
~/.bernard/
├── keys.json                    # API keys (mode 0600)
├── preferences.json             # Provider, model, options
├── .env                         # Fallback environment config
├── mcp.json                     # MCP server configuration
├── conversation-history.json    # Last session (for --resume)
├── memory/                      # Persistent memories (*.md)
├── models/                      # Embedding model cache (fastembed)
├── routines/                    # Saved routines (*.json)
├── specialists/                 # Saved specialist profiles (*.json)
├── specialist-candidates/       # Auto-detected specialist suggestions (*.json)
├── rag/
│   └── memories.json            # RAG fact embeddings
└── cron/
    ├── jobs.json                # Scheduled jobs
    ├── daemon.pid               # Daemon process ID
    ├── daemon.log               # Daemon output (rotates at 1MB)
    ├── logs/                    # Per-job execution logs
    └── alerts/                  # Cron alert files
```

---

## Development

### Building

```bash
npm run build    # Compile TypeScript to dist/
npm run dev      # Run via tsx with debug logging (no build needed)
npm start        # Run compiled output
```

### Testing

```bash
npm test             # Run all tests once
npm run test:watch   # Run tests in watch mode
```

Uses [Vitest](https://vitest.dev) as the test runner.

### Debug Logging

Set `BERNARD_DEBUG=1` to enable verbose logging:

```bash
BERNARD_DEBUG=1 bernard
```

Logs are written to `.logs/YYYY-MM-DD.log` in JSON format, covering agent processing, RAG operations, context compression, tool execution, and MCP operations.

### Diagnostic Report

Use `/debug` in the REPL to print a diagnostic report useful for troubleshooting. The report includes runtime info (Bernard version, Node.js version, OS), LLM configuration, API key status (configured/not set — keys are never shown), MCP server status, RAG/memory/cron state, conversation stats, active settings, and file paths. No secrets are included in the output.

### Adding a New Provider

1. Install the AI SDK provider package (e.g., `npm install @ai-sdk/google`)
2. Add a case to `getModel()` in `src/providers/index.ts`
3. Add the API key variable to `src/config.ts`

### Adding a New Tool

1. Create `src/tools/newtool.ts` using the `tool()` helper from `ai` with a Zod schema for parameters
2. Register it in `src/tools/index.ts`

### Project Structure

```
src/
├── index.ts              # CLI entry point (Commander)
├── repl.ts               # Interactive REPL loop
├── agent.ts              # Agent class (generateText loop)
├── config.ts             # Config loading and validation
├── output.ts             # Terminal formatting (Chalk)
├── theme.ts              # Color theme definitions and switching
├── memory.ts             # MemoryStore (persistent + scratch)
├── context.ts            # Context compression + domain fact extraction
├── domains.ts            # Memory domain registry + extraction prompts
├── rag.ts                # RAG store (domain-tagged embeddings + per-domain search)
├── embeddings.ts         # FastEmbed wrapper
├── routines.ts           # RoutineStore (named multi-step workflows)
├── specialists.ts        # SpecialistStore (reusable expert profiles)
├── specialist-candidates.ts  # CandidateStore (auto-detected suggestions)
├── specialist-detector.ts    # LLM-based specialist pattern detection
├── mcp.ts                # MCP server manager
├── rag-worker.ts         # Background RAG fact extraction + candidate detection
├── setup.ts              # First-time setup wizard
├── history.ts            # Conversation save/load
├── logger.ts             # Debug file logger
├── providers/
│   ├── index.ts          # getModel() factory
│   └── types.ts          # Provider type definitions
├── tools/
│   ├── index.ts          # Tool registry
│   ├── types.ts          # Tool option type definitions
│   ├── shell.ts          # Shell execution
│   ├── memory.ts         # Memory + scratch tools
│   ├── web.ts            # Web page fetching
│   ├── datetime.ts       # Date/time
│   ├── time.ts           # Time range calculations
│   ├── cron.ts           # Cron job management
│   ├── cron-logs.ts      # Cron execution logs
│   ├── mcp.ts            # MCP config (stdio)
│   ├── mcp-url.ts        # MCP config (URL-based)
│   ├── file.ts           # File reading and line-based editing
│   ├── routine.ts        # Routine management tool
│   ├── specialist.ts     # Specialist management tool
│   ├── specialist-run.ts # Specialist execution (sub-agent with custom persona)
│   ├── subagent.ts       # Parallel sub-agents
│   ├── task.ts           # Isolated task execution (structured JSON output)
│   └── agent-pool.ts     # Shared concurrency pool for agents, tasks, and specialists
└── cron/
    ├── cli.ts            # Cron CLI subcommands
    ├── types.ts          # Cron type definitions
    ├── store.ts          # Job + alert persistence
    ├── daemon.ts         # Background daemon process
    ├── runner.ts         # Job execution
    ├── scheduler.ts      # Cron scheduling
    ├── client.ts         # Daemon lifecycle
    ├── log-store.ts      # Execution log storage
    └── notify.ts         # Desktop notifications
```

## Contributing

Contributions are welcome! Here's the general workflow:

1. Fork the repository and create a feature branch from `master`
2. Install dependencies: `npm install`
3. Make your changes
4. Run the build and tests: `npm run build && npm test`
5. Open a pull request against `master`

Looking for something to work on? Check the [open issues](https://github.com/phillt/bernard/issues) for bugs and feature requests.

## Bug Reports

Found a bug? Please [open an issue](https://github.com/phillt/bernard/issues/new?template=bug_report.yml) with:

- Steps to reproduce the problem
- Expected vs. actual behavior
- Your environment — run `/debug` in the REPL and paste the output
- Any relevant logs (run with `BERNARD_DEBUG=1` for verbose output)

## Third-Party Licenses

Bernard uses the [all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) sentence-transformer model (via [fastembed](https://github.com/Anush008/fastembed-js)) for local RAG embeddings. This model is licensed under the Apache License 2.0. See [`THIRD-PARTY-NOTICES`](./THIRD-PARTY-NOTICES) for full license text and attribution.

## License

MIT
