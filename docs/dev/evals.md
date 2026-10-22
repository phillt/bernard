<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

## Evals

There are **two** eval mechanisms, and which one a question belongs to is decided by whether answering it costs an API call.

**Deterministic, in-suite, runs in CI.** `src/__tests__/eval-harness.test.ts` (#178) dispatches a closed `InvariantSpec` union (`src/__tests__/fixtures/fixture-schema.ts`) over the fixtures in `fixtures/transcripts/`, asserting on pure functions with no LLM calls. Extending it is: add a variant to the union, add a case to the runner switch, add a fixture.

`src/__tests__/retrieval-eval.test.ts` (#524) is the second, and it is in-suite for a measured reason rather than by preference: the embedder is local, so retrieval quality costs **196 ms** to load MiniLM warm and **2 ms** per query, with no network. That makes the baseline a regression guard CI re-derives on every PR rather than a number somebody ran by hand once. It seeds a committed fixture corpus (`fixtures/retrieval/`) by writing the store's own on-disk payload and reading it back through `RAGStore.load()` — **not** through `addFacts`, whose 0.92 dedup would silently drop the near-duplicate records the corpus exists to measure, and would couple the baseline to #525. Metrics are reported per retrieval _shape_, because a single aggregate hides the failure worth catching: a change can lift mean recall while destroying identifier lookup.

**Behavioral, real API calls, never in CI.** `scripts/eval-*.ts`, gated behind `BERNARD_EVAL=1` with an absolute `BERNARD_HOME` so the run uses a throwaway data directory. Both guards hard-exit, and every `src/` import is deferred into `main()` — `src/paths.ts` freezes all four XDG bases at module load, so a static import would pin them to the user's real home before the guard could run.

- `scripts/eval-citation-coverage.ts` (#173) — `[^Sn]` marker coverage on factual turns, absence on opinion turns, `[unverified]` rate.
- `scripts/eval-context-gathering.ts` (#123) — whether the context-gathering protocol gets the agent to read named memory before answering a count-dependent question, plus a reference-resolver sub-suite.
- `scripts/eval-framework-parity.ts` (#158) — a byte-stable snapshot of everything reaching `doGenerate`, via `MockLanguageModelV1`. Needs no API key despite living in this lane.

**`scripts/` is inside the typecheck gate** (`npm run typecheck:scripts`, `tsconfig.scripts.json`, and a CI step), and that is not incidental. It was outside _every_ gate — not in the base tsconfig's include, not in `eslint src/`, not in `format:check`'s globs — and two of the three scripts had silently stopped compiling against the `src/` they import. A separate config rather than a widened include, because the base compiles with `rootDir: src` and widening it would emit `dist/scripts/…`. Test files stay excluded there exactly as in the base: several decisions in `src/` turn on `tsc` not seeing them.
