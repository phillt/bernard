<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

# src/output.ts

- **src/output.ts** — Pure helpers that survived the Phase D cutover: `formatTokenCount`, `buildSpinnerMessage`, `setToolDetailsVisible` / `isToolDetailsVisible`, and the welcome / help / dim text printers used by the non-Ink CLI commands (`bernard providers`, etc.). The legacy `print*` functions for tool calls / sub-agent labels are now no-ops inside the REPL — Ink components render those events directly.
