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
- **src/providers/** — `getModel()` factory returning AI SDK `LanguageModel`
- **src/tools/** — Tool registry; each tool is a separate file using `tool()` from `ai`

## Key Patterns

- **Vercel AI SDK** (`ai` package) provides unified tool calling across Anthropic/OpenAI/xAI
- Adding a provider: one import + one case in `src/providers/index.ts`
- Adding a tool: create `src/tools/newtool.ts`, register in `src/tools/index.ts`
- Config loads `.env` from cwd first, then `~/.bernard/.env`
- CommonJS (no `"type": "module"` in package.json) for chalk v4 compatibility
- TypeScript with `module: "Node16"` and `.js` extensions in imports

## Environment Variables

- `BERNARD_PROVIDER` — anthropic | openai | xai (default: anthropic)
- `BERNARD_MODEL` — Model name (default: provider-specific)
- `BERNARD_MAX_TOKENS` — Response token limit (default: 4096)
- `BERNARD_SHELL_TIMEOUT` — Shell command timeout ms (default: 30000)
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `XAI_API_KEY` — Provider API keys
