<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

# src/framework/pac/run-pac.ts

- **src/framework/pac/run-pac.ts** — `runPAC()` orchestrator: invokes the three definitions in sequence. On Critic `fail` with retry budget remaining (`PAC_MAX_RETRIES = 1`), re-runs the Planner with the prior plan + critic feedback and then the Actor + Critic again. After retries exhausted, returns the Actor's last output with a `## Critic Verdict: FAIL` footer so the main agent can see verification failed.
