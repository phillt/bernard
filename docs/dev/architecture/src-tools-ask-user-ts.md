<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

# src/tools/ask-user.ts

- **src/tools/ask-user.ts** — `ask_user` tool: pauses the agent loop to ask the user one or more clarifying questions and waits for their answers. Accepts a `questions` array (1-10 entries), each with optional `choices` / `allow_other` / `other_label`. For batches of 2+ the REPL pins a tab strip above the menu. Returns `{answers: [...]}`, `{cancelled: true, answered: [...]}` on Esc, or `{unavailable: true}` when running headless. Exists so the agent stops writing clarifying questions as prose (which leaves the turn idle and, in coordinator mode, trips the plan-enforcement loop).
