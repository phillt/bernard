import { z } from 'zod';
import type { MemoryStore } from '../memory.js';
import { MemoryKeyCollisionError, MemoryScopeError, MemorySupersedeError } from '../memory.js';
import { MemoryCandidateStore } from '../memory-candidates.js';
import { describeProposal } from '../memory-proposal.js';
import { MEMORY_DIR } from '../paths.js';
import type { BernardTool } from '../framework/tools/types.js';
import { ok, err } from '../framework/tools/types.js';
import type { ProvenanceStore } from '../provenance.js';
import type { BernardConfig } from '../config.js';
import type { ToolOptions } from './types.js';
import type { UsageRecorder } from '../framework/hooks/token-stats.js';

/**
 * Split from the scratch tool's schema with #513.
 *
 * They shared one object, so adding `supersede` to the enum would have
 * advertised it on `scratch` as well — where it means nothing, since scratch is
 * an in-memory map discarded at session end and has no supersession to record.
 */
const MEMORY_PARAMETERS = z.object({
  action: z
    .enum(['list', 'read', 'write', 'delete', 'supersede', 'retire', 'proposals'])
    .describe('The action to perform'),
  key: z
    .string()
    .optional()
    .describe('The memory key (required for read/write/delete/supersede/retire)'),
  content: z.string().optional().describe('The content to write (required for write)'),
  replacement: z
    .string()
    .optional()
    .describe(
      'For supersede: the key of the memory that replaces this one. It must already exist.',
    ),
  proposalId: z
    .string()
    .optional()
    .describe(
      'For proposals: the id shown in the Memory Housekeeping block, to mark accepted or declined.',
    ),
  decision: z
    .enum(['accepted', 'declined'])
    .optional()
    .describe('For proposals: what the user decided about proposalId. Omit to just list them.'),
});

const SCRATCH_PARAMETERS = z.object({
  action: z.enum(['list', 'read', 'write', 'delete']).describe('The action to perform'),
  key: z.string().optional().describe('The scratch key (required for read/write/delete)'),
  content: z.string().optional().describe('The content to write (required for write)'),
});

type MemoryArgs = z.infer<typeof MEMORY_PARAMETERS>;
type ScratchArgs = z.infer<typeof SCRATCH_PARAMETERS>;

/**
 * Creates the persistent memory tool backed by on-disk markdown files.
 *
 * ## The `description` is the entire write-side policy, not one prompt among many
 *
 * Worth stating because a prompt tweak reads as hopeful otherwise. `writeMemory`
 * has exactly one non-machinery caller — the `write` case below — and nothing in
 * `agent-prompt.ts`, `agent.ts` or `framework/agents/` tells the model what is
 * worth saving. So this string is 100% of the instruction surface, and
 * tightening it from "anything worth recalling later" (which admits "that's an
 * image I uploaded, that can be ignored") to a stays-true/merely-happened
 * distinction changes the whole of it.
 *
 * The structural alternatives were weighed and are worse. A tool that REFUSES an
 * episodic write needs the same semantic judgement `memory-consolidation.ts`
 * measures as undecidable from text, and its failure mode is far worse: a false
 * refusal silently loses a standing fact at the moment the user asked to keep
 * it. A `kind: 'standing' | 'episodic'` argument would make the episodic
 * category deterministically retirable, which is the real prize — but it is a
 * self-report from the same model that wrote the detritus under an instruction
 * not to. The non-self-report version is USE, not intent: an episodic record is
 * never recalled again. Memory has no per-key access signal because it is
 * injected wholesale, so that is net-new work and the honest direction rather
 * than something this change could have done.
 *
 * Supports list, read, write, delete, supersede, retire and proposals actions for cross-session recall.
 * Returns a {@link BernardTool}; `serializeForModel` reproduces the historical
 * plain-string output (including the `"Error: "` prefix on validation errors).
 *
 * ## The write-time contradiction check (#373)
 *
 * The paragraph above rejects a REFUSING tool, and that still holds — the
 * check added here never refuses. It notices that an incoming note disagrees
 * with one already saved and either retires the old one, saying so, or asks.
 * Its verdict is advisory in the strongest sense: every failure path, and a
 * missing `config`, resolve to writing exactly as before.
 *
 * The three deps below are all optional for that reason, and each absence is a
 * deliberate degradation rather than a bug: no `config` means no check at all,
 * no `askUser` means an ambiguous case keeps both (the headless answer, which
 * `headlessToolOptions` gives for free by omitting the callback), and no
 * `onUsage` means the spend is unrecorded rather than unmade.
 *
 * @param memoryStore - The backing MemoryStore instance.
 * @param provenance - Per-turn source store, for `read` registration.
 * @param deps - Optional wiring for the contradiction check.
 */
