<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

# src/tools/wrap-with-specialist.ts

- **src/tools/wrap-with-specialist.ts** — Transparent shim that routes the main agent's direct `shell`, `web_read`, and `file_*_lines` calls through their wrapper specialists (same tool name/schema; only `execute` changes). On `status: 'ok'` returns the wrapper's `result` as-is; on `status: 'error'` maps to the _native_ tool's error shape so `detectToolError` and tool-profile learning still see the right format. Falls through to the raw tool when the specialist is missing or wrong kind. Only active on the main agent — sub-agents and wrappers themselves bypass it.
