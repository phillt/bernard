# Bernard — Local CLI AI Agent

Detailed design notes live in [`docs/dev/`](docs/dev/); this file points into them. **Read the linked notes before changing the code they describe**: most record a decision that looks wrong until you know why it was made. A code comment that says "see CLAUDE.md" means these notes; search `docs/dev/` for the topic.

## Quick Reference

```bash
npm run build        # Compile TypeScript → dist/
npm run dev          # Run via tsx (no build needed)
npm link             # Install "bernard" command globally
bernard              # Start the REPL
bernard -p openai -m gpt-4o  # Use specific provider/model

# Programmatic invocation (#419) — an app id, a named action, typed args.
# Never a free-form prompt; that shape is the security boundary.
bernard script --describe                       # list registered apps
bernard script --describe --app demo            # that app's action schemas
bernard script --app demo --action web_answer --args '{"question":"..."}'

# An action may also name a TOOL, which runs with no model at all (#445).
bernard script --app demo --action search --args '{"question":"..."}'

# Per-app permission rules (#420) — the user's producer, never an agent's.
bernard app-grant demo                    # show this app's rules
bernard app-grant demo --deny web_read    # applies to the next invocation
bernard app-grant demo --clear

# Applets have a write side now (#453). The `applet` tool authors them from
# the REPL; the CLI owns the authority half and deletion.
bernard app list                            # yours only — bundled examples are not mixed in
bernard app list --bundled                  # -b, only what Bernard ships
bernard app list --all                      # -a, both, grouped
bernard app allow demo greet --tools web_search   # toolAllowlist / toolMode / confirmMode
bernard app csp demo                              # what it may reach outside its own origin
bernard app csp demo --img-src https://cdn.example.com --sandbox links
bernard app csp demo --clear
bernard app logs demo --last 20                   # why a button failed, in Bernard's own words

# Ingested document libraries (#516/#517). The user's corpus, not Bernard's memory.
bernard knowledge list
bernard knowledge create mybooks --title "Reference shelf"
bernard knowledge add mybooks ./docs ./README.md    # file, directory or PDF
bernard knowledge search "how do we roll back" --library mybooks
bernard knowledge read mybooks ./docs/deploy.md --from 4 --to 8
bernard knowledge stats mybooks
bernard knowledge remove mybooks                    # or `… remove mybooks <uri>`

# Setup: provider, key and every setting, each opening on its current value (#447).
# Only what you change is saved, so anything inherited from a BERNARD_* var stays so.
bernard setup                                      # works with no API key at all
bernard setup --no-verify                          # skip the closing "can it call?" probe
# …and /setup in the REPL runs the identical flow.

# Facts, yours and each specialist's own (#501). No flag = your own store.
bernard facts                                      # names any specialist stores that exist
bernard facts --specialist coder                   # that specialist's own
bernard clear-facts --specialist coder

# Put a message in front of a running REPL (#462). A notice, never a turn.
bernard say "the deploy finished" --hint "check the log"
bernard say --list                                # which sessions are running
# …unless the session opted in, in which case it can RUN it (#493).
bernard --accept-remote-prompts                   # start a session that accepts them
bernard say "summarise the deploy log" --run      # refused loudly against any other session

# Watchers (#479/#201) — react to a change instead of waiting to be asked.
# Created by the agent ("watch for a reply from John and draft one"); these
# are the user's own controls.
/watchers                                         # in the REPL: list, cancel
/sleep 2h check whether the deploy settled        # a watcher whose trigger is a clock
/sleep until 15:30 send the summary
bernard app delete demo                     # sweeps every store keyed on the id
bernard app open demo                       # starts the host, opens the origin
bernard app path demo

# The host can run as a per-user service (#428).
bernard applet-host install
bernard applet-host uninstall
```

## Architecture

What each module is for, and the decisions behind it. Read the entry for a module before changing it. 81 entries: [docs/dev/architecture/README.md](docs/dev/architecture/README.md).

## Custom Providers

Users can register named **custom providers** that wrap one of the installed SDKs (`openai`, `anthropic`, `xai`) and point it at a non-default endpoint … Full notes: [docs/dev/custom-providers.md](docs/dev/custom-providers.md).

## Model Mode (multi-model assignment)

