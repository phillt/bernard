<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

# src/index.ts

- **src/index.ts** — CLI entry point (Commander, shebang). Constructs the agent + stores + MCP manager, mounts `<App>` from `src/ui/App.tsx` via `ink`'s `render`, and awaits `waitUntilExit` before running cleanup (history save, MCP close, optional correction-agent pass).
