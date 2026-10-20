import type { Span, Turn, TurnSummary } from './build.js';

/** `850 ms`, `4.7 s`, `2m 05s` — short enough to sit in a column. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

const dur = (s: Span): number => Math.max(0, s.end - s.start);

function label(s: Span): string {
  switch (s.kind) {
    case 'pre-turn':
      return `pre-turn ${s.name}`;
    case 'dispatch': {
      const steps = s.stepEnds?.length;
      const bits = [s.detail, steps ? `${steps} step${steps === 1 ? '' : 's'}` : undefined].filter(
        Boolean,
      );
      return `◆ ${s.name}${bits.length ? ` (${bits.join(', ')})` : ''}`;
    }
    case 'model':
      return 'model call';
    case 'tool': {
      const wait = s.execMs !== undefined ? dur(s) - s.execMs : 0;
      const bits = [
        s.detail,
        wait >= 50 ? `waited ${formatMs(wait)}` : undefined,
        s.ok === false ? 'failed' : undefined,
      ].filter(Boolean);
      return `${s.name}${bits.length ? `  [${bits.join(', ')}]` : ''}`;
    }
    case 'http':
      return `http ${s.detail ?? s.name}`;
    default:
      return s.name;
  }
}

export interface RenderOptions {
  /** Hide leaf spans shorter than this. Dispatches and tools with children are always shown. */
  minMs?: number;
}

/**
 * The tree, one span per row: offset from the turn's start, duration, and what
 * it was. Siblings that overlap in time are marked `∥` — they ran at once.
 */
export function renderTurn(turn: Turn, opts: RenderOptions = {}): string[] {
  const minMs = opts.minMs ?? 0;
  const lines: string[] = [];
  const head = `${turn.id}  ${formatMs(dur(turn))}${turn.preview ? `  "${turn.preview}"` : ''}`;
  lines.push(head);

  const walk = (spans: Span[], prefix: string): void => {
    const shown = spans.filter(
      (s) => s.children.length > 0 || s.kind === 'dispatch' || dur(s) >= minMs,
    );
    shown.forEach((s, i) => {
      const last = i === shown.length - 1;
      const overlaps = shown.some(
        (o) =>
          o !== s && o.kind !== 'model' && s.kind !== 'model' && o.start < s.end && s.start < o.end,
      );
      const offset = `+${formatMs(s.start - turn.start)}`.padStart(9);
      const time = formatMs(
        s.kind === 'tool' && s.execMs !== undefined ? s.execMs : dur(s),
      ).padStart(8);
      const mark = overlaps ? '∥ ' : '';
      const open = s.open ? '  (never finished)' : '';
      lines.push(`${offset} ${time}  ${prefix}${last ? '└ ' : '├ '}${mark}${label(s)}${open}`);
      walk(s.children, prefix + (last ? '  ' : '│ '));
    });
  };
  walk(turn.children, '');
  return lines;
}

/** Where the time went, and what could have run at once. */
export function renderSummary(sum: TurnSummary): string[] {
  const lines: string[] = [];
  const pct = (ms: number): string =>
    sum.wallMs > 0 ? ` (${Math.round((ms / sum.wallMs) * 100)}%)` : '';
  lines.push(`  wall ${formatMs(sum.wallMs)}`);
  lines.push(`  pre-turn passes   ${formatMs(sum.preTurnMs)}${pct(sum.preTurnMs)}`);
  lines.push(
    `  model calls       ${formatMs(sum.modelMs)} over ${sum.modelCalls} round trip${sum.modelCalls === 1 ? '' : 's'}${pct(sum.modelMs)}`,
  );
  const tools = [...sum.toolMs.entries()].sort((a, b) => b[1].ms - a[1].ms);
  const toolTotal = tools.reduce((a, [, v]) => a + v.ms, 0);
  lines.push(`  tool execution    ${formatMs(toolTotal)}${pct(toolTotal)}`);
  for (const [name, v] of tools.slice(0, 8)) {
    lines.push(`    ${formatMs(v.ms).padStart(8)}  ${name}${v.calls > 1 ? ` ×${v.calls}` : ''}`);
  }
  if (sum.waitMs >= 50) lines.push(`  waiting on gates  ${formatMs(sum.waitMs)}${pct(sum.waitMs)}`);
  lines.push('  (sums can exceed wall: nested and parallel work is counted where it ran)');

  if (sum.slowest.length > 0) {
    lines.push('', '  slowest');
    for (const s of sum.slowest.slice(0, 6)) {
      const ms = s.kind === 'tool' && s.execMs !== undefined ? s.execMs : dur(s);
      lines.push(`    ${formatMs(ms).padStart(8)}  ${label(s)}`);
    }
  }
  if (sum.serialGroups.length > 0) {
    lines.push('', '  ran one after another in a single step');
    for (const g of sum.serialGroups) {
      lines.push(
        `    ${g.dispatch}: ${g.tools.join(' → ')} — ${formatMs(g.serialMs)}, ~${formatMs(g.couldBeMs)} if parallel`,
      );
    }
  }
  const chatty = sum.roundTrips.filter((r) => r.calls >= 3);
  if (chatty.length > 0) {
    lines.push('', '  model round trips (each one waits on the last)');
    for (const r of chatty.slice(0, 6)) {
      lines.push(
        `    ${String(r.calls).padStart(3)} × ${formatMs(r.modelMs).padStart(8)}  ${r.dispatch}`,
      );
    }
  }
  return lines;
}
