# Bernard

A local CLI AI agent that executes terminal commands via natural language. Supports multiple LLM providers (Anthropic, OpenAI, xAI) through the Vercel AI SDK.

## Installation

```bash
git clone <repo-url> && cd bernard
npm install
npm run build
npm link
```

This installs `bernard` as a global command.

## Configuration

Copy the example env file and add your API key(s):

```bash
cp .env.example .env
```

Bernard looks for `.env` in the current directory first, then falls back to `~/.bernard/.env` (useful for a global config).

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BERNARD_PROVIDER` | LLM provider (`anthropic`, `openai`, `xai`) | `anthropic` |
| `BERNARD_MODEL` | Model name | Provider default |
| `BERNARD_MAX_TOKENS` | Max response tokens | `4096` |
| `BERNARD_SHELL_TIMEOUT` | Shell command timeout (ms) | `30000` |
| `ANTHROPIC_API_KEY` | Anthropic API key | — |
| `OPENAI_API_KEY` | OpenAI API key | — |
| `XAI_API_KEY` | xAI API key | — |

### Default Models

| Provider | Default Model |
|----------|--------------|
| `anthropic` | `claude-sonnet-4-5-20250929` |
| `openai` | `gpt-4o` |
| `xai` | `grok-3` |

## Usage

```bash
# Start with defaults (Anthropic)
bernard

# Use a specific provider and model
bernard --provider openai --model gpt-4o
bernard -p xai -m grok-3
```

### REPL Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/clear` | Clear conversation history |
| `exit` / `quit` / `/exit` | Quit Bernard |

### Examples

```
bernard> what directory am I in?
  ▶ shell: pwd
  /home/user/projects

You're in /home/user/projects.

bernard> list all typescript files here
  ▶ shell: find . -name "*.ts" -not -path "./node_modules/*"
  ./src/index.ts
  ./src/config.ts

Found 2 TypeScript files in the current directory.

bernard> what's the git status?
  ▶ shell: git status
  On branch main
  nothing to commit, working tree clean

The repo is clean — no uncommitted changes.
```

### Dangerous Command Protection

Bernard detects potentially dangerous commands (`rm -rf`, `sudo`, etc.) and prompts for confirmation before executing them.

## Development

```bash
npm run dev      # Run via tsx (no build step)
npm run build    # Compile TypeScript to dist/
npm start        # Run compiled output
```

## Adding a New Provider

1. Install the AI SDK provider package (e.g. `npm install @ai-sdk/google`)
2. Add a case to `getModel()` in `src/providers/index.ts`
3. Add the API key to `src/config.ts`

## Adding a New Tool

1. Create `src/tools/newtool.ts` using the `tool()` helper from `ai` with a Zod schema
2. Register it in `src/tools/index.ts`

## License

MIT
