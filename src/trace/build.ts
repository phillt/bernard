/**
 * Builds a timed tree out of a debug session log: turns → pre-turn passes and
 * dispatches → model calls, tool calls → the dispatches those tool calls
 * started, and so on down.
 *
 * Pure: it takes parsed log rows and returns data, so it is tested against
 * fixture rows and the CLI only reads a file and prints. It relies on the
 * `trace` stamp `debugLog` puts on every row (turn, dispatch, parent dispatch,
 * tool call). Rows from a log written before that stamp existed still parse;
 * they simply cannot be placed and are left out.
 */

export interface LogRow {
  timestamp: string;
  label: string;
  trace?: {
    turnId?: string;
    dispatchId?: string;
    parentDispatchId?: string;
    parentToolCallId?: string;
    toolCallId?: string;
  };
  data?: Record<string, unknown>;
}

export type SpanKind = 'turn' | 'pre-turn' | 'dispatch' | 'model' | 'tool' | 'http';

export interface Span {
  kind: SpanKind;
  /** What it is: a tool name, a model site, a definition id. */
  name: string;
  /** Extra detail for the reader: model id, host, result size. */
  detail?: string;
  start: number;
  end: number;
  /** Tool calls only: time inside the tool, gates and barrier excluded. */
  execMs?: number;
  ok?: boolean;
  children: Span[];
  /** Set when the span never logged its end (crash, hang, or still running). */
  open?: boolean;
  /** Dispatches only: when each step finished, from `step:end`. */
  stepEnds?: number[];
}

