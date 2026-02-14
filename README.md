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
  - [Memory (Persistent)](#memory-persistent)
  - [Scratch Notes (Session)](#scratch-notes-session)
  - [Date and Time](#date-and-time)
  - [Time Range Calculations](#time-range-calculations)
  - [Sub-Agents](#sub-agents)
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

| Variable | Description | Default |
|----------|-------------|---------|
| `BERNARD_PROVIDER` | LLM provider (`anthropic`, `openai`, `xai`) | `anthropic` |
| `BERNARD_MODEL` | Model name | Provider-specific default |
| `BERNARD_MAX_TOKENS` | Max response tokens | `4096` |
| `BERNARD_SHELL_TIMEOUT` | Shell command timeout (ms) | `30000` |
| `BERNARD_RAG_ENABLED` | Enable the RAG memory system | `true` |
| `BERNARD_DEBUG` | Enable debug logging | unset |
| `ANTHROPIC_API_KEY` | Anthropic API key | — |
| `OPENAI_API_KEY` | OpenAI API key | — |
| `XAI_API_KEY` | xAI API key | — |

### Providers and Models

| Provider | Default Model | Available Models |
|----------|--------------|------------------|
| `anthropic` | `claude-sonnet-4-5-20250929` | `claude-sonnet-4-5-20250929`, `claude-opus-4-20250514`, `claude-sonnet-4-20250514`, `claude-3-5-haiku-latest` |
| `openai` | `gpt-4o` | `gpt-4o`, `gpt-4o-mini`, `o3`, `o3-mini`, `o4-mini`, `gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano` |
| `xai` | `grok-3` | `grok-3`, `grok-3-fast`, `grok-3-mini`, `grok-3-mini-fast` |

You can switch providers and models at any time during a session with `/provider` and `/model`.

### Runtime Options

Options can be changed during a session with `/options` or persisted to `~/.bernard/preferences.json`:

| Option | Default | Description |
|--------|---------|-------------|
| `max-tokens` | `4096` | Maximum tokens per AI response |
| `shell-timeout` | `30000` | Shell command timeout in milliseconds |

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

| Flag | Description |
|------|-------------|
| `-p, --provider <name>` | LLM provider (anthropic, openai, xai) |
| `-m, --model <name>` | Model name |
| `-r, --resume` | Resume the previous conversation |
| `--alert <id>` | Load context from a cron alert |

### CLI Management Commands

```bash
bernard add-key <provider> <key>   # Store an API key securely
bernard providers                  # List providers and key status
bernard list-options               # Show configurable options
bernard reset-option <option>      # Reset one option to default
bernard reset-options              # Reset all options (with confirmation)
bernard mcp-list                   # List configured MCP servers
bernard remove-mcp <key>           # Remove an MCP server
```

### Interactive REPL

Once running, Bernard presents an interactive prompt where you type natural language requests. Bernard has access to a suite of tools it can call autonomously — shell commands, memory, web fetching, and more.

Features:
- **Multi-line paste support** — paste code blocks directly; Bernard detects bracket paste mode
- **Live command hints** — type `/` and matching slash commands appear as suggestions
- **Abort in progress** — press Escape to cancel an in-flight request
- **Ctrl+C** — graceful exit with cleanup

### REPL Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/clear` | Clear conversation history and scratch notes |
| `/memory` | List all persistent memories |
| `/scratch` | List session scratch notes |
| `/mcp` | List connected MCP servers and their tools |
| `/cron` | Show cron jobs and daemon status |
| `/rag` | Show RAG memory stats and recent facts |
| `/provider` | Switch LLM provider interactively |
| `/model` | Switch model for the current provider |
| `/options` | View and modify runtime options |
| `/exit` | Quit Bernard (also: `exit`, `quit`) |

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

Up to 4 concurrent sub-agents. Each gets 10 max steps. Color-coded output in the terminal.

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

bernard> delete the disk-check job
  ▶ cron_delete: { id: "abc123" }

bernard> what's the cron daemon status?
  ▶ cron_status
```

Use `/cron` in the REPL for a quick status overview.

Available cron tools: `cron_create`, `cron_list`, `cron_get`, `cron_update`, `cron_delete`, `cron_enable`, `cron_disable`, `cron_status`, `cron_bounce`.

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

**Note:** MCP server changes take effect after restarting Bernard. Servers are connected at startup.

---

## Context Management

### Automatic Compression

Bernard automatically compresses conversation history when it approaches 75% of the model's context window. During compression:

1. Recent messages (last 4 turns) are preserved in full
2. Older messages are summarized by the LLM into a concise recap
3. Key facts are extracted and stored in the RAG memory system
4. The conversation continues seamlessly with the compressed context

Scratch notes survive compression, so multi-step task progress is never lost.

### RAG Memory

Bernard has a Retrieval-Augmented Generation (RAG) system that provides long-term memory beyond the current session:

- **Automatic fact extraction** — when context is compressed, key facts are extracted and stored with embeddings
- **Semantic search** — on each new user message, relevant facts are retrieved and injected into the system prompt as "Recalled Context"
- **Local embeddings** — uses FastEmbed (`AllMiniLML6V2`, 384 dimensions) for fully local embedding computation
- **Deduplication** — facts too similar to existing ones (>92% cosine similarity) are skipped
- **Pruning** — older, less-accessed facts decay over time (90-day half-life); the store caps at 5000 facts

Use `/rag` in the REPL to see RAG stats and recent facts.

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
├── memory.ts             # MemoryStore (persistent + scratch)
├── context.ts            # Context compression
├── rag.ts                # RAG store (embeddings + search)
├── embeddings.ts         # FastEmbed wrapper
├── mcp.ts                # MCP server manager
├── history.ts            # Conversation save/load
├── logger.ts             # Debug file logger
├── providers/
│   └── index.ts          # getModel() factory
├── tools/
│   ├── index.ts          # Tool registry
│   ├── shell.ts          # Shell execution
│   ├── memory.ts         # Memory + scratch tools
│   ├── web.ts            # Web page fetching
│   ├── datetime.ts       # Date/time
│   ├── time.ts           # Time range calculations
│   ├── cron.ts           # Cron job management
│   ├── cron-logs.ts      # Cron execution logs
│   ├── mcp.ts            # MCP config (stdio)
│   ├── mcp-url.ts        # MCP config (URL-based)
│   └── subagent.ts       # Parallel sub-agents
└── cron/
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
- Your environment (OS, Node version, Bernard version, provider/model)
- Any relevant logs (run with `BERNARD_DEBUG=1` for verbose output)

## License

MIT
