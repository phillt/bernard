/**
 * Status lifecycle for a plan step.
 *
 * Non-terminal: `pending`, `in_progress`.
 * Terminal: `done`, `cancelled`, `error`.
 */
export type StepStatus = 'pending' | 'in_progress' | 'done' | 'cancelled' | 'error';

export interface Step {
  id: number;
  description: string;
  status: StepStatus;
  note?: string;
}

const TERMINAL_STATUSES: ReadonlySet<StepStatus> = new Set<StepStatus>([
  'done',
  'cancelled',
  'error',
]);

/**
 * Session-scoped plan store used by coordinator (ReAct) mode.
 *
 * Plans are per-turn and in-memory only. The owning Agent calls `clear()` at
 * the start of each `processInput` so plans do not bleed across turns.
 */
export class PlanStore {
  private steps: Step[] = [];

  create(descriptions: string[]): Step[] {
    this.steps = [];
    for (const description of descriptions) {
      this.steps.push({ id: this.steps.length + 1, description, status: 'pending' });
    }
    return this.view();
  }

  add(description: string): Step {
    const step: Step = { id: this.steps.length + 1, description, status: 'pending' };
    this.steps.push(step);
    return { ...step };
  }

  /** Transitions a step's status. Returns null if no step matches the id. */
  update(id: number, status: StepStatus, note?: string): Step | null {
    const step = this.steps.find((s) => s.id === id);
    if (!step) return null;
    step.status = status;
    if (note !== undefined) step.note = note;
    return { ...step };
  }

  view(): Step[] {
    return this.steps.map((s) => ({ ...s }));
  }

  clear(): void {
    this.steps = [];
  }

  /** True when every step is in a terminal state (done, cancelled, error). */
  isComplete(): boolean {
    return this.steps.every((s) => TERMINAL_STATUSES.has(s.status));
  }

  unresolvedCount(): number {
    return this.steps.filter((s) => !TERMINAL_STATUSES.has(s.status)).length;
  }

  /** Cancels every non-terminal step with the given note. Returns the count cancelled. */
  cancelAllUnresolved(note: string): number {
    let count = 0;
    for (const step of this.steps) {
      if (!TERMINAL_STATUSES.has(step.status)) {
        step.status = 'cancelled';
        step.note = note;
        count++;
      }
    }
    return count;
  }

  /** Renders the plan as a human-readable bulleted list for re-prompts. */
  render(): string {
    if (this.steps.length === 0) return '(no plan)';
    return this.steps
      .map((s) => {
        const notePart = s.note ? ` — ${s.note}` : '';
        return `${s.id}. [${s.status}] ${s.description}${notePart}`;
      })
      .join('\n');
  }
}
