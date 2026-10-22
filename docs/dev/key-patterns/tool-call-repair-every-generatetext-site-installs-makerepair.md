<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

# Tool-call repair: every generateText site installs makeRepairHook(...) (see src/tool-call-repair.ts). On InvalidToolArgumentsError / NoSuchToolError a one-shot re-prompt asks the model to fix the arguments; truncation errors (huge inline strings cut mid-JSON) get a hint to use file_write + shell instead of inlining payloads.

- Tool-call repair: every `generateText` site installs `makeRepairHook(...)` (see `src/tool-call-repair.ts`). On `InvalidToolArgumentsError` / `NoSuchToolError` a one-shot re-prompt asks the model to fix the arguments; truncation errors (huge inline strings cut mid-JSON) get a hint to use `file_write` + `shell` instead of inlining payloads.
