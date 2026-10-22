<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

# src/framework/agents/pac-planner.ts

- **src/framework/agents/pac-planner.ts**, **pac-actor.ts**, **pac-critic.ts** — Three `AgentDefinition`s that compose the sub-agent **PAC pipeline** (Planner → Actor → Critic). Each phase is ephemeral with its own system prompt, strictly-scoped tool set, and step budget (planner 20%, actor 60%, critic 20% of `ceil(maxSteps * SUBAGENT_STEP_RATIO)`). Planner outputs a numbered plan + success criteria; Actor executes against the plan; Critic verifies with read-only tools and emits a `{verdict, reason}` JSON. Phases do not share LLM history — outputs flow forward as plain strings.
