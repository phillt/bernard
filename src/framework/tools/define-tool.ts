import { tool } from 'ai';

/**
 * The AI SDK's `tool()`, under a Bernard-owned name (#sdk-boundary).
 *
 * `defineTool(x)` is `tool(x)` — the cast to `typeof tool` ties it to the SDK's
 * own overloaded signature rather than restating one, so adopting it is
 * provably inert and both overloads (with and without `execute`) survive with
 * their inference intact.
 *
 * ## Why it exists
 *
 * `toolToAISDK` in `./adapter.js` is the correct adapter and most traffic
 * bypassed it: measured, 31 files called the SDK's `tool()` directly across 37
 * call sites, against 9 call sites in 5 files going through the adapter. An
 * adapter a fifth of the callers route through is worse than none, because it
 * buys the belief of protection.
 *
 * The next SDK major renames `tool()`'s `parameters:` field to `inputSchema:`.
 * Through here that is one edit; direct, it is 37 spread across `src/tools`,
 * `src/apps`, `src/cron` and the framework. Nothing else about those tools has
 * to move for that to be true, which is why this is a rename and not a
 * migration.
 *
 * ## Why NOT `BernardTool`
 *
 * Converting those call sites to `BernardTool` + `toolToAISDK` is the real fix
 * and a real per-tool refactor: each grows a `ToolResult` envelope and a
 * `serializeForModel`, and every downstream consumer of that tool's historical
 * return shape becomes behaviour at risk. Doing it under cover of an
 * SDK-boundary change would mix a large behavioural diff into one whose stated
 * property is that it has none. This makes the boundary total TODAY; the
 * conversion can proceed tool by tool afterwards, and each conversion simply
 * stops calling this.
 *
 * ## Why the ARROW form and not `export const defineTool = tool`
 *
 * This is about the BINDING, not about which file it lives in, and the first
 * draft of this module conflated the two. `export const defineTool = tool`
 * dereferences the imported binding at module EVALUATION time, so a test that
 * mocks `'ai'` with a partial factory omitting `tool` — `mcp.test.ts`,
 * `mcp.call-safety.test.ts` and `runner.test.ts` all legitimately do — captures
 * `undefined` and goes down at import. The arrow defers the read to call time.
 * Measured both ways with the expression appended to `adapter.ts`: arrow form
 * 117/117 across the five suites that mock `'ai'` partially, eager form 3 of 5
 * files failing. Moving this into `adapter.ts` would NOT reintroduce that —
 * the form is what fixes it, and it would be equally broken here.
 *
 * ## Why its own file, beside `adapter.ts` rather than inside it
 *
 * The reason that survives measurement is LAYERING. `adapter.ts` is a
 * BEHAVIOURAL adapter — it wraps `execute`, translates the `ToolResult`
 * envelope, attaches non-enumerable meta. This is a naming boundary with no
 * behaviour at all, and a true leaf: `ai` and nothing else. Five of the files
 * adopting it (`plan`, `think`, `evaluate`, `subagent`, `specialist-run`) did
 * not import `adapter.js` before, and a leaf is the cheaper edge to hand them.
 *
 * There is no import-graph argument on top of that: `adapter.ts` already does
 * `import { tool } from 'ai'` on its first line, so hosting this would add no
 * new edge of its own.
 *
 * One genuine placement cost remains, and it is small. `delegate.test.ts` mocks
 * the WHOLE adapter module with a factory returning only `attachMeta`, so with
 * `defineTool` exported from there, `delegate.ts` importing it fails 6 of that
 * file's 20 tests — measured, by repointing the import. That is a mock made to
 * track an import graph it does not care about, and it is an argument for the
 * split rather than the reason for it.
 *
 * ## The one thing not to rename
 *
 * `BernardTool.parameters` (`./types.js`) is Bernard's OWN vocabulary, not the
 * SDK's. It must not be renamed, now or ever — `toolToAISDK` is where it
 * crosses into the SDK, and that translation is correct as written.
 */
export const defineTool = ((t: Parameters<typeof tool>[0]) => tool(t)) as typeof tool;
