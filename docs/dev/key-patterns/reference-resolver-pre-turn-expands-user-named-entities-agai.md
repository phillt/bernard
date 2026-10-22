<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

# Reference resolver (pre-turn): expands user-named entities against memory via one generateText call; persists hints to rewriter-hints.md. Fails open (returns noop) on LLM error. See src/reference-resolver.ts and the runPreTurnPipeline call in src/ui/App.tsx.

- Reference resolver (pre-turn): expands user-named entities against memory via one `generateText` call; persists hints to `rewriter-hints.md`. Fails open (returns `noop`) on LLM error. See `src/reference-resolver.ts` and the `runPreTurnPipeline` call in `src/ui/App.tsx`.