export interface Turn extends Span {
  kind: 'turn';
  id: string;
  preview?: string;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function span(kind: SpanKind, name: string, start: number, end: number, detail?: string): Span {
  return { kind, name, start, end, children: [], ...(detail ? { detail } : {}) };
}

/** Builds every turn found in the rows, in order. */
export function buildTraces(rows: readonly LogRow[]): Turn[] {
  const turns = new Map<string, Turn>();
  const dispatches = new Map<
    string,
    Span & { turnId?: string; parentDispatchId?: string; parentToolCallId?: string }
  >();
  // Keyed by a sequence, never by the provider's tool-call id alone: an
  // OpenAI-compatible local server can hand out `call_0` on every step, so the
  // raw id is not unique even within one dispatch. `liveTool` maps
  // dispatch + call id to the most recent call that started under it, which is
  // the one any later event in that scope belongs to.
  const tools = new Map<string, Span & { dispatchId?: string }>();
  const liveTool = new Map<string, string>();
  const toolScope = (dispatchId: string | undefined, callId: string): string =>
    `${dispatchId ?? ''}\u0000${callId}`;
  const toolFor = (dispatchId: string | undefined, callId: string | undefined) =>
    callId === undefined ? undefined : liveTool.get(toolScope(dispatchId, callId));
  let toolSeq = 0;
  const http = new Map<
    string,
    { start: number; dispatchId?: string; toolCallId?: string; host?: string; turnId?: string }
  >();
  const httpSpans: { span: Span; dispatchId?: string; toolCallId?: string }[] = [];
  const preTurn: { span: Span; turnId: string }[] = [];
  let lastT = 0;

  const turnFor = (id: string, t: number): Turn => {
    let turn = turns.get(id);
    if (!turn) {
      turn = { ...span('turn', id, t, t), kind: 'turn', id, children: [] };
      turns.set(id, turn);
    }
    if (t < turn.start) turn.start = t;
    if (t > turn.end) turn.end = t;
    return turn;
  };

  for (const row of rows) {
    const t = Date.parse(row.timestamp);
    if (Number.isNaN(t)) continue;
    lastT = Math.max(lastT, t);
    const d = row.data ?? {};
    const tr = row.trace ?? {};
    if (tr.turnId) turnFor(tr.turnId, t);

    switch (row.label) {
      case 'turn:start':
        if (tr.turnId) {
          const turn = turnFor(tr.turnId, t);
          const preview = str(d.inputPreview);
          if (preview) turn.preview = preview;
        }
        break;
      case 'llm:end': {
        // A standalone call outside any dispatch is a pre-turn pass (resolver,
        // rewriter, recall filter). Inside a dispatch it is already covered.
        if (!tr.turnId || tr.dispatchId) break;
        const ms = num(d.durationMs) ?? 0;
        preTurn.push({
          span: span('pre-turn', str(d.site) ?? 'llm', t - ms, t, str(d.model)),
          turnId: tr.turnId,
        });
        break;
      }
      case 'agent:dispatch:start': {
        const id = str(d.dispatchId) ?? tr.dispatchId;
        if (!id) break;
        const name = str(d.site) ?? str(d.definitionId) ?? 'dispatch';
        dispatches.set(id, {
          ...span('dispatch', name, t, t, str(d.model)),
          open: true,
          turnId: tr.turnId,
          parentDispatchId: tr.parentDispatchId,
          parentToolCallId: toolFor(tr.parentDispatchId, tr.parentToolCallId),
        });
        break;
      }
      case 'step:end': {
        const node = dispatches.get(str(d.dispatchId) ?? tr.dispatchId ?? '');
        if (node) (node.stepEnds ??= []).push(t);
        break;
      }
      case 'agent:dispatch:end':
      case 'agent:dispatch:error': {
        const node = dispatches.get(str(d.dispatchId) ?? tr.dispatchId ?? '');
        if (!node) break;
        node.end = t;
        node.open = false;
        node.ok = row.label === 'agent:dispatch:end';
        break;
      }
      case 'tool:call:start': {
        if (!tr.toolCallId) break;
        const uid = String(toolSeq++);
        liveTool.set(toolScope(tr.dispatchId, tr.toolCallId), uid);
        tools.set(uid, {
          ...span('tool', str(d.tool) ?? 'tool', t, t),
          open: true,
          dispatchId: tr.dispatchId,
        });
        break;
      }
      case 'tool:call:end': {
        const node = tools.get(toolFor(tr.dispatchId, tr.toolCallId) ?? '');
        if (!node) break;
        node.end = t;
        node.open = false;
        node.ok = d.ok === true;
        break;
      }
      case 'tool:execute:end': {
        const node = tools.get(toolFor(tr.dispatchId, tr.toolCallId) ?? '');
        if (!node) break;
        const ms = num(d.durationMs);
        if (ms !== undefined) node.execMs = ms;
        if (d.cached === true) node.detail = 'cached';
        break;
      }
      case 'http:request:start': {
        const reqId = str(d.reqId);
        if (!reqId) break;
        http.set(reqId, {
          start: t,
          dispatchId: tr.dispatchId ?? str(d.dispatchId),
          toolCallId: toolFor(tr.dispatchId, tr.toolCallId),
          host: str(d.host),
        });
        break;
      }
      case 'http:response:end':
      case 'http:request:error': {
        const reqId = str(d.reqId);
        const req = reqId === undefined ? undefined : http.get(reqId);
        if (reqId === undefined || !req) break;
        http.delete(reqId);
        // Inside a tool call it is that tool's own fetch; otherwise, inside a
        // dispatch, it is the model call for a step.
        const kind: SpanKind = req.toolCallId ? 'http' : req.dispatchId ? 'model' : 'http';
        const s = span(
          kind,
          kind === 'model' ? 'model' : (req.host ?? 'http'),
          req.start,
          t,
          req.host,
        );
        if (row.label === 'http:request:error') s.ok = false;
        httpSpans.push({
          span: s,
          dispatchId: req.dispatchId,
          toolCallId: req.toolCallId,
        });
        break;
      }
    }
  }

  // Anything still open ran to the end of the log: a hang, a crash, or a
  // session that is still going. Shown, and marked, rather than dropped.
  for (const node of [...dispatches.values(), ...tools.values()]) {
    if (node.open) node.end = lastT;
  }

  for (const { span: s, dispatchId, toolCallId } of httpSpans) {
    const parent =
      (toolCallId ? tools.get(toolCallId) : undefined) ??
      (dispatchId ? dispatches.get(dispatchId) : undefined);
    // A request in neither is a pre-turn pass's, already shown by its
    // `llm:end`, or startup housekeeping that belongs to no turn.
    if (parent) parent.children.push(s);
  }
  for (const node of tools.values()) {
    const parent = node.dispatchId ? dispatches.get(node.dispatchId) : undefined;
    if (parent) parent.children.push(node);
  }
  for (const node of dispatches.values()) {
    const viaTool = node.parentToolCallId ? tools.get(node.parentToolCallId) : undefined;
    const viaDispatch = node.parentDispatchId ? dispatches.get(node.parentDispatchId) : undefined;
    const parent = viaTool ?? viaDispatch;
    if (parent) parent.children.push(node);
    else if (node.turnId) turnFor(node.turnId, node.start).children.push(node);
  }
  for (const { span: s, turnId } of preTurn) turnFor(turnId, s.start).children.push(s);

  const sortTree = (s: Span): void => {
    s.children.sort((a, b) => a.start - b.start || a.end - b.end);
    for (const c of s.children) sortTree(c);
  };
  const out = [...turns.values()].sort((a, b) => a.start - b.start);
  for (const turn of out) {
    for (const c of turn.children) turn.end = Math.max(turn.end, c.end);
    sortTree(turn);
  }
  return out;
}

/** Where a turn's time went, for the summary under the tree. */
export interface TurnSummary {
  wallMs: number;
  preTurnMs: number;
  /** Model round trips, summed across every dispatch. */
  modelMs: number;
  modelCalls: number;
  /** Time inside tools, by tool name, summed over calls. */
  toolMs: Map<string, { ms: number; calls: number }>;
  /** Time tool calls spent waiting on gates or the write barrier. */
  waitMs: number;
  /** The slowest leaf spans: model calls, tool executions, pre-turn passes. */
  slowest: Span[];
  /**
   * Steps whose several tool calls ran ONE AFTER ANOTHER rather than together:
   * the parallelism already available and not taken. Tools in one step are
   * started together by the SDK, so a serial run inside one dispatch, with no
   * model call between, means something held them apart.
   */
  serialGroups: { dispatch: string; tools: string[]; serialMs: number; couldBeMs: number }[];
  /** Dispatches by number of model round trips — each one is a serial wait. */
  roundTrips: { dispatch: string; calls: number; modelMs: number }[];
}

const dur = (s: Span): number => Math.max(0, s.end - s.start);

export function summarizeTurn(turn: Turn): TurnSummary {
  const toolMs = new Map<string, { ms: number; calls: number }>();
  const leaves: Span[] = [];
  const serialGroups: TurnSummary['serialGroups'] = [];
  const roundTrips: TurnSummary['roundTrips'] = [];
  let preTurnMs = 0;
  let modelMs = 0;
  let modelCalls = 0;
  let waitMs = 0;

  const walk = (s: Span): void => {
    if (s.kind === 'pre-turn') {
      preTurnMs += dur(s);
      leaves.push(s);
    }
    if (s.kind === 'model') {
      modelMs += dur(s);
      modelCalls++;
      leaves.push(s);
    }
    if (s.kind === 'tool') {
      const exec = s.execMs ?? dur(s);
      const e = toolMs.get(s.name) ?? { ms: 0, calls: 0 };
      e.ms += exec;
      e.calls++;
      toolMs.set(s.name, e);
      waitMs += Math.max(0, dur(s) - exec);
      // A tool that contains a dispatch is not a leaf: its children carry the time.
      if (!s.children.some((c) => c.kind === 'dispatch'))
        leaves.push({ ...s, end: s.start + exec });
    }
    if (s.kind === 'dispatch') {
      const models = s.children.filter((c) => c.kind === 'model');
      roundTrips.push({
        dispatch: `${s.name}${s.detail ? ` (${s.detail})` : ''}`,
        calls: models.length,
        modelMs: models.reduce((a, m) => a + dur(m), 0),
      });
      // Serial work inside one step. A step is the model call and the tool
      // calls it asked for; the step's window ends at its `step:end`. Only
      // tools that started AFTER the model call finished count: a streaming
      // dispatch starts each tool as the model writes it, so their order there
      // is the model's, not something holding them apart.
      const ends = s.stepEnds ?? [];
      let from = s.start;
      let first = true;
      for (const end of [...ends, Number.POSITIVE_INFINITY]) {
        // Half-open after the first step, so a child starting exactly on a
        // `step:end` belongs to that step and is not counted again in the next.
        const lo = from;
        const inStep = s.children.filter(
          (c) => (first ? c.start >= lo : c.start > lo) && c.start <= end,
        );
        from = end;
        first = false;
        const model = inStep.find((c) => c.kind === 'model');
        const after = model ? model.end - 5 : Number.NEGATIVE_INFINITY;
        const run = inStep.filter((c) => c.kind === 'tool' && c.start >= after);
        if (run.length < 2) continue;
        // Judged on EXECUTION windows, not call windows: every call in a step
        // starts together, and the write barrier holds a read back inside its
        // call — so call windows overlap even when the work did not.
        const execStart = (c: Span): number => c.end - (c.execMs ?? dur(c));
        const byExec = [...run].sort((x, y) => execStart(x) - execStart(y));
        const serial = byExec.every((c, i) => i === 0 || execStart(c) >= byExec[i - 1].end - 1);
        if (serial) {
          serialGroups.push({
            dispatch: s.name,
            tools: byExec.map((c) => c.name),
            serialMs: byExec[byExec.length - 1].end - execStart(byExec[0]),
            couldBeMs: Math.max(...byExec.map((c) => c.execMs ?? dur(c))),
          });
        }
      }
    }
    for (const c of s.children) walk(c);
  };
  walk(turn);

  leaves.sort((a, b) => dur(b) - dur(a));
  roundTrips.sort((a, b) => b.modelMs - a.modelMs);
  return {
    wallMs: dur(turn),
    preTurnMs,
    modelMs,
    modelCalls,
    toolMs,
    waitMs,
    slowest: leaves.slice(0, 10),
    serialGroups,
    roundTrips,
  };
}
