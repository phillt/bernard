<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

## The Vendor Boundary

Everything Bernard names from the Vercel AI SDK crosses in four places, and the
rule is not "an adapter exists" but **"it is the only door, and typed strictly
enough to refuse the wrong shape."** An adapter a fifth of the traffic routes
through is worse than none — it buys the belief of protection. The layer existed
in three places before #sdk-boundary and failed three different ways: the tool
adapter was correct and bypassed, `normalizeUsage` was the only door and blind,
and no Bernard-owned message type existed at all.

- **`src/framework/sdk.ts` is the vocabulary.** Every `ai` TYPE Bernard names is
  re-exported from there under the SDK's current spelling, plus the two error
  classes `tool-call-repair.ts` matches with `.isInstance()`. It gives no type
  safety and the docstring says so at the top, so nobody "improves" it into a
  structural copy of the SDK's types — a copy drifts, and the drift is invisible
  because both sides compile. What it buys is arithmetic: `CoreMessage` appears
  323 times across 53 files and `Tool` another 208, and at the next major those
  become **one line**, `export type { ModelMessage as CoreMessage } from 'ai'`.
  That is also why the identifiers are not renamed to something
  Bernard-flavoured: renaming touches the same sites for no further benefit.
  Almost everything is a TYPE deliberately — a type re-export is erased, so the
  module adds no runtime edge, and the suite mocks `'ai'` with PARTIAL factories
  in about a dozen places where a value re-export of an omitted name fails at
  module evaluation. `generateText` / `streamText` stay out: they are call-site
  functions rather than vocabulary, and every caller is a `vi.mock('ai')` target.
  `ai/test` stays out because a production module must not re-export a test
  surface.
- **`defineTool` (`src/framework/tools/define-tool.ts`) closes the bypass.** 31
  files called the SDK's `tool()` directly across 37 call sites, against 9 call
  sites in 5 files going through `toolToAISDK`. `defineTool(x)` IS `tool(x)` —
  the cast to `typeof tool` ties it to the SDK's own overloaded signature rather
  than restating one, so both overloads keep their inference and adoption is
  provably inert. It is deliberately NOT a conversion to `BernardTool`: that is
  the real fix and a real per-tool refactor (each grows a `ToolResult` envelope
  and a `serializeForModel`, and every consumer of that tool's historical return
  shape becomes behaviour at risk), so it proceeds tool by tool afterwards and
  each conversion simply stops calling this.
  - **The arrow form is about the BINDING, not the placement**, and the first
    draft of the comment conflated the two. `export const defineTool = tool`
    dereferences the imported binding at module EVALUATION time, so a test that
    mocks `'ai'` with a partial factory omitting `tool` — `mcp.test.ts`,
    `mcp.call-safety.test.ts` and `runner.test.ts` all legitimately do —
    captures `undefined` and goes down at import. Measured with the expression
    appended to `adapter.ts`: **arrow form 117/117** across the five suites that
    mock `'ai'` partially, **eager form 3 of 5 files failing**. Hosting it in
    `adapter.ts` would not reintroduce that; the form is the fix.
  - **Its own file, beside `adapter.ts` rather than inside it**, on LAYERING.
    `adapter.ts` is a BEHAVIOURAL adapter; this is a naming boundary with no
    behaviour and a true leaf, and five adopting files (`plan`, `think`,
    `evaluate`, `subagent`, `specialist-run`) had no `adapter.js` edge before.
    There is no import-graph argument on top: `adapter.ts` already imports
    `tool` on its first line. One genuine placement cost remains and it is
    small — `delegate.test.ts` mocks the WHOLE adapter with a factory returning
    only `attachMeta`, so hosting `defineTool` there fails 6 of that file's 20
    tests (measured, by repointing the import). An argument for the split, not
    the reason for it.
  - **`adapter.ts` keeps calling `tool()` directly and is the only place that
    does.** It owns the translation, so routing it through `defineTool` buys
    nothing — the `parameters:` field it passes is right there — and would hand
    it an edge it does not need. `adapter.test.ts` likewise keeps building
    fixtures with the raw SDK `tool()`: it tests the boundary from outside, so
    its inputs must be genuine SDK tools.
  - **`BernardTool.parameters` is Bernard's OWN vocabulary and must never be
    renamed**, now or ever. `toolToAISDK` is where it crosses into the SDK, and
    that translation is correct as written.
- **`src/tool-result-output.ts` owns where a `tool-result` value lives.** One
  question had four answers: a required cast (`context.ts:96`), an explicit `any`
  (`truncateToolResults`), the SDK's own type (`Thread.tsx`) and an optional cast
  (`ask-user-history.ts`). Under a rename one fails loudly and three go silent,
  each in a different subsystem — truncation stops truncating and every oversized
  result goes back in full, the transcript renders a bare marker under every tool
  call, and `ask_user` answers stop being injected into history. **The asymmetry
  is what makes a mechanical rename actively wrong**: at STEP level
  (`toolResults[i]`) the value is raw, but inside a `role:'tool'` MESSAGE the part
  carries an envelope `{type, value}`. This module owns the message-part side
  only, and says so; step-level readers must not call it. `truncateToolResults`
  is the one site that both reads and writes, so the one a rename could
  half-fix — reading the new field while writing the old truncates into a slot
  the provider ignores, with the counter still reporting the result as bounded.
  - **The error distinction crosses, through each vocabulary's OWN channel.**
    `LanguageModelV2ToolResultOutput` has FIVE members — `text`, `json`,
    `error-text`, `error-json`, `content` — so a downgrade keeping only the
    VALUE re-upgrades by guessing the type from `typeof value === 'string'`, and
    an `error-text` result comes back as an ordinary `text` one: a failure shown
    to the model as a success, made permanent by the next `save`. That is this
    boundary's own subject, on the one path it introduces, and the first cut had
    it. The failure bit maps to `ai@4`'s `ToolResultPart.isError` and back to
    `error-*`, which beats carrying the v5 `output` key alongside `result` twice
    over: no duplicated value on disk (`truncateToolResults` rewrites these
    parts, so a retained envelope would hold the pre-truncation value and quietly
    undo the size bound), and the flag is LIVE rather than merely recoverable —
    `convertToLanguageModelPrompt` forwards `isError` and `@ai-sdk/anthropic`
    emits `is_error`, where a stray `output` key would be ignored and the error
    would travel unflagged. **Residual:** `content` degrades to `json`; the value
    survives and nothing is reclassified, and v4's `experimental_content` has a
    genuinely different element shape, so mapping it is a conversion rather than
    a passthrough.
