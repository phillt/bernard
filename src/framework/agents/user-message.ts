import type { CoreMessage } from 'ai';

/**
 * The seed user message a dispatched agent receives.
 *
 * Six definitions (`sub`, `task`, `specialist`, `mcp-delegate`, `pac-actor`,
 * `pac-planner`) had byte-identical `Task:` / `Context:` concatenation, and
 * `tool-wrapper` the same thing with a different label. One function now, so
 * that when an attachment can ride along (#427) they opt in together rather
 * than seven times.
 *
 * **A leaf, and deliberately a narrow one.** `import type { CoreMessage }` and
 * nothing else — no `ctx`, no config, and in particular NOT `src/image.ts`,
 * which reaches `./providers/catalog.js` and would hand the framework an edge
 * to the provider catalog. Loading bytes off disk belongs to the dispatch
 * tools; this only decides message shape.
 */

/**
 * One attachment travelling with a dispatch.
 *
 * Modelled on the AI SDK's `UserContent` image part rather than on
 * `src/image.ts`'s `ImageAttachment`, so the producer side is replaceable and
 * a second kind is a new member here rather than a second parallel path.
 *
 * Image-only for now, on purpose: a file attachment is a different capability
 * question (`file-input`, not `vision`) with thinner per-provider support.
 * `estimateContentPartTokens` already has a `'file'` arm that nothing
 * produces; leaving it unproduced is the honest state.
 *
 * Structural, not nominal, so `src/image.ts`'s `ImageAttachment` satisfies it
 * as-is and the main agent shares {@link attachTo} rather than hand-building
 * the same parts. The AI SDK's image-part shape (`image` vs `data`,
 * `mimeType` vs `mediaType`) is then encoded once — a provider fix or an SDK
 * bump lands in one place instead of silently missing the main-agent path.
 */
export interface DispatchAttachment {
  mimeType: string;
  data: Buffer;
}

/**
 * Opt-in to receiving files (#427).
 *
 * Declared once and `extends`-ed rather than pasted into each dispatch input,
 * but the opt-in property is unchanged: a definition that does not extend this
 * cannot receive bytes, which is the same fail-closed-by-omission shape as
 * `headlessToolOptions`. Attachments are resolved from paths by the dispatch
 * TOOL, never here — the framework must not reach the filesystem.
 */
export interface WithAttachments {
  attachments?: DispatchAttachment[];
}

export interface TaskMessageInput {
  task: string;
  context?: string;
  attachments?: DispatchAttachment[];
  /** `Task` for most definitions, `Request` for `tool-wrapper`. */
  label?: string;
}

/**
 * The text half, on its own.
 *
 * Separately exported because `src/ui/App.tsx` feeds exactly this string to
 * `resolvePolicyDecisionFor` so the policy decision cannot diverge from the
 * real dispatch — and it used to get it by reading `buildUserMessage(...)
 * .content` behind a `typeof === 'string'` guard that would silently fall back
 * to the bare description the moment content became an array. Calling this
 * instead means that failure mode cannot exist.
 */
export function renderTaskText(input: TaskMessageInput): string {
  const label = input.label ?? 'Task';
  return input.context
    ? `${label}: ${input.task}\n\nContext: ${input.context}`
    : `${label}: ${input.task}`;
}

/**
 * Wraps already-rendered text as a user message, splicing in attachments.
 *
 * The primitive, because not every definition builds its text the same way —
 * the PAC phases stack `Plan:` / `Prior plan:` / `Critic feedback:` sections
 * and cannot use {@link renderTaskText}. Splitting rendering from attaching is
 * what lets them opt in without their prose being forced into one shape.
 *
 * **Returns a plain string when there are no attachments**, which is not
 * laziness: the array form is a shape change, and applying it on the
 * zero-attachment path would be blast radius for a feature that turn is not
 * using. Applying it only when something is attached is free, and it keeps
 * every existing `toEqual({role:'user', content:'Task: …'})` assertion true.
 */
export function attachTo(text: string, attachments?: DispatchAttachment[]): CoreMessage {
  if (!attachments || attachments.length === 0) return { role: 'user', content: text };
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      ...attachments.map((a) => ({
        type: 'image' as const,
        image: a.data,
        mimeType: a.mimeType,
      })),
    ],
  };
}

/** {@link renderTaskText} plus {@link attachTo} — the shape six definitions share. */
export function buildTaskUserMessage(input: TaskMessageInput): CoreMessage {
  return attachTo(renderTaskText(input), input.attachments);
}
