/**
 * Every `ai` name Bernard uses, re-exported under Bernard's own module
 * (#sdk-boundary).
 *
 * ## This buys no type safety, and that is deliberate
 *
 * `export type { CoreMessage } from 'ai'` is an ALIAS. It does not validate
 * anything, it cannot refuse a wrong shape, and a structural copy of the SDK's
 * types here would be strictly worse — it would drift, and the drift would be
 * invisible because both sides compile. Do not "improve" this file into one.
 *
 * What it buys is arithmetic. `CoreMessage` alone appears 314 times across 52
 * files; `Tool` another 25. At the next SDK major those are 339 edits spread
 * over every layer of the product, each one a chance to get a rename half
 * right. Through here they are ONE line:
 *
 * ```ts
 * export type { ModelMessage as CoreMessage } from 'ai';
 * ```
 *
 * The identifiers therefore stay the SDK's current spelling rather than being
 * renamed to something Bernard-flavoured. Renaming would touch the same 339
 * sites for no additional benefit, and the whole point of this module is that
 * the bump is small.
 *
 * ## Why almost everything here is a TYPE
 *
 * Type re-exports are erased at compile time, so importing this module adds no
 * runtime edge at all — which matters because it is imported from `src/ui`,
 * `src/tools`, `src/apps` and the framework alike, and because the test suite
 * mocks `'ai'` with partial factories in a dozen places. A value re-export of a
 * name such a factory omits would fail at module evaluation; a type re-export
 * cannot.
 *
 * Two values are here because Bernard branches on them: the error classes
 * `tool-call-repair.ts` matches with `.isInstance()`. They stay in one place
 * for the same reason the types do.
 *
 * Deliberately NOT here:
 *
 * - `tool()` — its owned name is `defineTool` (`./tools/adapter.js`), beside
 *   `toolToAISDK`, because the bump renames its `parameters:` field and the
 *   rename belongs next to the adapter that already translates for it.
 * - `generateText` / `streamText` — call-site functions, not vocabulary. Every
 *   caller is a `vi.mock('ai')` target today and routing them through a
 *   re-export would change what those factories have to provide.
 * - `ai/test` — test-only surface; a production module must not re-export it.
 */

export type {
  // Messages and their parts.
  CoreMessage,
  CoreUserMessage,
  CoreAssistantMessage,
  CoreToolMessage,
  TextPart,
  ImagePart,
  ToolCallPart,
  ToolResultPart,
  UserContent,
  // Tools.
  Tool,
  ToolSet,
  ToolCallRepairFunction,
  // Models and results.
  LanguageModel,
  GenerateTextResult,
  TextStreamPart,
} from 'ai';

export { InvalidToolArgumentsError, NoSuchToolError } from 'ai';
