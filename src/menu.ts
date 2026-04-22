import type * as readline from 'node:readline';
import { printInfo, printDim } from './output.js';
import { getTheme } from './theme.js';

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
}

/** Options for promptValue(). */
export interface ValuePromptOptions {
  /** Prompt label, e.g. "New value for max-tokens". */
  label: string;
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

/** Print a numbered list with optional section headers. */
export function printMenuList(entries: MenuEntry[]): void {
  let n = 1;
  for (const entry of entries) {
    if (isSection(entry)) {
      printInfo(`\n  ${entry.title}`);
    } else {
      const activeMarker = entry.active ? ' (active)' : '';
      const annotation = entry.annotation ? ` ${entry.annotation}` : '';
      printInfo(`    ${n}. ${entry.label}${activeMarker}${annotation}`);
      if (entry.description) {
        printDim(`       ${entry.description}`);
      }
      n++;
    }
  }
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

/**
 * Prompt the user to select from a numbered list.
 * Returns cancelled if input is empty, non-numeric, out of range, or signal aborted.
 */
export async function selectFromMenu(
  rl: readline.Interface,
  entries: MenuEntry[],
  options?: MenuOptions,
  signal?: AbortSignal,
): Promise<SelectResult> {
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

  const answer = await questionWithSignal(rl, promptStr, signal);
  if (answer === null || answer.trim() === '') {
    printInfo('  Cancelled.');
    return { cancelled: true };
  }

  return { cancelled: false, raw: answer.trim() };
}
