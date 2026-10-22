<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

# Wrapper-routing shim: on the main agent only, shell / web_read / file_read_lines / file_edit_lines are transparently routed through their bundled wrapper specialists. Same tool name and schema — only execute changes — so the model can't tell the difference, but the wrapper adds OS-aware examples, schema validation, and structured-output capping. See src/tools/wrap-with-specialist.ts.

- Wrapper-routing shim: on the main agent only, `shell` / `web_read` / `file_read_lines` / `file_edit_lines` are transparently routed through their bundled wrapper specialists. Same tool name and schema — only `execute` changes — so the model can't tell the difference, but the wrapper adds OS-aware examples, schema validation, and structured-output capping. See `src/tools/wrap-with-specialist.ts`.
