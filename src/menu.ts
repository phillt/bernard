import * as readline from 'node:readline';
import { printInfo, printDim, setPinnedRegion, clearPinnedRegion } from './output.js';
import { getTheme } from './theme.js';

/** Pinned-region id used by the interactive menu. Exported for tests. */
export const MENU_REGION_ID = 'menu';

/** Pinned-region id used by promptValue() to display optional header lines. */
const PROMPT_HEADER_REGION_ID = 'prompt-header';

const DIGIT_KEY_RE = /^[1-9]$/;

/** Minimal shape of the keypress events emitted by node:readline. */
interface KeyEvent {
  name?: string;
  ctrl?: boolean;
}

/** A single selectable item in a menu. */
export interface MenuItem {
  /** Text shown next to the number. */
  label: string;
  /** If true, appends " (active)" marker. */
  active?: boolean;
  /** Optional annotation shown after the label (e.g. "= 4096 (default)"). */
  annotation?: string;
  /** Optional second line shown below the item, indented further. */
  description?: string;
  /** Opaque payload returned to the caller on selection. */
  value?: unknown;
}

/** A section divider inserted between items in the numbered list. */
export interface MenuSection {
  type: 'section';
  /** Header text printed before the next batch of items. */
  title: string;
}

/** Union of what can appear in the entries array. */
export type MenuEntry = MenuItem | MenuSection;

/** Options for selectFromMenu(). */
export interface MenuOptions {
  /** Prompt string override, e.g. "Select option". Default: "Select". */
  promptLabel?: string;
  /** Optional heading rendered inside the ephemeral menu block. */
  title?: string;
  /**
   * Optional header lines pinned above the title. Rendered inside the menu's
   * own pinned region so they update atomically with the menu, never leaking
   * into scrollback as the menu repaints.
   */
  headerLines?: string[];
}

/** Options for promptValue(). */
export interface ValuePromptOptions {
  /** Prompt label, e.g. "New value for max-tokens". */
  label: string;
  /**
   * Optional header lines printed above the prompt. Use to provide context
   * (e.g. an ask_user progress strip).
   */
  headerLines?: string[];
}

/** Result from selectFromMenu(). */
export type SelectResult =
  | { cancelled: true }
  | { cancelled: false; index: number; item: MenuItem };

/** Result from promptValue(). */
export type ValueResult = { cancelled: true } | { cancelled: false; raw: string };

/** Type guard for MenuSection entries. */
function isSection(entry: MenuEntry): entry is MenuSection {
  return 'type' in entry && entry.type === 'section';
}

/** Count the selectable (non-section) items in an entries array. */
export function countMenuItems(entries: MenuEntry[]): number {
  let count = 0;
  for (const e of entries) {
    if (!isSection(e)) count++;
  }
  return count;
}

/** Get the Nth (0-based) selectable item, skipping sections. */
export function getMenuItem(entries: MenuEntry[], index: number): MenuItem | undefined {
  let n = 0;
  for (const e of entries) {
    if (!isSection(e)) {
      if (n === index) return e;
      n++;
    }
  }
  return undefined;
}

/** True when we should skip the interactive renderer and use the legacy numbered-list path. */
function useFallback(): boolean {
  const flag = process.env.BERNARD_PLAIN_MENU;
  const forcePlain = flag === 'true' || flag === '1';
  // setRawMode throws on non-TTY stdin, so both streams must be TTY.
  return !process.stdout.isTTY || !process.stdin.isTTY || forcePlain;
}

/**
 * A single line of the fallback numbered-list rendering, tagged with whether
 * it should be emitted via `printDim` (description rows) or `printInfo`.
 */
export interface LegacyLine {
  text: string;
  dim?: boolean;
}

export function buildLegacyLines(entries: MenuEntry[]): LegacyLine[] {
  const out: LegacyLine[] = [];
  let n = 1;
  for (const entry of entries) {
    if (isSection(entry)) {
      out.push({ text: `\n  ${entry.title}` });
    } else {
      const activeMarker = entry.active ? ' (active)' : '';
      const annotation = entry.annotation ? ` ${entry.annotation}` : '';
      out.push({ text: `    ${n}. ${entry.label}${activeMarker}${annotation}` });
      if (entry.description) {
        out.push({ text: `       ${entry.description}`, dim: true });
      }
      n++;
    }
  }
  return out;
}

