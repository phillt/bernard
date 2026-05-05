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
  /** Concrete check that proves the step succeeded. Filled at create/add. */
  verification: string;
  status: StepStatus;
  /** Set when status is cancelled/error (reason) or done (alongside signoff). */
  note?: string;
  /** Sign-off statement attesting the verification was actually checked. Required for done. */
  signoff?: string;
}

export interface StepInput {
  description: string;
  verification: string;
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

  create(inputs: StepInput[]): Step[] {
    this.steps = [];
    for (const input of inputs) {
      this.steps.push({
        id: this.steps.length + 1,
        description: input.description,
        verification: input.verification,
        status: 'pending',
      });
    }
    return this.view();
  }

  add(input: StepInput): Step {
    const step: Step = {
      id: this.steps.length + 1,
      description: input.description,
      verification: input.verification,
      status: 'pending',
    };
    this.steps.push(step);
    return { ...step };
  }

  /** Transitions a step's status. Returns null if no step matches the id. */
  update(id: number, status: StepStatus, opts?: { note?: string; signoff?: string }): Step | null {
    const step = this.steps.find((s) => s.id === id);
    if (!step) return null;
    step.status = status;
    if (opts?.note !== undefined) step.note = opts.note;
    if (opts?.signoff !== undefined) step.signoff = opts.signoff;
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

  /** Renders the plan as a human-readable list for re-prompts. */
  render(): string {
    if (this.steps.length === 0) return '(no plan)';
    return this.steps
      .map((s) => {
        const lines = [`${s.id}. [${s.status}] ${s.description}`];
        lines.push(`   verify: ${s.verification}`);
        if (s.signoff) lines.push(`   signoff: ${s.signoff}`);
        if (s.note) lines.push(`   note: ${s.note}`);
        return lines.join('\n');
      })
      .join('\n');
  }
}