`config.modelMode` (#170) tiers the (provider, model) used by each LLM call site within the active provider's model lineup. Full notes: [docs/dev/model-mode-multi-model-assignment.md](docs/dev/model-mode-multi-model-assignment.md).

## Dispatch Observability

**Every debug-log row is placed in a tree.** `debugLog` stamps a `trace` field — `{turnId, dispatchId, parentDispatchId, parentToolCallId, toolCallId}` — read… Full notes: [docs/dev/dispatch-observability.md](docs/dev/dispatch-observability.md).

## Settings Profiles

User-tunable settings are organized into named **profiles** (#207). Full notes: [docs/dev/settings-profiles.md](docs/dev/settings-profiles.md).

## Setup

`bernard setup`, `/setup`, and a first run all walk the same flow (#447). Full notes: [docs/dev/setup.md](docs/dev/setup.md).

## The Vendor Boundary

Everything Bernard names from the Vercel AI SDK crosses in four places, and the rule is not "an adapter exists" but \*\*"it is the only door, and typed strictly… Full notes: [docs/dev/the-vendor-boundary.md](docs/dev/the-vendor-boundary.md).

## Key Patterns

Cross-cutting rules: tool surfaces, the agent pool, retrieval, caching, compaction, MCP namespacing and more. 33 entries: [docs/dev/key-patterns/README.md](docs/dev/key-patterns/README.md).

## Code review on a PR posts to the PR

A review whose findings live only in the conversation is a review nobody can act
on twice. `/address-pr-reviews` drives a PR to done by reading **review threads**
— inline diff comments carrying `path`, `line` and `isResolved`, fetched through
GraphQL because REST cannot say which are still open — plus top-level issue
comments. Findings reported as prose in a transcript appear in neither, so the
two halves of the workflow cannot meet: nothing to reply to, nothing to resolve,
and no record on the PR of what was raised or why it was dismissed.

So when a review runs against a PR, it **posts**. Use `ReportFindings` when the
host provides it; when it does not — it is frequently absent, which is what
started this — fall back to the API rather than to prose:

```bash
read -r OWNER REPO < <(gh repo view --json owner,name -q '.owner.login + " " + .name')
gh api "repos/$OWNER/$REPO/pulls/$NUM/reviews" --input - <<'JSON'
{
  "event": "COMMENT",
  "body": "<one paragraph: what was reviewed, and the headline>",
  "comments": [
    { "path": "src/tools/augment.ts", "line": 641, "side": "RIGHT",
      "body": "**high** — one-sentence defect.\n\nConcrete failure: inputs → wrong result." }
  ]
}
JSON
```

Rules that make the output usable rather than merely present:

- **One comment per finding, anchored to the line it is about.** That is what
  makes it a resolvable thread. A wall of findings in the review body is the
  prose problem with extra steps.
- **`event: "COMMENT"`**, never `APPROVE` or `REQUEST_CHANGES`, unless the user
  asked for a verdict. A review agent blocking its own author's PR is a state
  nobody asked for.
- **`line` must be a line the diff touches on the `RIGHT` side**, or GitHub
  rejects the whole review with a 422 — losing every comment in the batch, not
  just the bad one. A finding about code the diff did not change has no anchor;
  put those in the body and say which file they are about.
- **Lead each comment with a severity** and follow it with a concrete failure —
  inputs, and the wrong output they produce. "Consider extracting this" is not
  reviewable; "`npm test` classifies as a write, so the second identical run is
  refused with a message asserting the result is unchanged" is.
- **Post only what survived verification.** A finding that did not reproduce
  costs the author the same read as one that did, and teaches them to skim.
- **Say what was checked and found clean**, briefly, in the body. A reviewer that
  only ever lists problems cannot be distinguished from one that stopped early.

The same contract is what makes `/address-pr-reviews` able to finish: it replies
to each thread with what it did and resolves it, so the PR ends carrying the
argument rather than just the diff.

## Evals

There are **two** eval mechanisms, and which one a question belongs to is decided by whether answering it costs an API call. Full notes: [docs/dev/evals.md](docs/dev/evals.md).

## File Locations (XDG Base Directory)

Bernard follows the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/). Full notes: [docs/dev/file-locations-xdg-base-directory.md](docs/dev/file-locations-xdg-base-directory.md).

## Environment Variables

Every `BERNARD_*` variable and provider key: one line each in [docs/dev/environment-variables-index.md](docs/dev/environment-variables-index.md), full notes in [docs/dev/environment-variables.md](docs/dev/environment-variables.md). Precedence: CLI flag > active profile > environment > default.

## Tool-Wrapper Specialists

Specialists have a `kind` field: `persona` (default, historic behavior), `tool-wrapper` (fronts a concrete tool or CLI with OS-aware examples and strict JSON… Full notes: [docs/dev/tool-wrapper-specialists.md](docs/dev/tool-wrapper-specialists.md).

## Tool Augmentation Layer

A transparent layer that wraps every tool's `execute` function to observe errors and inject usage guidance into the system prompt. Full notes: [docs/dev/tool-augmentation-layer.md](docs/dev/tool-augmentation-layer.md).

## Caching Layer

In-memory TTL caches (#171) cut latency and tokens across three layers. Full notes: [docs/dev/caching-layer.md](docs/dev/caching-layer.md).

## A read does not overtake a write

**src/tools/write-barrier.ts** — a model that writes something and then wants to know it landed emits both calls in ONE step, and the AI SDK runs a step's tool… Full notes: [docs/dev/a-read-does-not-overtake-a-write.md](docs/dev/a-read-does-not-overtake-a-write.md).

## Verdicts and Step Limits

Two mirror-image defects to #363, both found in one `mcp_config add` run that succeeded and was then undone by the agent that performed it. Full notes: [docs/dev/verdicts-and-step-limits.md](docs/dev/verdicts-and-step-limits.md).

## Non-Throwing Tool Failures

**src/tool-result-shape.ts** (#363) is the single structural answer to "did this tool call fail even though it returned?". Full notes: [docs/dev/non-throwing-tool-failures.md](docs/dev/non-throwing-tool-failures.md).

## Failure Taxonomy

`src/error-taxonomy.ts` is a central classifier that turns a raw tool error (message, optional `toolName`/`errno`/`httpStatus`) into `{category, correctable… Full notes: [docs/dev/failure-taxonomy.md](docs/dev/failure-taxonomy.md).