- **`HistoryStore.load` normalizes rather than casts.** It was
  `JSON.parse(data) … as CoreMessage[]` behind a `'role' in entry` filter, so
  whatever was on disk went straight to the provider. Measured on a real install:
  **324 messages, 365 `tool-result` parts, all 365 carrying `result` and none
  carrying `output`** — and the next major types `output` as required, making
  every returning user's file a hard failure on their first turn after the
  upgrade. The existing `try/catch` does not help: it guards the READ, and the
  failure lands later. The conversion is shape-directed and per part, so on
  `ai@4` it is identity and returns parts by reference.
  - **No version stamp**, which looks like the obvious companion. The file is a
    bare JSON array, so stamping means wrapping it in an object — and `load`
    rejects a non-array, so a user who rolled back to an older Bernard would
    silently lose their whole history. A per-part shape check is strictly
    stronger anyway: it stays correct for a file written across an upgrade
    boundary, which one stamp cannot describe.
  - **`redacted-reasoning` parts are deliberately not stripped.** They are valid
    on `ai@4` and handing them back is correct for Anthropic extended thinking,
    so dropping them now is a live behaviour change for a problem that does not
    exist yet. That strip belongs in the bump.
  - Pinned by `src/__tests__/fixtures/history-v4.json`, a redacted copy of a real
    file with its key structure kept byte-for-byte. It earned its keep at once by
    finding two things a hand-written fixture would not have: assistant and tool
    messages carry an `id` field `CoreMessage` does not declare, and a
    `tool-result`'s `result` is a string, an object AND an array within one file.
- **Some of this the type system cannot hold, and `CacheMetadata` is the case.**
  "Delete the `?` so a wrong shape fails to compile" was measured and does not
  work: the SDK types provider metadata as
  `Record<string, Record<string, JSONValue>>` and names none of the cache keys,
  and TypeScript will not let a string index signature satisfy a required
  property — so making them required takes the SDK's own `StepResult` out of
  assignability and breaks `onStepFinish` against BOTH `generateText` and
  `streamText`, plus four direct `normalizeUsage` call sites. Six errors, all
  false. Optional is also worse than it looks, because TypeScript does not
  compare an index signature against an optional target property **at all** —
  and that is not just "a rename slips through": measured, the interface
  compiles with a cache count declared as `(n: number) => void`, so it was blind
  to **any** wrong type. So
  the names live in two required-field interfaces with a compile-time key-tuple
  coverage assertion (in production code — `tsconfig.json` excludes tests, so a
  `@ts-expect-error` in one is compiled by nothing), and the real guard is
  `cache-metadata.contract.test.ts`, which injects a byte-verbatim provider HTTP
  response and asserts the emitted KEY SETS as well as the arithmetic. A renamed
  field folds to zero, so a numeric assertion alone fails by reporting a
  plausible number rather than naming the key.
- **Two integration tests may never `vi.mock('ai')`**, which is the point of
  them. `cache-metadata.contract.test.ts` measures the SDK's mapping from wire
  JSON to `providerMetadata`; the wire field names are the providers' public
  contract and do not move when the SDK majors, which is what makes the fixture
  version-independent. Its OpenAI-compatible half runs through `createXai`,
  pinning the opposite arithmetic (cached is a SUBSET of prompt, not disjoint)
  on Bernard's only shipped user of that cache branch.
  `mcp-tool-schema.integration.test.ts` speaks the MCP wire protocol to a real
  child process and asserts the JSON Schema reaching `doGenerate` is deep-equal
  to what the server declared. `src/mcp.ts` is `any` end to end through that
  path, so deleting `convertTool` — which the bump does — produces no type error
  whether the deletion is right or wrong; a runtime assertion is the only thing
  that can license it, and every OTHER MCP test in the repo mocks
  `@ai-sdk/mcp`, so all of them pass with `convertTool` returning garbage. Its
  fixture server is dependency-free because `@modelcontextprotocol/sdk` is not
  installed, and asserting interop through a second vendor's server would measure
  that vendor instead.
- **`scripts/__fixtures__/framework-parity.json` is captured, not regenerable.**
  It is the byte-stable record of everything reaching `doGenerate` across the six
  dispatch shapes, and it is the only before/after the migration will have: the
  harness's own "check out the other branch and re-run" recipe needs the OLD `ai`
  in `node_modules`, which the bump removes. Compare against it with
  `BERNARD_EVAL=1 BERNARD_EVAL_BASELINE=scripts/__fixtures__/framework-parity.json`.