/**
 * Runs the write-time contradiction check and acts on it, returning a sentence
 * to append to the tool result — or `''` when there is nothing to say (#373).
 *
 * **Everything here is best-effort by construction.** It returns a string, not
 * a decision: the caller writes the note either way. A missing `config`, a
 * failed check, an unparseable verdict, a `supersede` that throws, a user who
 * cancels the question — all of them come back as `''` or a note, never as a
 * refusal.
 *
 * The import is DYNAMIC and that is load-bearing: this module sits in
 * `createTools`' eager `audience:'any'` group, and #529 measured **+17 ms** on
 * every tool-registry build when a `generateText`-owning module was pulled in
 * from here statically.
 */
async function contradictionNote(
  incoming: { key: string; content: string },
  store: MemoryStore,
  deps:
    | { config?: BernardConfig; askUser?: ToolOptions['askUser']; onUsage?: UsageRecorder }
    | undefined,
  abortSignal?: AbortSignal,
): Promise<string> {
  if (!deps?.config) return '';
  try {
    const [{ checkContradiction }, { consolidationInputs }] = await Promise.all([
      import('../memory-contradiction.js'),
      import('../memory-consolidation.js'),
    ]);
    const verdict = await checkContradiction(incoming, consolidationInputs(store), deps.config, {
      ...(abortSignal ? { abortSignal } : {}),
      ...(deps.onUsage ? { onUsage: deps.onUsage } : {}),
    });
    if (verdict.kind === 'none') return '';

    // Archive, never delete. `supersede` writes one front-matter line and
    // leaves the file where the user can find it, so undoing it is deleting
    // that line. It needs the replacement to exist, which is why the caller
    // runs all of this AFTER the write — see the call site.
    const retire = (key: string, replacement: string): boolean => {
      try {
        return store.supersede(key, replacement);
      } catch {
        return false;
      }
    };

    if (verdict.kind === 'supersede') {
      return retire(verdict.key, incoming.key)
        ? ` Retired "${verdict.key}": ${verdict.reason} Delete its \`supersededBy\` line to undo.`
        : ` This may disagree with "${verdict.key}": ${verdict.reason} Both are kept.`;
    }

    // Ambiguous. With nobody to ask, keep both rather than guess — which is
    // what `headlessToolOptions` already produces by omitting `askUser`.
    const KEEP_BOTH = `Keep both`;
    const REPLACE = `Replace "${verdict.key}" with this`;
    const DISCARD = `Discard what I just saved`;
    if (!deps.askUser) {
      return ` This may disagree with "${verdict.key}": ${verdict.reason} Both are kept.`;
    }
    const result = await deps.askUser(
      [
        {
          question: `This looks like it disagrees with "${verdict.key}". ${verdict.reason}`,
          hint: 'Both notes are saved either way; this only decides which stays visible.',
          summary: 'Conflicting memory',
          choices: [KEEP_BOTH, REPLACE, DISCARD],
          allowOther: false,
        },
      ],
      abortSignal,
      { recordInTranscript: true },
    );
    // A cancelled prompt is not a decision. Keep both — the same answer as
    // having nobody to ask.
    if ('cancelled' in result) return ` Both notes are kept.`;
    const chosen = String(result.answers[0] ?? '');

    if (chosen === REPLACE) {
      return retire(verdict.key, incoming.key)
        ? ` Retired "${verdict.key}", as you chose.`
        : ` Could not retire "${verdict.key}"; both are kept.`;
    }
    if (chosen === DISCARD) {
      // The note is already on disk by now, so "discard" retires the one just
      // saved. Still not a refusal: the write happened and one deleted
      // front-matter line brings it back.
      return retire(incoming.key, verdict.key)
        ? ` Retired the note just saved, as you chose. "${verdict.key}" stands.`
        : ` Both notes are kept.`;
    }
    return ` Both notes are kept, as you chose.`;
  } catch {
    // Fail open, and silently: a check that breaks must be indistinguishable
    // from a check that found nothing.
    return '';
  }
}

