/**
 * Pure type module for menu entries / options / results consumed by the Ink
 * overlay components (`MenuOverlay`, request helpers in `App`).
 *
 * Originally these types lived in `src/menu.ts` alongside the readline-based
 * `selectFromMenu` / `promptValue` runtime. Phase D (#215) deletes that file;
 * the types survive here so the Ink overlay layer and the tool `askUser`
 * wiring keep a stable shape without importing the deleted runtime.
 */

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

/** A section divider inserted between items in the menu. */
export interface MenuSection {
  type: 'section';
  /** Header text printed before the next batch of items. */
  title: string;
}

/** Union of what can appear in the entries array. */
export type MenuEntry = MenuItem | MenuSection;

/** Options for the `MenuOverlay` component. */
export interface MenuOptions {
  /** Prompt string override, e.g. "Select option". Default: "Select". */
  promptLabel?: string;
  /** Optional heading rendered inside the menu block. */
  title?: string;
  /** Header lines rendered above the title (e.g. the `ask_user` tab strip). */
  headerLines?: string[];
  /**
   * Item index (sections excluded) to highlight on open. Lets a caller restore
   * the cursor when re-showing a list — e.g. a looping manager re-highlighting
   * the item the user just drilled into. Clamped to the item range.
   */
  initialIndex?: number;
}

/** Options for the `TextInputOverlay` component. */
export interface ValuePromptOptions {
  /** Prompt label, e.g. "New value for max-tokens". */
  label: string;
  /** Initial buffer content. */
  initialValue?: string;
  /** Header lines rendered above the prompt for context. */
  headerLines?: string[];
  /** When true, an empty submission is treated as cancellation. Default: true. */
  cancelOnEmpty?: boolean;
  /** Optional placeholder hint shown when the buffer is empty. */
  placeholder?: string;
}

/** Result from a menu selection. */
export type SelectResult =
  | { cancelled: true }
  | { cancelled: false; index: number; item: MenuItem };

/** Result from a free-text prompt. */
export type ValueResult = { cancelled: true } | { cancelled: false; raw: string };
