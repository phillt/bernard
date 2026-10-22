<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

# src/reference-resolver.ts

- **src/reference-resolver.ts** — Pre-turn LLM pass that resolves user-named entities (e.g. "my daughter") against persistent memory; returns `resolved`, `ambiguous` (menu), `unknown` (prompts user), or `noop`. Invoked from `runPreTurnPipeline` in `src/ui/App.tsx` before `agent.processInput` and rendered as a `## Resolved References` block in the system prompt (agent-visible, user-hidden). The Ink port currently fails open on `ambiguous` / `unknown` rather than blocking the turn with a disambiguation menu.
