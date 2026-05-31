import { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { Agent } from '../agent.js';
import type { BernardConfig } from '../config.js';
import {
  savePreferences,
  getDefaultModel,
  getAvailableProviders,
  PROVIDER_MODELS,
  saveProviderKey,
} from '../config.js';
import {
  loadCustomProviders,
  saveCustomProvider,
  rememberCustomModel,
  validateProviderName,
  validateBaseURL,
  SUPPORTED_SDKS,
} from '../custom-providers.js';
import type { SupportedSdk } from '../providers/types.js';
import {
  THEMES,
  getThemeKeys,
  getActiveThemeKey,
  setTheme,
  getThemeColors,
} from '../theme.js';
import type { HistoryStore } from '../history.js';
import type { ProvenanceHistoryStore } from '../provenance-history.js';
import type { MemoryStore } from '../memory.js';
import type { RoutineStore } from '../routines.js';
import type { SpecialistStore } from '../specialists.js';
import type { CandidateStore } from '../specialist-candidates.js';
import type { RAGStore, RAGSearchResult } from '../rag.js';
import type { MCPManager } from '../mcp.js';
import { CronStore } from '../cron/store.js';
import { isDaemonRunning } from '../cron/client.js';
import { getDomain, getDomainIds } from '../domains.js';
import { MCP_CONFIG_PATH } from '../paths.js';
import { interactiveUpdate } from '../update.js';
import { getBuiltinSpecialistIds } from '../specialists.js';
import { buildCandidateContextBlock } from '../candidate-bootstrap.js';
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
import { InfoOverlay } from './overlays/InfoOverlay.js';
import { Toast, type ToastVariant } from './Toast.js';
import { persistAgentState } from './save.js';
import { MessageStore } from './message-store.js';
import { setOutputSink } from '../framework/hooks/output-sink.js';

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
  /** Optional — only present when `config.ragEnabled === true`. */
  rag?: RAGStore;
  /** Optional — only present when MCP servers are configured. */
  mcp?: MCPManager;
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

type Overlay =
  | 'status'
  | 'sources'
  | 'menu'
  | 'confirm'
  | 'help'
  | 'text-input'
  | 'info';

interface PendingTextInput {
  options: ValuePromptOptions;
  resolve: (result: ValueResult) => void;
}

interface PendingInfo {
  title: string;
  lines: { text: string; dim?: boolean; bold?: boolean }[];
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
  const [pendingInfo, setPendingInfo] = useState<PendingInfo | null>(null);
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
    if (pendingInfo) setPendingInfo(null);
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

  const showInfo = (title: string, lines: PendingInfo['lines']) => {
    setPendingInfo({ title, lines });
    setActiveOverlay('info');
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

    if (text === '/policy') {
      const last = agent.getLastPolicyDecision();
      if (!last) {
        flashToast('No policy decision yet — send a message first.');
        return;
      }
      const lines: PendingInfo['lines'] = [
        { text: 'Decision:', bold: true },
        ...JSON.stringify(last.decision, null, 2)
          .split('\n')
          .map((l) => ({ text: l })),
        { text: '' },
        { text: 'Reason codes:', bold: true },
        ...Object.entries(last.reasons).map(([k, r]) => ({ text: `  ${k}: ${r}` })),
      ];
      showInfo('Last policy decision', lines);
      return;
    }

    if (text === '/mcp') {
      if (!stores.mcp) {
        flashToast(`No MCP servers configured. Add servers to ${MCP_CONFIG_PATH}`);
        return;
      }
      const statuses = stores.mcp.getServerStatuses();
      if (statuses.length === 0) {
        flashToast(`No MCP servers configured. Add servers to ${MCP_CONFIG_PATH}`);
        return;
      }
      const lines: PendingInfo['lines'] = statuses.map((s) =>
        s.connected
          ? { text: `  ✓ ${s.name} (${s.toolCount} tools)` }
          : { text: `  ✗ ${s.name} — ${s.error}` },
      );
      const toolNames = Object.keys(stores.mcp.getTools());
      if (toolNames.length > 0) {
        lines.push({ text: '' });
        lines.push({ text: `MCP tools: ${toolNames.join(', ')}`, dim: true });
      }
      showInfo('MCP servers', lines);
      return;
    }

    if (text === '/cron') {
      const store = new CronStore();
      const jobs = store.loadJobs();
      const running = isDaemonRunning();
      const lines: PendingInfo['lines'] = [
        { text: `Daemon: ${running ? 'running' : 'stopped'}`, bold: true },
      ];
      if (jobs.length === 0) {
        lines.push({ text: 'No cron jobs configured.', dim: true });
      } else {
        lines.push({ text: '' });
        lines.push({ text: `Jobs (${jobs.length}):`, bold: true });
        for (const job of jobs) {
          const status = job.enabled ? 'enabled' : 'disabled';
          const lastRun = job.lastRun
            ? `last: ${new Date(job.lastRun).toLocaleString()} (${job.lastRunStatus || 'unknown'})`
            : 'never run';
          lines.push({ text: `  ${job.name} [${status}] — ${job.schedule} — ${lastRun}` });
          lines.push({ text: `    ID: ${job.id}`, dim: true });
        }
        const alerts = store.listAlerts().filter((a) => !a.acknowledged);
        if (alerts.length > 0) {
          lines.push({ text: '' });
          lines.push({ text: `Unacknowledged alerts (${alerts.length}):`, bold: true });
          for (const alert of alerts.slice(0, 5)) {
            lines.push({
              text: `  [${new Date(alert.timestamp).toLocaleString()}] ${alert.jobName}: ${alert.message}`,
            });
          }
        }
      }
      showInfo('Cron', lines);
      return;
    }

    if (text === '/rag') {
      if (!stores.rag) {
        flashToast('RAG is disabled. Set BERNARD_RAG_ENABLED=true (default) to enable.');
        return;
      }
      const count = stores.rag.count();
      const lines: PendingInfo['lines'] = [{ text: `Total memories: ${count}`, bold: true }];
      if (count === 0) {
        lines.push({
          text: 'No RAG memories yet. Memories are extracted automatically during context compression.',
          dim: true,
        });
      } else {
        const counts = stores.rag.countByDomain();
        const knownDomains = new Set(getDomainIds());
        lines.push({ text: '' });
        lines.push({ text: 'By domain:', bold: true });
        for (const domainId of knownDomains) {
          const domainCount = counts[domainId] ?? 0;
          if (domainCount > 0) {
            const domain = getDomain(domainId);
            lines.push({ text: `  ${domain.name}: ${domainCount}` });
          }
        }
        for (const [domainId, domainCount] of Object.entries(counts)) {
          if (!knownDomains.has(domainId)) {
            lines.push({ text: `  ${domainId}: ${domainCount}` });
          }
        }
        const facts = stores.rag.listFacts();
        const recent = facts.slice(-10);
        lines.push({ text: '' });
        lines.push({ text: 'Most recent (up to 10):', bold: true });
        for (const f of recent) lines.push({ text: `  ${f}`, dim: true });
      }
      showInfo('RAG memories', lines);
      return;
    }

    if (text === '/facts') {
      const results = agent.getLastRAGResults();
      if (results.length === 0) {
        flashToast('No RAG facts in current context window.');
        return;
      }
      const lines: PendingInfo['lines'] = [];
      const byDomain = new Map<string, RAGSearchResult[]>();
      for (const r of results) {
        if (!byDomain.has(r.domain)) byDomain.set(r.domain, []);
        byDomain.get(r.domain)!.push(r);
      }
      for (const [domainId, items] of byDomain) {
        const domain = getDomain(domainId);
        lines.push({ text: `### ${domain.name}`, bold: true });
        for (const item of items) {
          const pct = Math.round(item.similarity * 100);
          lines.push({ text: `  - (${pct}%) ${item.fact}` });
        }
        lines.push({ text: '' });
      }
      showInfo(`Recalled Context (${results.length} facts)`, lines);
      return;
    }

    if (text === '/update') {
      flashToast('Checking for updates…');
      try {
        await interactiveUpdate();
        flashToast('Update check complete.', 'success');
      } catch (err) {
        flashToast(
          `Update check failed: ${err instanceof Error ? err.message : String(err)}`,
          'error',
        );
      }
      return;
    }

    if (text === '/theme') {
      const allKeys = getThemeKeys();
      const currentKey = getActiveThemeKey();
      const regularKeys = allKeys.filter((k) => k !== 'high-contrast' && k !== 'colorblind');
      const a11yKeys = allKeys.filter((k) => k === 'high-contrast' || k === 'colorblind');
      const entries: MenuEntry[] = [
        ...regularKeys.map((k) => ({
          label: THEMES[k].name,
          active: k === currentKey,
          value: k,
        })),
        { type: 'section' as const, title: 'Accessibility:' },
        ...a11yKeys.map((k) => ({
          label: THEMES[k].name,
          active: k === currentKey,
          value: k,
        })),
      ];
      const result = await requestMenu(entries, {
        title: `Themes — current: ${THEMES[currentKey].name}`,
      });
      if (!result.cancelled) {
        const chosen = result.item.value as string;
        setTheme(chosen);
        config.theme = chosen;
        savePreferences({
          provider: config.provider,
          model: config.model,
          maxTokens: config.maxTokens,
          shellTimeout: config.shellTimeout,
          tokenWindow: config.tokenWindow,
          theme: chosen,
        });
        flashToast(`Switched to ${THEMES[chosen].name} theme.`, 'success');
      }
      return;
    }

    if (text === '/provider') {
      const available = getAvailableProviders(config);
      const customProviders = config.customProviders ?? {};
      const builtinAvailable = available.filter((p) => !customProviders[p]);
      const customAvailable = available.filter((p) => customProviders[p]);
      const entries: MenuEntry[] = [];
      for (const p of builtinAvailable) entries.push({ label: p, value: p });
      if (customAvailable.length > 0) {
        entries.push({ type: 'section', title: 'Custom:' });
        for (const p of customAvailable) {
          const entry = customProviders[p];
          entries.push({
            label: p,
            annotation: `(${entry.sdk} → ${entry.baseURL})`,
            value: p,
          });
        }
      }
      entries.push({ type: 'section', title: '' });
      entries.push({ label: '+ Add custom provider…', value: '__add__' });
      const result = await requestMenu(entries, {
        title: `Providers — current: ${config.provider} (${config.model})`,
      });
      if (result.cancelled) return;
      const value = result.item.value as string;
      if (value === '__add__') {
        const added = await runAddProviderInk(requestMenu, requestTextInput, flashToast);
        if (added) {
          config.customProviders = { ...customProviders, [added.entry.name]: added.entry };
          config.apiKeys = { ...(config.apiKeys ?? {}), [added.entry.name]: added.apiKey };
          config.provider = added.entry.name;
          config.model = added.entry.defaultModel;
          config.providerBaseUrl = undefined;
          savePreferences({
            provider: config.provider,
            model: config.model,
            maxTokens: config.maxTokens,
            shellTimeout: config.shellTimeout,
            tokenWindow: config.tokenWindow,
            theme: config.theme,
          });
          flashToast(
            `Added and switched to ${added.entry.name} (${added.entry.defaultModel})`,
            'success',
          );
        }
      } else {
        config.provider = value;
        config.model = getDefaultModel(config.provider, customProviders);
        config.providerBaseUrl = undefined;
        savePreferences({
          provider: config.provider,
          model: config.model,
          maxTokens: config.maxTokens,
          shellTimeout: config.shellTimeout,
          tokenWindow: config.tokenWindow,
          theme: config.theme,
        });
        flashToast(`Switched to ${config.provider} (${config.model})`, 'success');
      }
      return;
    }

    if (text === '/model') {
      const customProviders = config.customProviders ?? {};
      const customEntry = customProviders[config.provider];
      const models = customEntry ? customEntry.models : PROVIDER_MODELS[config.provider];
      if (!models || models.length === 0) {
        flashToast(`No models listed for provider "${config.provider}".`, 'error');
        return;
      }
      const entries: MenuEntry[] = models.map((m) => ({ label: m, value: m }));
      if (customEntry) {
        entries.push({ type: 'section', title: '' });
        entries.push({ label: '+ Type a new model name…', value: '__free__' });
      }
      const result = await requestMenu(entries, {
        title: `Models — current: ${config.provider} / ${config.model}`,
      });
      if (result.cancelled) return;
      const value = result.item.value as string;
      let chosenModel: string | null = null;
      if (value === '__free__' && customEntry) {
        const valueResult = await requestTextInput({ label: 'Model name' });
        if (!valueResult.cancelled && valueResult.raw) {
          rememberCustomModel(config.provider, valueResult.raw);
          config.customProviders = loadCustomProviders();
          chosenModel = valueResult.raw;
        }
      } else {
        chosenModel = value;
      }
      if (chosenModel) {
        config.model = chosenModel;
        savePreferences({
          provider: config.provider,
          model: config.model,
          maxTokens: config.maxTokens,
          shellTimeout: config.shellTimeout,
          tokenWindow: config.tokenWindow,
          theme: config.theme,
        });
        flashToast(`Switched to ${config.model}`, 'success');
      }
      return;
    }

    if (text === '/routines') {
      const all = stores.routines.list();
      if (all.length === 0) {
        flashToast(
          'No routines saved. Teach me a workflow and I can save it as a routine.',
        );
        return;
      }
      const tasks = all.filter((r) => r.id.startsWith('task-'));
      const routines = all.filter((r) => !r.id.startsWith('task-'));
      const lines: PendingInfo['lines'] = [];
      if (tasks.length > 0) {
        lines.push({
          text: `Tasks (${tasks.length}) — single-step, structured output:`,
          bold: true,
        });
        for (const r of tasks) {
          lines.push({ text: `  /${r.id} — ${r.name}: ${r.description}` });
        }
      }
      if (routines.length > 0) {
        if (tasks.length > 0) lines.push({ text: '' });
        lines.push({
          text: `Routines (${routines.length}) — multi-step workflows:`,
          bold: true,
        });
        for (const r of routines) {
          lines.push({ text: `  /${r.id} — ${r.name}: ${r.description}` });
        }
      }
      showInfo('Routines', lines);
      return;
    }

    if (text === '/specialists') {
      const all = stores.specialists.list();
      if (all.length === 0) {
        flashToast(
          'No specialist agents defined yet. Ask me to create one or use /create-specialist.',
        );
        return;
      }
      const builtinIds = getBuiltinSpecialistIds();
      const bundled = all.filter((s) => builtinIds.has(s.id));
      const user = all.filter((s) => !builtinIds.has(s.id));
      const lines: PendingInfo['lines'] = [];
      if (bundled.length > 0) {
        lines.push({ text: 'Bundled:', bold: true });
        for (const s of bundled) {
          lines.push({ text: `  ${s.id} — ${s.name}: ${s.description}` });
        }
      }
      if (user.length > 0) {
        if (bundled.length > 0) lines.push({ text: '' });
        lines.push({ text: 'Yours:', bold: true });
        for (const s of user) {
          lines.push({ text: `  ${s.id} — ${s.name}: ${s.description}` });
        }
      }
      showInfo(`Specialists (${all.length})`, lines);
      return;
    }

    if (text === '/candidates') {
      const pending = stores.candidates.listPending();
      if (pending.length === 0) {
        flashToast('No pending specialist suggestions.');
        return;
      }
      const lines: PendingInfo['lines'] = [];
      for (const c of pending) {
        const pct = Math.round(c.confidence * 100);
        const date = new Date(c.detectedAt).toLocaleDateString();
        lines.push({ text: `${c.name} (${c.draftId})`, bold: true });
        lines.push({ text: `  ${c.description}`, dim: true });
        lines.push({ text: `  Confidence: ${pct}% | Detected: ${date}`, dim: true });
        lines.push({ text: `  Reasoning: ${c.reasoning}`, dim: true });
        lines.push({ text: '' });
        stores.candidates.acknowledge(c.id);
      }
      lines.push({
        text: 'To accept or reject, tell Bernard conversationally (e.g., "accept the code-review candidate").',
        dim: true,
      });
      agent.setAlertContext(buildCandidateContextBlock(pending));
      showInfo(`Specialist Suggestions (${pending.length})`, lines);
      return;
    }

    if (text === '/create-routine' || text === '/create-task' || text === '/create-specialist') {
      const seed = CREATE_SEED_PROMPTS[text];
      await runAgentTurn(seed);
      return;
    }

    await runAgentTurn(text);
  };

  async function runAgentTurn(input: string): Promise<void> {
    // Drop a second Enter that arrives before the busy re-render has propagated
    // to <Prompt disabled={busy}>. Without this, two turns can run concurrently.
    if (submittingRef.current) return;
    submittingRef.current = true;
    // Clear the previous turn's stream events so the in-flight
    // <StreamingAssistantMessage> renders only this turn's deltas.
    messageStore.reset();
    setBusy(true);
    try {
      await agent.processInput(input);
    } catch (err) {
      console.error('agent error:', err);
    } finally {
      persistAgentState({ agent, historyStore, provenanceHistoryStore });
      submittingRef.current = false;
      setBusy(false);
      setHistoryVersion((v) => v + 1);
    }
  }

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
      {activeOverlay === 'info' && pendingInfo && (
        <InfoOverlay
          title={pendingInfo.title}
          lines={pendingInfo.lines}
          onClose={() => {
            setPendingInfo(null);
            setActiveOverlay(null);
          }}
        />
      )}
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

const CREATE_SEED_PROMPTS: Record<string, string> = {
  '/create-routine': `The user wants to create a new routine interactively. Guide them through the process:

1. Ask what workflow they want to save (what task, what steps, what's the goal)
2. Ask clarifying questions if the instructions are vague or incomplete — e.g., what should happen on errors, are there optional steps, what tools/commands are involved
3. Once you have enough information, draft the routine by optimizing their raw instructions into a well-structured routine using these prompting best practices:
   - **Clarity**: use simple, literal language; define terms; state fallback behavior
   - **Specificity**: specify exact commands, file paths, expected outputs, and decision rules
   - **Structure**: organize steps logically with clear numbering and section headers
   - **Constraints**: encode "never do X" + "do Y instead" at boundaries; keep constraints minimal but explicit
   - **Robustness**: include error handling guidance, edge cases, and "if X then Y" decision points
   - **Conciseness**: be token-efficient — no filler, no redundant instructions
4. Present the draft routine (id, name, description, content) to the user for review
5. Make any requested changes
6. Use the routine tool to save it once the user approves

Remember: routine content should be written as clear instructions that Bernard can follow. Think of it like writing a mini system prompt — specific, structured, and actionable.`,
  '/create-task': `The user wants to create a new saved task interactively. Saved tasks are routines whose ID is prefixed with "task-", but they execute differently from routines: tasks run in a single-step execution model (1 LLM call + tool use → structured JSON output). Guide them through the process:

1. Ask what task they want to save (what's the goal, what output is expected)
2. Ask clarifying questions if needed — e.g., what should happen on errors, what tools/commands are involved, what the expected output format is
3. Once you have enough information, draft the task using these guidelines:
   - **Single-step**: task content must be achievable in a single LLM call with tool use. If the task needs multiple sequential steps, it should be a routine that chains tasks instead.
   - **Explicit commands**: specify exact commands, file paths, and expected output format
   - **Success/error criteria**: define what constitutes success and how errors should be reported
   - **Output format**: specify what the structured JSON output should contain
   - **Conciseness**: be token-efficient — no filler, no redundant instructions
4. Present the draft task (id, name, description, content) to the user for review
5. Make any requested changes
6. Use the routine tool to save it once the user approves

IMPORTANT: The routine ID MUST start with "task-". When drafting, generate an ID like "task-deploy-staging" or "task-run-tests". If the user suggests an ID without the prefix, prepend "task-" automatically. The user will invoke this task with /task-{name} in the REPL.

Remember: task content should describe a single atomic operation with clear success criteria. Unlike routines (multi-step workflows), tasks must complete in one step.`,
  '/create-specialist': `The user wants to create a new specialist agent interactively. Guide them through the process:

1. Ask what domain or recurring task pattern the specialist covers (e.g., email triage, code review, data analysis)
2. Ask about behavioral preferences — how should the specialist approach work? What tone, priorities, output formats, or decision rules should it follow?
3. Ask about specific guidelines — are there things it should always or never do?
4. Once you have enough information, draft the specialist by creating:
   - **id**: kebab-case slug (e.g., "email-triage")
   - **name**: display name (e.g., "Email Triage Specialist")
   - **description**: one-line summary
   - **systemPrompt**: the specialist's persona and behavioral instructions (this is the core — write it like a focused system prompt)
   - **guidelines**: short behavioral rules as a list of strings
5. Present the draft to the user for review
6. Make any requested changes
7. Use the specialist tool to save it once the user approves

Remember: the systemPrompt should read like a persona definition — who this specialist is, what they care about, how they work. Guidelines are individual rules that can be added/removed independently.`,
};

/**
 * 5-step add-custom-provider sequence: pick SDK → name → URL → model → key,
 * then `saveCustomProvider` + `saveProviderKey`. Cancellation at any step
 * (Esc) returns null without persisting.
 *
 * Phase D replacement for `runAddProviderWizard` in the deleted readline
 * REPL. Same validation rules (`validateProviderName`, `validateBaseURL`,
 * non-empty model and key) so the on-disk shape is identical.
 */
async function runAddProviderInk(
  requestMenu: (entries: MenuEntry[], options?: MenuOptions) =>
    Promise<{ cancelled: true } | { cancelled: false; index: number; item: MenuItem }>,
  requestTextInput: (options: ValuePromptOptions) => Promise<ValueResult>,
  flashToast: (message: string, variant?: ToastVariant) => void,
): Promise<{ entry: ReturnType<typeof saveCustomProvider>; apiKey: string } | null> {
  const sdkEntries: MenuEntry[] = SUPPORTED_SDKS.map((s) => ({ label: s, value: s }));
  const sdkResult = await requestMenu(sdkEntries, { title: 'Which SDK to use?' });
  if (sdkResult.cancelled) return null;
  const sdk = sdkResult.item.value as SupportedSdk;

  const nameResult = await requestTextInput({
    label: 'Provider name (lowercase, e.g. "ollama")',
  });
  if (nameResult.cancelled) return null;
  const name = nameResult.raw;
  const nameErr = validateProviderName(name);
  if (nameErr) {
    flashToast(nameErr, 'error');
    return null;
  }

  const urlResult = await requestTextInput({
    label: 'Base URL (e.g. http://localhost:11434/v1)',
  });
  if (urlResult.cancelled) return null;
  const baseURL = urlResult.raw;
  const urlErr = validateBaseURL(baseURL);
  if (urlErr) {
    flashToast(urlErr, 'error');
    return null;
  }

  const modelResult = await requestTextInput({ label: 'Default model name' });
  if (modelResult.cancelled) return null;
  const defaultModel = modelResult.raw;
  if (!defaultModel) {
    flashToast('Default model cannot be empty.', 'error');
    return null;
  }

  const keyResult = await requestTextInput({
    label: 'API key (any non-empty token; some local servers ignore the value)',
  });
  if (keyResult.cancelled) return null;
  const apiKey = keyResult.raw;
  if (!apiKey) {
    flashToast('API key cannot be empty.', 'error');
    return null;
  }

  try {
    const entry = saveCustomProvider({ name, sdk, baseURL, defaultModel });
    saveProviderKey(name, apiKey);
    return { entry, apiKey };
  } catch (err: unknown) {
    flashToast(err instanceof Error ? err.message : String(err), 'error');
    return null;
  }
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
