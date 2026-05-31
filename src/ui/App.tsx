import { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { Agent } from '../agent.js';
import type { BernardConfig } from '../config.js';
import type { HistoryStore } from '../history.js';
import type { ProvenanceHistoryStore } from '../provenance-history.js';
import type { MemoryStore } from '../memory.js';
import type { RoutineStore } from '../routines.js';
import type { SpecialistStore } from '../specialists.js';
import type { CandidateStore } from '../specialist-candidates.js';
import type {
  AskUserQuestion,
  AskUserBatchResult,
  ConfirmActionInput,
  BlockActionInput,
  BlockOutcome,
} from '../tools/types.js';
import type {
  MenuEntry,
  MenuItem,
  MenuOptions,
  ValuePromptOptions,
  ValueResult,
} from './menu-types.js';
import { Thread } from './Thread.js';
import { Prompt } from './Prompt.js';
import { Spinner } from './Spinner.js';
import { PlanStrip } from './PlanStrip.js';
import { MenuOverlay } from './overlays/MenuOverlay.js';
import { ConfirmDialog } from './overlays/ConfirmDialog.js';
import { StatusViewer } from './overlays/StatusViewer.js';
import { SourcesViewer } from './overlays/SourcesViewer.js';
import { HelpOverlay } from './overlays/HelpOverlay.js';
import { TextInputOverlay } from './overlays/TextInputOverlay.js';
import { Toast, type ToastVariant } from './Toast.js';
import { persistAgentState } from './save.js';
import { MessageStore } from './message-store.js';
import { setOutputSink } from '../framework/hooks/output-sink.js';
import { getThemeColors } from '../theme.js';

/**
 * Slash commands and overlays need direct access to the same stores the
 * agent's tool layer already uses. Phase D bundles them into one prop so
 * `<App>` doesn't grow a long parallel signature; `src/index.ts` constructs
 * each store once and passes the same references into both `assembleContext`
 * and `<App>`.
 */
export interface AppStores {
  memory: MemoryStore;
  routines: RoutineStore;
  specialists: SpecialistStore;
  candidates: CandidateStore;
}

interface AppProps {
  agent: Agent;
  config: BernardConfig;
  historyStore: HistoryStore;
  provenanceHistoryStore: ProvenanceHistoryStore;
  stores: AppStores;
  /** Per-REPL-session allowlist (#179). Owned by the caller so it survives mount. */
  sessionToolAllowlist: Set<string>;
  /** Called when the user requests exit (Ctrl-C or `/exit`). */
  onExit: () => Promise<void> | void;
  /**
   * Optional alert banner string rendered above the thread until dismissed.
   * Built in `src/index.ts` when `--alert` resumes a session in response to
   * a cron alert.
   */
  alertBanner?: string;
}

type Overlay = 'status' | 'sources' | 'menu' | 'confirm' | 'help' | 'text-input';

interface PendingTextInput {
  options: ValuePromptOptions;
  resolve: (result: ValueResult) => void;
}

interface ToastState {
  message: string;
  variant: ToastVariant;
}

interface PendingMenu {
  entries: MenuEntry[];
  options?: MenuOptions;
  resolve: (result: { cancelled: true } | { cancelled: false; index: number; item: MenuItem }) => void;
}

interface PendingConfirm {
  kind: 'confirm';
  input: ConfirmActionInput;
  resolve: (allowed: boolean, scope: 'once' | 'session') => void;
}

interface PendingBlock {
  kind: 'block';
  input: BlockActionInput;
  resolve: (outcome: BlockOutcome) => void;
}

type PendingDialog = PendingConfirm | PendingBlock;

/**
 * Top-level Ink component. Owns the lifecycle of a Bernard REPL session:
 * turn submission, history versioning, overlay queueing, Shift-Tab cycling,
 * and Esc / Ctrl-C handling.
 *
 * `<App>` is **not** mounted from `src/index.ts` in Phase B — the legacy
 * readline REPL is still the user-visible entry point. The dev preview
 * script at `scripts/preview-ink.mjs` mounts this against an isolated
 * `BERNARD_HOME` for end-to-end validation of the #211 round-2 fixes.
 *
 * Tool callbacks are constructed inside `<App>` and would be wired into the
 * `ToolOptions` passed to `assembleContext` at mount time — see
 * `scripts/preview-ink.mjs` for the wiring example. The contracts match
 * `src/tools/types.ts:58-100` exactly so Phase D can swap them in without
 * touching tool code.
 */
export function App({
  agent,
  config,
  historyStore,
  provenanceHistoryStore,
  stores,
  sessionToolAllowlist: _sessionToolAllowlist,
  onExit,
  alertBanner,
}: AppProps) {
  const { exit } = useApp();
  const [activeOverlay, setActiveOverlay] = useState<Overlay | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [pendingMenu, setPendingMenu] = useState<PendingMenu | null>(null);
  const [pendingDialog, setPendingDialog] = useState<PendingDialog | null>(null);
  const [pendingTextInput, setPendingTextInput] = useState<PendingTextInput | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [bannerVisible, setBannerVisible] = useState<boolean>(!!alertBanner);
  const colors = getThemeColors();

  // Confirm-action session memo: `${toolName}:${stableHash(args)}` → true.
  // Mirrors the legacy REPL's confirm-allow-for-session map.
  const confirmAllowSession = useRef<Map<string, boolean>>(new Map());
  // One-shot guard so onExit runs exactly once whether the user types
  // `/exit` (handleSubmit) or the Ink tree unmounts (useEffect cleanup).
  const exitedRef = useRef(false);
  // Synchronous guard against double-Enter: setBusy schedules a re-render but
  // a second submit can land before Prompt sees `disabled={busy}` flip.
  const submittingRef = useRef(false);
  // Phase C (#214): one MessageStore per <App> lifecycle. Held in a ref so
  // re-renders don't reinstantiate it (which would unsubscribe consumers and
  // drop in-flight events). Registered with the framework's output-sink seam
  // in a mount-time effect; cleared on unmount.
  const messageStoreRef = useRef<MessageStore | null>(null);
  if (messageStoreRef.current === null) {
    messageStoreRef.current = new MessageStore();
  }
  const messageStore = messageStoreRef.current;

  // Closes the active overlay and resolves any pending request as a cancel.
  const closeOverlay = () => {
    if (pendingMenu) {
      pendingMenu.resolve({ cancelled: true });
      setPendingMenu(null);
    }
    if (pendingDialog) {
      if (pendingDialog.kind === 'confirm') pendingDialog.resolve(false, 'once');
      else pendingDialog.resolve('deny');
      setPendingDialog(null);
    }
    if (pendingTextInput) {
      pendingTextInput.resolve({ cancelled: true });
      setPendingTextInput(null);
    }
    setActiveOverlay(null);
  };

  // Gate the App-level useInput so it never fires concurrently with an
  // overlay's own useInput. Modal overlays (menu, confirm, help, text-input)
  // own the keystream; viewer overlays (status, sources) leave it to App so
  // Esc can close them and Shift-Tab can keep cycling.
  const appInputActive =
    activeOverlay === null || activeOverlay === 'status' || activeOverlay === 'sources';

  useInput(
    (_input, key) => {
      // Shift-Tab cycles viewer tabs only while idle.
      if (key.shift && key.tab) {
        if (busy) return;
        setActiveOverlay((curr) => {
          if (curr === null) return 'status';
          if (curr === 'status') return 'sources';
          return null;
        });
        return;
      }
      if (key.escape) {
        if (activeOverlay) {
          closeOverlay();
          return;
        }
        if (busy) {
          agent.abort();
        }
      }
    },
    { isActive: appInputActive },
  );

  // Exit cleanup runs on Ink unmount. The exitedRef guard means `/exit` (which
  // already awaited onExit) doesn't trigger a second invocation.
  useEffect(() => {
    return () => {
      if (exitedRef.current) return;
      exitedRef.current = true;
      void onExit();
    };
  }, [onExit]);

  // Phase C (#214) sink registration. The framework's `getOutputSink()` reads
  // this slot on every step; the legacy readline REPL leaves it null. Cleared
  // on unmount so a test or preview that re-mounts <App> doesn't leak the
  // previous store into the new run.
  useEffect(() => {
    setOutputSink(messageStore);
    return () => setOutputSink(null);
  }, [messageStore]);

  const flashToast = (message: string, variant: ToastVariant = 'info') => {
    setToast({ message, variant });
  };

  const handleSubmit = async (text: string) => {
    // Clear any prior toast on the next submit so flashes don't accumulate.
    if (toast) setToast(null);
    // Dismiss the alert banner once the user starts interacting.
    if (bannerVisible) setBannerVisible(false);

    // ── Simple one-shot slash commands (no overlay, no agent turn) ──
    if (text === '/exit' || text === '/quit') {
      if (exitedRef.current) return;
      exitedRef.current = true;
      await onExit();
      exit();
      return;
    }
    if (text === '/clear') {
      historyStore.clear();
      provenanceHistoryStore.clear();
      agent.clearHistory();
      setHistoryVersion((v) => v + 1);
      flashToast('Conversation history cleared.', 'success');
      return;
    }
    if (text === '/help') {
      setActiveOverlay('help');
      return;
    }
    if (text === '/memory') {
      const keys = stores.memory.listMemory();
      flashToast(
        keys.length === 0
          ? 'No persistent memories stored.'
          : `Persistent memories (${keys.length}): ${keys.join(', ')}`,
      );
      return;
    }
    if (text === '/scratch') {
      const keys = stores.memory.listScratch();
      flashToast(
        keys.length === 0
          ? 'No scratch notes in this session.'
          : `Scratch notes (${keys.length}): ${keys.join(', ')}`,
      );
      return;
    }
    if (text === '/compact') {
      const history = agent.getHistory();
      if (history.length < 2) {
        flashToast('Not enough conversation to compact.', 'warning');
        return;
      }
      setBusy(true);
      try {
        const result = await agent.compactHistory();
        if (!result.compacted) {
          flashToast('Nothing to compact — conversation is already short enough.');
        } else {
          const pct = Math.round(
            ((result.tokensBefore - result.tokensAfter) / result.tokensBefore) * 100,
          );
          flashToast(
            `Compacted: ~${result.tokensBefore} → ~${result.tokensAfter} tokens (${pct}% reduction)`,
            'success',
          );
        }
        persistAgentState({ agent, historyStore, provenanceHistoryStore });
        setHistoryVersion((v) => v + 1);
      } catch (err) {
        flashToast(`Compaction failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      } finally {
        setBusy(false);
      }
      return;
    }

    // ── Agent turn ──
    // Drop a second Enter that arrives before the busy re-render has propagated
    // to <Prompt disabled={busy}>. Without this, two turns can run concurrently.
    if (submittingRef.current) return;
    submittingRef.current = true;
    // Clear the previous turn's stream events so the in-flight
    // <StreamingAssistantMessage> renders only this turn's deltas.
    messageStore.reset();
    setBusy(true);
    try {
      await agent.processInput(text);
    } catch (err) {
      console.error('agent error:', err);
    } finally {
      persistAgentState({ agent, historyStore, provenanceHistoryStore });
      submittingRef.current = false;
      setBusy(false);
      setHistoryVersion((v) => v + 1);
    }
  };

  // Overlay-request helpers — exposed to the script that mounts <App> so it
  // can build the ToolOptions callbacks (confirmFn, confirmActionFn,
  // blockActionFn, askUserFn). The wiring lives in `src/index.ts` (Phase D
  // mounts <App> directly); these are referenced here so React's
  // closure captures them in the same render the props they consume change.
  void requestMenu;
  void requestConfirm;
  void requestBlock;
  void requestAskUser;
  void requestTextInput;

  function requestMenu(
    entries: MenuEntry[],
    options?: MenuOptions,
  ): Promise<{ cancelled: true } | { cancelled: false; index: number; item: MenuItem }> {
    return new Promise((resolve) => {
      setPendingMenu({ entries, options, resolve });
      setActiveOverlay('menu');
    });
  }

  function requestConfirm(input: ConfirmActionInput): Promise<boolean> {
    const key = `${input.toolName}:${stableHash(input.args)}`;
    if (confirmAllowSession.current.get(key)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      setPendingDialog({
        kind: 'confirm',
        input,
        resolve: (allowed, scope) => {
          if (allowed && scope === 'session') confirmAllowSession.current.set(key, true);
          resolve(allowed);
        },
      });
      setActiveOverlay('confirm');
    });
  }

  function requestBlock(input: BlockActionInput): Promise<BlockOutcome> {
    return new Promise((resolve) => {
      setPendingDialog({ kind: 'block', input, resolve });
      setActiveOverlay('confirm');
    });
  }

  function requestTextInput(options: ValuePromptOptions): Promise<ValueResult> {
    return new Promise((resolve) => {
      setPendingTextInput({ options, resolve });
      setActiveOverlay('text-input');
    });
  }

  async function requestAskUser(
    questions: AskUserQuestion[],
    signal?: AbortSignal,
  ): Promise<AskUserBatchResult> {
    const answers: string[] = [];
    for (const q of questions) {
      if (signal?.aborted) return { cancelled: true, answered: answers };
      // Phase B: only choice questions are routed through the overlay.
      // Free-text and `allowOther` need a `<TextInputOverlay>` component
      // which lands in Phase D when the readline path is retired. For now,
      // bail with the partial answers already collected so the agent can see
      // what the user did pick before the unsupported question.
      if (!q.choices || q.choices.length === 0) {
        return { cancelled: true, answered: answers };
      }
      const entries: MenuEntry[] = q.choices.map((c) => ({ label: c }));
      // Intentionally skip allowOther: choosing it would store the literal
      // "Other (free-form)" label instead of the user's actual text. Better
      // to surface only the canned choices until text input lands.
      const result = await requestMenu(entries, { title: q.question });
      if (result.cancelled) return { cancelled: true, answered: answers };
      answers.push(result.item.label);
    }
    return { answers };
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={colors.accent} bold>
          bernard
        </Text>
        <Text dimColor> {config.provider}/{config.model}</Text>
      </Box>
      {bannerVisible && alertBanner && (
        <Box marginTop={1} borderStyle="single" borderColor={colors.warning} paddingX={1}>
          <Text color={colors.warning}>{alertBanner}</Text>
        </Box>
      )}
      <Thread
        key={historyVersion}
        history={agent.getHistory()}
        messageStore={messageStore}
        busy={busy}
      />
      {busy && (
        <Box marginTop={1}>
          <Spinner label="thinking…" />
        </Box>
      )}
      <PlanStrip agent={agent} />
      {toast && <Toast message={toast.message} variant={toast.variant} />}
      <Prompt disabled={busy || activeOverlay !== null} onSubmit={handleSubmit} />
      {activeOverlay === 'status' && (
        <StatusViewer agent={agent} config={config} sessionAllowedCount={_sessionToolAllowlist.size} />
      )}
      {activeOverlay === 'sources' && <SourcesViewer agent={agent} />}
      {activeOverlay === 'menu' && pendingMenu && (
        <MenuOverlay
          entries={pendingMenu.entries}
          options={pendingMenu.options}
          onSelect={(index, item) => {
            pendingMenu.resolve({ cancelled: false, index, item });
            setPendingMenu(null);
            setActiveOverlay(null);
          }}
          onCancel={() => {
            pendingMenu.resolve({ cancelled: true });
            setPendingMenu(null);
            setActiveOverlay(null);
          }}
        />
      )}
      {activeOverlay === 'confirm' && pendingDialog && pendingDialog.kind === 'confirm' && (
        <ConfirmDialog
          kind="confirm"
          toolName={pendingDialog.input.toolName}
          reason={pendingDialog.input.reason}
          risk={pendingDialog.input.risk}
          onResolve={(allowed, scope) => {
            pendingDialog.resolve(allowed, scope);
            setPendingDialog(null);
            setActiveOverlay(null);
          }}
          onCancel={() => {
            pendingDialog.resolve(false, 'once');
            setPendingDialog(null);
            setActiveOverlay(null);
          }}
        />
      )}
      {activeOverlay === 'help' && <HelpOverlay onClose={() => setActiveOverlay(null)} />}
      {activeOverlay === 'text-input' && pendingTextInput && (
        <TextInputOverlay
          options={pendingTextInput.options}
          onResolve={(result) => {
            pendingTextInput.resolve(result);
            setPendingTextInput(null);
            setActiveOverlay(null);
          }}
        />
      )}
      {activeOverlay === 'confirm' && pendingDialog && pendingDialog.kind === 'block' && (
        <ConfirmDialog
          kind="block"
          toolName={pendingDialog.input.toolName}
          reason={pendingDialog.input.reason}
          onResolve={(outcome) => {
            pendingDialog.resolve(outcome);
            setPendingDialog(null);
            setActiveOverlay(null);
          }}
          onCancel={() => {
            pendingDialog.resolve('deny');
            setPendingDialog(null);
            setActiveOverlay(null);
          }}
        />
      )}
    </Box>
  );
}

/**
 * Sort-keys-first JSON so `{a:1,b:2}` and `{b:2,a:1}` produce the same string.
 * Mirrors `stableStringify` at `src/repl.ts:1122` — keeps the confirm-allow
 * session memo stable across re-renders that reshuffle object key order.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

/** djb2 over the stable-JSON form. Matches `stableHash` at `src/repl.ts:1113`. */
function stableHash(value: unknown): string {
  let json: string;
  try {
    json = stableStringify(value);
  } catch {
    json = String(value);
  }
  let h = 5381;
  for (let i = 0; i < json.length; i++) {
    h = ((h << 5) + h + json.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}
