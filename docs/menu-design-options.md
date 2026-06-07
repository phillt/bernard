# Menu description rendering — design options

The problem: `MenuOverlay` (src/ui/overlays/MenuOverlay.tsx:131-135) injects the
highlighted item's description as an extra indented line **under that row**, so
the whole list grows/shrinks and shifts as you arrow up and down.

Every design below is shown with the same two real menus: the **Tool mode**
submenu (short, every row has a description) and an excerpt of **/agent-options**
(long, mixed sections, annotations, some rows without descriptions).

`>` marks the highlighted row. All mockups assume the highlight is on row 2.

---

## Current behavior (for reference)

The description line appears/disappears under the highlight — rows below it
jump as you move.

```
Tool mode: write

  1. Read-only (least privilege)
> 2. Write
      Every tool may run; confirm gate still prompts on risk.
  3. Run Without Permission Checks or Safeguards

  ↑/↓ move · Enter select · Esc cancel
```

Press ↓ once and the list reflows to:

```
Tool mode: write

  1. Read-only (least privilege)
  2. Write
> 3. Run Without Permission Checks or Safeguards
      ⚠ No blocking, no confirmation prompts — every tool call runs unattended.

  ↑/↓ move · Enter select · Esc cancel
```

---

## Option A — Fixed footer slot (recommended)

One stable line reserved between the list and the key-hint bar. It always
occupies exactly one row: it shows the highlighted item's description, or
stays blank when the item has none. **Nothing ever moves.**

```
Tool mode: write

  1. Read-only (least privilege)
> 2. Write
  3. Run Without Permission Checks or Safeguards

  Every tool may run; confirm gate still prompts on risk.
  ↑/↓ move · Enter select · Esc cancel
```

/agent-options excerpt — same stable footer, long descriptions have a full
terminal row to breathe:

```
Agent options

  System
  1. Coordinator (ReAct) mode = auto
  2. Model mode = balanced
> 3. Tier lineup = Anthropic
  4. Tool mode = write
  5. Prompt rewriter ✎ = on
  User-created
  6. Specialists
  7. Tasks & routines

  Switch, edit, or create lineups that bind premium/mid/cheap tiers to specific (provider, model) pairs.
  ↑/↓ move · Enter select · Esc cancel
```

- Pros: zero layout shift; full-width line fits long descriptions; minimal diff
  (move 5 lines from `MenuList` into the footer of `MenuOverlay`).
- Cons: description is visually separated from the row it describes (mitigated
  by it changing instantly as you move).

---

## Option B — Always visible, under every row

Every item's description renders statically. Nothing moves because everything
is always expanded.

```
Tool mode: write

  1. Read-only (least privilege)
       Write tools blocked until explicitly enabled.
> 2. Write
       Every tool may run; confirm gate still prompts on risk.
  3. Run Without Permission Checks or Safeguards
       ⚠ No blocking, no confirmation prompts — every tool call runs unattended.

  ↑/↓ move · Enter select · Esc cancel
```

/agent-options excerpt — the cost shows on long menus (~20 rows become ~40
lines, pushing content off-screen in short terminals):

```
Agent options

  System
  1. Coordinator (ReAct) mode = auto
       on = ReAct every turn · off = single-shot · auto = per-turn qualifier.
  2. Model mode = balanced
       Tier (provider, model) per call site within the active lineup.
> 3. Tier lineup = Anthropic
       Switch, edit, or create lineups that bind premium/mid/cheap tiers to
       specific (provider, model) pairs.
  4. Tool mode = write
       Read-only blocks write tools until enabled. Write lets every tool run
       subject to the confirm gate. Unrestricted skips all permission checks.
  5. Prompt rewriter ✎ = on
       Rewrites your message for the active model family before dispatch.
  User-created
  6. Specialists
       List bundled and user-created specialists.
  7. Tasks & routines
       List saved tasks and routines.

  ↑/↓ move · Enter select · Esc cancel
```

- Pros: all context visible at once; nothing shifts.
- Cons: tall menus; long menus like /agent-options may scroll past the
  terminal height; descriptions need wrapping logic.

---

## Option C — Inline, right of the label

Description rendered dim on the same row after the label, truncated to the
terminal width. One row per item, always.

```
Tool mode: write

  1. Read-only (least privilege) — Write tools blocked until explicitly enabled.
> 2. Write — Every tool may run; confirm gate still prompts on risk.
  3. Run Without Permission Checks or Safeguards — ⚠ No blocking, no confirmati…

  ↑/↓ move · Enter select · Esc cancel
```

/agent-options excerpt — annotations and descriptions compete for the same
row, so truncation is common:

```
Agent options

  System
  1. Coordinator (ReAct) mode = auto — on = ReAct every turn · off = single-sho…
  2. Model mode = balanced — Tier (provider, model) per call site within the a…
> 3. Tier lineup = Anthropic — Switch, edit, or create lineups that bind premiu…
  4. Tool mode = write — Read-only blocks write tools until enabled. Write let…
  5. Prompt rewriter ✎ = on — Rewrites your message for the active model famil…
  User-created
  6. Specialists — List bundled and user-created specialists.
  7. Tasks & routines — List saved tasks and routines.

  ↑/↓ move · Enter select · Esc cancel
```

- Pros: compact, stable, scannable like a table.
- Cons: most descriptions in the codebase are sentence-length and will
  truncate on a typical 80-100 col terminal; busier rows.

---

## Option D — Drop descriptions entirely

Labels and annotations only. The `description` field stays in the data (other
surfaces could use it later) but `MenuOverlay` never renders it.

```
Tool mode: write

  1. Read-only (least privilege)
> 2. Write
  3. Run Without Permission Checks or Safeguards

  ↑/↓ move · Enter select · Esc cancel
```

```
Agent options

  System
  1. Coordinator (ReAct) mode = auto
  2. Model mode = balanced
> 3. Tier lineup = Anthropic
  4. Tool mode = write
  5. Prompt rewriter ✎ = on
  User-created
  6. Specialists
  7. Tasks & routines

  ↑/↓ move · Enter select · Esc cancel
```

- Pros: cleanest, most compact, zero movement, smallest diff.
- Cons: loses the explanatory text everywhere — first-time users lose the
  inline help for things like Coordinator mode and Tool mode.

---

## Implementation note (all options)

Single touch point: `MenuList` / `MenuOverlay` in
`src/ui/overlays/MenuOverlay.tsx`. Options A and D are ~10-line diffs; B needs
text wrapping for long descriptions; C needs width-aware truncation
(`useStdout().columns` or Ink's `<Text wrap="truncate">`). A few assertions in
`src/ui/__tests__/MenuOverlay.test.tsx` pin the current under-the-highlight
behavior and would be updated to match the chosen design. `ConfirmDialog.tsx`
is a separate component that renders no descriptions; if visual unification is
wanted later, it's the only other place to touch.
