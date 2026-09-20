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
 * ## Why its own file, beside `adapter.ts` rather than inside it
 *
 * Two reasons, and the second was measured rather than reasoned.
 *
 * `adapter.ts` is a BEHAVIOURAL adapter — it wraps `execute`, translates the
 * `ToolResult` envelope, attaches non-enumerable meta. This is a naming
 * boundary with no behaviour at all, and it is a true leaf: `ai` and nothing
 * else. Five of the files adopting it (`plan`, `think`, `evaluate`, `subagent`,
 * `specialist-run`) did not import `adapter.js` before, and a leaf is the
 * cheaper edge to hand them.
 *
 * Placed IN `adapter.ts` it stops being inert, in two ways that the suite
 * catches. `delegate.test.ts` mocks the whole adapter with a factory returning
 * only `attachMeta`, so every module importing a tool constructor from there
 * would need that factory extended — the test's mock made to track an import
 * graph it does not care about. And `mcp.test.ts`, `mcp.call-safety.test.ts`
 * and `runner.test.ts` mock `'ai'` with partial factories that legitimately
 * omit `tool`; a module-level `export const defineTool = tool` in `adapter.ts`
 * dereferences the missing binding at EVALUATION time and takes those three
 * files down at import. Hence both the separate file and the function form:
 * `tool` is read when a tool is built, not when the module loads.
 *
 * ## The one thing not to rename
 *
 * `BernardTool.parameters` (`./types.js`) is Bernard's OWN vocabulary, not the
 * SDK's. It must not be renamed, now or ever — `toolToAISDK` is where it
 * crosses into the SDK, and that translation is correct as written.
 */
export const defineTool = ((t: Parameters<typeof tool>[0]) => tool(t)) as typeof tool;