/**
 * Wrap rl.question in a Promise with optional AbortSignal support.
 * Returns null on abort or if the signal was already aborted.
 */
function questionWithSignal(
  rl: readline.Interface,
  prompt: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(null);
      return;
    }

    let settled = false;
    const settle = (val: string | null) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    const onAbort = () => settle(null);
    signal?.addEventListener('abort', onAbort, { once: true });

    if (signal) {
      rl.question(prompt, { signal }, (answer) => {
        signal.removeEventListener('abort', onAbort);
        settle(answer);
      });
    } else {
      rl.question(prompt, (answer) => settle(answer));
    }
  });
}

/** Legacy numbered-list + rl.question selection flow. */
async function legacySelect(
  rl: readline.Interface,
  entries: MenuEntry[],
  options: MenuOptions | undefined,
  signal: AbortSignal | undefined,
): Promise<SelectResult> {
  if (options?.headerLines && options.headerLines.length > 0) {
    for (const headerLine of options.headerLines) printInfo(headerLine);
    printInfo('');
  }
  if (options?.title) {
    printInfo(`\n  ${options.title}\n`);
  }
  for (const line of buildLegacyLines(entries)) {
    if (line.dim) printDim(line.text);
    else printInfo(line.text);
  }
  printInfo('');

  const items = entries.filter((e) => !isSection(e)) as MenuItem[];
  const label = options?.promptLabel ?? 'Select';
  const { ansi } = getTheme();
  const promptStr = `  ${ansi.prompt}${label} [1-${items.length}]${ansi.reset} (Enter or Esc to cancel): `;

  const answer = await questionWithSignal(rl, promptStr, signal);
  if (answer === null || answer.trim() === '') {
    printInfo('  Cancelled.');
    return { cancelled: true };
  }

  const num = parseInt(answer.trim(), 10);
  if (num >= 1 && num <= items.length) {
    return { cancelled: false, index: num - 1, item: items[num - 1] };
  }

  printInfo('  Cancelled.');
  return { cancelled: true };
}

/**
 * Build the lines array for the ephemeral menu block.
 * The highlighted item gets a `>` cursor and accent styling; its description
 * (if present) is shown below it. Other items show a plain numbered label.
 *
 * Exported for direct testing; production callers go through selectFromMenu.
 */
export function renderMenuLines(
  entries: MenuEntry[],
  highlightItemIndex: number,
  options: MenuOptions | undefined,
): string[] {
  const { accent, accentBold, dim, muted } = getTheme();
  const lines: string[] = [];

  if (options?.headerLines && options.headerLines.length > 0) {
    for (const headerLine of options.headerLines) lines.push(headerLine);
    lines.push('');
  }

  if (options?.title) {
    lines.push(`  ${accentBold(options.title)}`);
    lines.push('');
  }

  let itemIndex = 0;
  for (const entry of entries) {
    if (isSection(entry)) {
      lines.push(`  ${muted(entry.title)}`);
      continue;
    }
    const n = itemIndex + 1;
    const activeMarker = entry.active ? ' (active)' : '';
    const annotation = entry.annotation ? ` ${entry.annotation}` : '';
    const labelText = `${n}. ${entry.label}${activeMarker}${annotation}`;
    const isHighlighted = itemIndex === highlightItemIndex;
    if (isHighlighted) {
      lines.push(`  ${accent('>')} ${accentBold(labelText)}`);
      if (entry.description) {
        lines.push(`       ${dim(entry.description)}`);
      }
    } else {
      lines.push(`    ${labelText}`);
    }
    itemIndex++;
  }

  lines.push('');
  lines.push(`  ${dim('\u2191/\u2193 move \u00B7 Enter select \u00B7 Esc cancel')}`);

  return lines;
}