/**
 * Turns a store's typed throw into a tool ERROR (#511).
 *
 * `MemoryStore` throws `MemoryScopeError` on an out-of-scope write,
 * `MemoryKeyCollisionError` when two raw keys address one file, and
 * `MemorySupersedeError` when a supersession cannot be made. A throw out of
 * `execute` becomes an AI SDK `ToolExecutionError` that takes the whole dispatch
 * down; as an error result the model is told, in words it can act on, that the
 * write did not happen and what to do instead.
 *
 * **One guard, not one per action.** The three inline `try`s this replaces had
 * already produced the failure they invite: `supersede`'s catch-all reported a
 * FENCE refusal as `invalid_args`, on the one action where the difference
 * matters most. Wrapping at the RETURN rather than around each `execute` body
 * also means a later action cannot be added outside it.
 */
function storeErrorGuard<A, R>(t: BernardTool<A, R>): BernardTool<A, R> {
  return {
    ...t,
    execute: async (args, opts) => {
      try {
        return await t.execute(args, opts);
      } catch (e) {
        if (e instanceof MemoryScopeError) return err({ type: 'permission', message: e.message });
        // A collision is a call-shape mistake the model can fix by picking a
        // distinct key, so it comes back named rather than as a throw.
        // `invalid_args` is what `error-taxonomy` classifies as correctable.
        if (e instanceof MemoryKeyCollisionError || e instanceof MemorySupersedeError)
          return err({ type: 'invalid_args', message: e.message });
        throw e;
      }
    },
  };
}

