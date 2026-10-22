<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

# src/prompt-rewriter.ts

- **src/prompt-rewriter.ts** — Pre-turn LLM pass that rewrites the user's message for the active model family (see `ModelProfile.rewriterHint` in `src/providers/profiles.ts`). Runs after reference-resolution so resolved entities can be inlined. Temperature 0, fail-open to the original prompt, gated by `config.promptRewriter` (default on; toggle via `/agent-options` or `BERNARD_PROMPT_REWRITER=false`).