/** Interactive arrow-key menu rendered via the pinned region. */
async function interactiveSelect(
  rl: readline.Interface,
  entries: MenuEntry[],
  options: MenuOptions | undefined,
  signal: AbortSignal | undefined,
): Promise<SelectResult> {
  if (signal?.aborted) {
    return { cancelled: true };
  }

  const itemCount = countMenuItems(entries);
  if (itemCount === 0) {
    return { cancelled: true };
  }

  readline.emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw ?? false;
  process.stdin.setRawMode(true);
  rl.pause();
  // rl.pause() pauses the underlying stdin; resume so 'keypress' events fire.
  process.stdin.resume();

  let highlight = 0;

  const repaint = () => {
    setPinnedRegion(MENU_REGION_ID, renderMenuLines(entries, highlight, options));
  };

  return new Promise<SelectResult>((resolve) => {
    let settled = false;
    const finish = (result: SelectResult) => {
      if (settled) return;
      settled = true;
      process.stdin.removeListener('keypress', onKeypress);
      signal?.removeEventListener('abort', onAbort);
      try {
        process.stdin.setRawMode(wasRaw);
      } catch {
        // stdin may have been detached; ignore.
      }
      clearPinnedRegion(MENU_REGION_ID);
      rl.resume();
      if (!result.cancelled) {
        printInfo(`  Selected: ${result.item.label}`);
      }
      resolve(result);
    };

    const commit = (idx: number) => {
      const item = getMenuItem(entries, idx);
      if (!item) {
        finish({ cancelled: true });
        return;
      }
      finish({ cancelled: false, index: idx, item });
    };

    const onKeypress = (_str: string, key: KeyEvent | undefined) => {
      if (!key) return;

      if (key.ctrl && key.name === 'c') {
        finish({ cancelled: true });
        return;
      }
      if (key.name === 'escape' || key.name === 'q') {
        finish({ cancelled: true });
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        commit(highlight);
        return;
      }
      if (key.name === 'up') {
        if (highlight > 0) {
          highlight--;
          repaint();
        }
        return;
      }
      if (key.name === 'down') {
        if (highlight < itemCount - 1) {
          highlight++;
          repaint();
        }
        return;
      }
      if (key.name && DIGIT_KEY_RE.test(key.name)) {
        const n = parseInt(key.name, 10) - 1;
        if (n < itemCount) {
          commit(n);
        }
      }
    };

    const onAbort = () => finish({ cancelled: true });
    signal?.addEventListener('abort', onAbort, { once: true });

    process.stdin.on('keypress', onKeypress);
    repaint();
  });
}

/**
 * Prompt the user to select from a menu.
 *
 * In a TTY without `BERNARD_PLAIN_MENU=1`, renders as an ephemeral arrow-key
 * menu above the prompt. Otherwise falls back to a numbered list + rl.question.
 * Returns cancelled on Esc/Ctrl-C/q, on external signal abort, or on empty /
 * out-of-range input in fallback mode.
 */
export async function selectFromMenu(
  rl: readline.Interface,
  entries: MenuEntry[],
  options?: MenuOptions,
  signal?: AbortSignal,
): Promise<SelectResult> {
  if (useFallback()) {
    return legacySelect(rl, entries, options, signal);
  }
  return interactiveSelect(rl, entries, options, signal);
}

/**
 * Prompt the user to enter a free-form string value.
 * Returns cancelled if input is empty or signal aborted.
 */
export async function promptValue(
  rl: readline.Interface,
  options: ValuePromptOptions,
  signal?: AbortSignal,
): Promise<ValueResult> {
  const { ansi } = getTheme();
  const promptStr = `  ${ansi.prompt}${options.label}${ansi.reset} (Enter or Esc to cancel): `;

  const hasHeader = options.headerLines && options.headerLines.length > 0;
  if (hasHeader) {
    setPinnedRegion(PROMPT_HEADER_REGION_ID, [...options.headerLines!, '']);
  }
  try {
    const answer = await questionWithSignal(rl, promptStr, signal);
    if (answer === null || answer.trim() === '') {
      printInfo('  Cancelled.');
      return { cancelled: true };
    }
    return { cancelled: false, raw: answer.trim() };
  } finally {
    if (hasHeader) clearPinnedRegion(PROMPT_HEADER_REGION_ID);
  }
}