export function createMemoryTool(
  memoryStore: MemoryStore,
  provenance?: ProvenanceStore,
  deps?: {
    config?: BernardConfig;
    askUser?: ToolOptions['askUser'];
    onUsage?: UsageRecorder;
  },
): BernardTool<MemoryArgs, string> {
  return storeErrorGuard({
    meta: {
      name: 'memory',
      kind: 'write',
      // action / key / content, all scalars (#445). `isWriteAction` below
      // still refines the gates per call, and a per-app `deny memory:action:write`
      // rule narrows it further.
      directInvocable: true,
      deterministic: false,
      sideEffect: 'local',
      cacheable: false,
      // memory.list / memory.read are pure reads despite the tool's static
      // `kind: 'write'`. Without this refinement, the read-only block gate
      // (#179) would prompt the user on every recall lookup and confirmMode
      // strict would pop a confirm menu on every list — both intolerable.
      isWriteAction: (args) => {
        const action = (args as { action?: string } | undefined)?.action;
        // `retire` and a decided `proposals` call are writes. Omitting either
        // is the fail-open #513 found in `readOnlyWrap`: a new mutating action
        // that no gate classifies is one an unattended dispatch may make with
        // nobody to ask. A bare `proposals` read is not a write.
        return (
          action === 'write' ||
          action === 'delete' ||
          action === 'supersede' ||
          action === 'retire' ||
          (action === 'proposals' &&
            (args as { decision?: string } | undefined)?.decision !== undefined)
        );
      },
    },
    description: `Persistent memory that survives across sessions. Use this for things that stay TRUE and will matter again: user preferences, standing instructions, project knowledge, contact details. Do NOT save a record of something that merely happened — a message you already sent, a link you already followed, a file the user mentioned once. Those cost context on every request forever and help no future turn. Stored as files on disk at ${MEMORY_DIR}. When a memory is replaced by a newer one use action 'supersede'; when one is simply spent and nothing replaces it use 'retire'. Prefer either over 'delete': the note stops being shown but stays on disk, so a wrong call costs nothing.`,
    parameters: MEMORY_PARAMETERS,
    execute: async ({ action, key, content, replacement, proposalId, decision }) => {
      switch (action) {
        case 'list': {
          const keys = memoryStore.listMemory();
          if (keys.length === 0) return ok('No persistent memories stored.');
          return ok(`Stored memories:\n${keys.map((k) => `  - ${k}`).join('\n')}`);
        }
        case 'read': {
          if (!key)
            return err({ type: 'invalid_args', message: 'key is required for read action.' });
          const value = memoryStore.readMemory(key);
          if (value === null) return ok(`No memory found for key "${key}".`);
          if (provenance) {
            const id = provenance.add({
              kind: 'memory',
              label: `memory:${key}`,
              contentPreview: value,
              rawRef: `memory:${key}`,
            });
            return ok(`[Source: ${id}]\n${value}`);
          }
          return ok(value);
        }
        case 'write': {
          if (!key)
            return err({ type: 'invalid_args', message: 'key is required for write action.' });
          if (!content)
            return err({ type: 'invalid_args', message: 'content is required for write action.' });
          // A collision throws; `storeErrorGuard` maps it to `invalid_args`.
          memoryStore.writeMemory(key, content);
          // **After the write, never before it (#373), and the ordering is a
          // correctness constraint rather than a preference.** `supersede`
          // refuses a replacement that does not exist, so run ahead of the
          // write every acting verdict falls through to "both are kept" — the
          // check spends a full round trip and can only ever produce a
          // sentence, indistinguishable from the model having declined. It
          // also means a write that fails its collision guard costs no model
          // call at all. Whatever this returns, the note above is already
          // saved; this only decides which of the two stays visible.
          const note = await contradictionNote({ key, content }, memoryStore, deps);
          return ok(`Memory "${key}" saved.${note}`);
        }
        case 'supersede': {
          if (!key)
            return err({ type: 'invalid_args', message: 'key is required for supersede action.' });
          if (!replacement)
            return err({
              type: 'invalid_args',
              message: 'replacement is required for supersede action.',
            });
          // No inline catch. A catch-all here SHADOWED the guard: a
          // `MemoryScopeError` raised by the fence inside `supersede` was
          // reported as `invalid_args`, on the one action where the model most
          // needs to be told it was fenced rather than that it called wrong.
          if (!memoryStore.supersede(key, replacement))
            return ok(`No memory found for key "${key}".`);
          return ok(
            `Memory "${key}" retired in favour of "${replacement}". ` +
              `It is no longer shown, and its file is still on disk.`,
          );
        }
        case 'retire': {
          if (!key)
            return err({ type: 'invalid_args', message: 'key is required for retire action.' });
          if (!memoryStore.retire(key)) return ok(`No memory found for key "${key}".`);
          return ok(
            `Memory "${key}" retired. It is no longer shown, and its file is still on disk.`,
          );
        }
        case 'proposals': {
          const store = new MemoryCandidateStore();
          if (!proposalId) {
            const pending = store.listPending();
            if (pending.length === 0) return ok('No memory suggestions pending.');
            return ok(
              `Pending memory suggestions:\n${pending
                .map((c) => `  (${c.id}) ${describeProposal(c.proposal)}`)
                .join('\n')}`,
            );
          }
          if (!decision)
            return err({
              type: 'invalid_args',
              message: 'decision is required when proposalId is given.',
            });
          // One call. `MemoryCandidateStore.updateStatus` stamps `decidedAt`
          // itself on a rejection — deliberately, and pinned by a test — so
          // routing a decline through `decline()` buys nothing here. An earlier
          // comment claimed otherwise, describing a hazard the applet store has
          // and this one was written not to.
          const done = store.updateStatus(
            proposalId,
            decision === 'declined' ? 'rejected' : 'accepted',
          );
          if (!done) return ok(`No memory suggestion found with id "${proposalId}".`);
          return ok(`Memory suggestion "${proposalId}" marked ${decision}.`);
        }
        case 'delete': {
          if (!key)
            return err({ type: 'invalid_args', message: 'key is required for delete action.' });
          const deleted = memoryStore.deleteMemory(key);
          if (!deleted) return ok(`No memory found for key "${key}".`);
          return ok(`Memory "${key}" deleted.`);
        }
        default:
          return err({ type: 'invalid_args', message: `Unknown action: ${action}` });
      }
    },
    serializeForModel: (r) => (r.status === 'ok' ? r.result : `Error: ${r.error.message}`),
  });
}

