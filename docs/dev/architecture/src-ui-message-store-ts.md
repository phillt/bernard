<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

# src/ui/message-store.ts

- **src/ui/message-store.ts** — In-memory event store backing the live transcript. Receives `StreamEvent`s (`text-delta`, `tool-call`, `tool-result`, `reasoning-delta`) from the framework output sink (`src/framework/hooks/output-sink.ts`) and exposes a `useSyncExternalStore`-compatible subscribe API to `<Thread>` and `<StreamingAssistantMessage>`. Reset per turn so a new turn's stream replaces the in-flight buffer.
