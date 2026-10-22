<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

# src/ui/App.tsx

- **src/ui/App.tsx** — Top-level Ink component. Owns the REPL lifecycle: turn submission (`handleSubmit`), the pre-turn pipeline (reference resolver → prompt rewriter → inline-image detection), busy/spinner state, overlay queueing, `historyVersion` bumps, alert-banner dismissal, and Esc handling (Ctrl-C is Ink's — it quits the app before any `useInput` runs; see `overlays/overlay-contract.ts`). All slash commands dispatch here. Overlay-request closures are exposed to the tool layer via the module-level bridge in `src/ui/ink-handlers.ts` so pre-mount `ToolOptions` callbacks (`requestConfirm`, `requestBlock`, `requestAskUser`, `requestMenu`, `requestTextInput`) forward to the live React tree.
