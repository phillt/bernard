import { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { Agent } from '../agent.js';
import type { BernardConfig } from '../config.js';
import type { HistoryStore } from '../history.js';
import type { ProvenanceHistoryStore } from '../provenance-history.js';
import type {
  AskUserQuestion,
  AskUserBatchResult,
  ConfirmActionInput,
  BlockActionInput,
  BlockOutcome,
} from '../tools/types.js';
import type { MenuEntry, MenuItem, MenuOptions } from '../menu.js';
import { Thread } from './Thread.js';
import { Prompt } from './Prompt.js';
import { Spinner } from './Spinner.js';
import { PlanStrip } from './PlanStrip.js';
import { MenuOverlay } from './overlays/MenuOverlay.js';
import { ConfirmDialog } from './overlays/ConfirmDialog.js';
import { StatusViewer } from './overlays/StatusViewer.js';
import { SourcesViewer } from './overlays/SourcesViewer.js';
import { persistAgentState } from './save.js';
import { getThemeColors } from '../theme.js';

interface AppProps {
  agent: Agent;
  config: BernardConfig;
  historyStore: HistoryStore;
  provenanceHistoryStore: ProvenanceHistoryStore;
  /** Per-REPL-session allowlist (#179). Owned by the caller so it survives mount. */
  sessionToolAllowlist: Set<string>;
  /** Called when the user requests exit (Ctrl-C or `/exit`). */
  onExit: () => Promise<void> | void;
}

type Overlay = 'status' | 'sources' | 'menu' | 'confirm';

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
  sessionToolAllowlist: _sessionToolAllowlist,
  onExit,
}: AppProps) {
  const { exit } = useApp();
  const [activeOverlay, setActiveOverlay] = useState<Overlay | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [pendingMenu, setPendingMenu] = useState<PendingMenu | null>(null);
  const [pendingDialog, setPendingDialog] = useState<PendingDialog | null>(null);
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
    setActiveOverlay(null);
  };

  // Gate the App-level useInput so it never fires concurrently with an
  // overlay's own useInput. Modal overlays (menu, confirm) own the keystream;
  // viewer overlays (status, sources) leave it to App so Esc can close them
  // and Shift-Tab can keep cycling.
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

  const handleSubmit = async (text: string) => {
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
      return;
    }
    // Drop a second Enter that arrives before the busy re-render has propagated
    // to <Prompt disabled={busy}>. Without this, two turns can run concurrently.
    if (submittingRef.current) return;
    submittingRef.current = true;
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
  // blockActionFn, askUserFn). Phase D will move this wiring into the mount.
  // For Phase B these are deliberately unused in <App> itself; the contracts
  // they implement (matching src/tools/types.ts) are documented in the
  // ConfirmDialog and MenuOverlay components.
  void requestMenu;
  void requestConfirm;
  void requestBlock;
  void requestAskUser;

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
      <Thread key={historyVersion} history={agent.getHistory()} />
      {busy && (
        <Box marginTop={1}>
          <Spinner label="thinking…" />
        </Box>
      )}
      <PlanStrip agent={agent} />
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