/**
 * Creates the session-scoped scratch-pad tool for tracking intermediate work.
 *
 * Scratch notes survive context compression but are discarded when the session ends.
 *
 * @param memoryStore - The backing MemoryStore instance.
 */
export function createScratchTool(
  memoryStore: MemoryStore,
  provenance?: ProvenanceStore,
): BernardTool<ScratchArgs, string> {
  return storeErrorGuard({
    meta: {
      name: 'scratch',
      kind: 'write',
      deterministic: false,
      sideEffect: 'local',
      cacheable: false,
      // scratch.list / scratch.read are pure reads — see memory tool above
      // for the rationale on this predicate (#179 + #144 both consult it).
      isWriteAction: (args) => {
        const action = (args as { action?: string } | undefined)?.action;
        return action === 'write' || action === 'delete';
      },
    },
    description:
      'Session scratch notes for tracking complex task progress, intermediate findings, and working plans. These notes survive context compression but are discarded when the session ends. Use this to keep track of multi-step work within a single session.',
    parameters: SCRATCH_PARAMETERS,
    execute: async ({ action, key, content }) => {
      switch (action) {
        case 'list': {
          const keys = memoryStore.listScratch();
          if (keys.length === 0) return ok('No scratch notes in this session.');
          return ok(`Scratch notes:\n${keys.map((k) => `  - ${k}`).join('\n')}`);
        }
        case 'read': {
          if (!key)
            return err({ type: 'invalid_args', message: 'key is required for read action.' });
          const value = memoryStore.readScratch(key);
          if (value === null) return ok(`No scratch note found for key "${key}".`);
          if (provenance) {
            const id = provenance.add({
              kind: 'memory',
              label: `scratch:${key}`,
              contentPreview: value,
              rawRef: `scratch:${key}`,
            });
            return ok(`[Source: ${id}]\n${value}`);
          }
          return ok(value);
        }
        case 'write': {
          if (!key)
            return err({ type: 'invalid_args', message: 'key is required for write action.' });
          if (!content)
            return err({ type: 'invalid_args', message: 'content is required for write action.' });
          memoryStore.writeScratch(key, content);
          return ok(`Scratch note "${key}" saved.`);
        }
        case 'delete': {
          if (!key)
            return err({ type: 'invalid_args', message: 'key is required for delete action.' });
          const deleted = memoryStore.deleteScratch(key);
          if (!deleted) return ok(`No scratch note found for key "${key}".`);
          return ok(`Scratch note "${key}" deleted.`);
        }
        default:
          return err({ type: 'invalid_args', message: `Unknown action: ${action}` });
      }
    },
    serializeForModel: (r) => (r.status === 'ok' ? r.result : `Error: ${r.error.message}`),
  });
}
