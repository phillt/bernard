<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

# src/tool-call-repair.ts

- **src/tool-call-repair.ts** — `makeRepairHook()`: one-shot `ToolCallRepairFunction` wired into every `generateText` site (main, specialist, subagent, tool-wrapper, cron). Re-prompts the model on `InvalidToolArgumentsError` / `NoSuchToolError`. Detects argument truncation (e.g. a 16 KB heredoc cut mid-string) and steers the retry toward `file_write` + `shell` instead of inlining payloads. Forwards the parent abort signal so user-cancel (Esc) also cancels the repair call.
