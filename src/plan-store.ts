import type { Check, Rubric } from './rubric.js';
import { verdictOf } from './rubric.js';
import { debugLog } from './logger.js';

/**
 * Status lifecycle for a plan step.
 *
 * Non-terminal: `pending`, `in_progress`.
 * Terminal: `done`, `cancelled`, `error`.
 */
export type StepStatus = 'pending' | 'in_progress' | 'done' | 'cancelled' | 'error';

/**
 * Minimum signoff length for a `done` step to count as "really verified."
 * Anything shorter (e.g. "ok", "done") downgrades the rubric to warn.
 */
const MIN_SIGNOFF_LEN = 10;

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
  private subscribers: Set<() => void> = new Set();

  /**
   * Registers a callback fired after every mutation (create/add/update/clear/
   * cancelAllUnresolved). Returns an unsubscribe function. Used by the REPL's
   * `<PlanPanel>` so the pinned plan list re-renders the moment the model
   * transitions a step, even mid-turn.
   */
  subscribe(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  private notify(): void {
    for (const cb of this.subscribers) {
      try {
        cb();
      } catch (err) {
        // A throwing subscriber (e.g. a UI render error) must not break the
        // plan mutation that triggered it, nor starve the other subscribers.
        debugLog('plan-store:subscriber-error', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Replaces all steps. When called with a non-empty existing plan (the model
   * is rewriting mid-turn), `onReplace` fires before the new steps are
   * committed — the plan tool wires this to clear scratch (Rule C of #169) so
   * the previous plan's working notes don't bleed into the new plan.
   */
  create(inputs: StepInput[], onReplace?: () => void): Step[] {
    if (this.steps.length > 0 && onReplace) {
      onReplace();
    }
    this.steps = [];
    for (const input of inputs) {
      this.steps.push({
        id: this.steps.length + 1,
        description: input.description,
        verification: input.verification,
        status: 'pending',
      });
    }
    this.notify();
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
    this.notify();
    return { ...step };
  }

  /** Transitions a step's status. Returns null if no step matches the id. */
  update(id: number, status: StepStatus, opts?: { note?: string; signoff?: string }): Step | null {
    const step = this.steps.find((s) => s.id === id);
    if (!step) return null;
    step.status = status;
    if (opts?.note !== undefined) step.note = opts.note;
    if (opts?.signoff !== undefined) step.signoff = opts.signoff;
    this.notify();
    return { ...step };
  }

  view(): Step[] {
    return this.steps.map((s) => ({ ...s }));
  }

  clear(): void {
    this.steps = [];
    this.notify();
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
    if (count > 0) this.notify();
    return count;
  }

  /**
   * Derive a machine-checkable rubric from the current plan state (issue #145).
   * Pure over the existing fields — no new step state required.
   */
  evaluateRubric(): Rubric {
    const checks: Check[] = [];
    const unresolved = this.unresolvedCount();
    if (this.steps.length === 0) {
      checks.push({
        id: 'steps_terminal',
        label: 'plan steps in terminal state',
        status: 'skip',
        evidence: 'no plan recorded',
      });
    } else if (unresolved === 0) {
      checks.push({
        id: 'steps_terminal',
        label: 'plan steps in terminal state',
        status: 'pass',
        evidence: `${this.steps.length} step(s) terminal`,
      });
    } else {
      checks.push({
        id: 'steps_terminal',
        label: 'plan steps in terminal state',
        status: 'fail',
        evidence: `${unresolved} unresolved`,
      });
    }

    const doneSteps = this.steps.filter((s) => s.status === 'done');
    if (doneSteps.length === 0) {
      checks.push({
        id: 'signoffs_present',
        label: 'done steps have substantive signoff',
        status: 'skip',
        evidence: 'no done steps',
      });
    } else {
      const weak = doneSteps.filter((s) => (s.signoff ?? '').trim().length < MIN_SIGNOFF_LEN);
      if (weak.length === 0) {
        checks.push({
          id: 'signoffs_present',
          label: 'done steps have substantive signoff',
          status: 'pass',
          evidence: `${doneSteps.length} signoff(s) ≥ ${MIN_SIGNOFF_LEN} chars`,
        });
      } else {
        checks.push({
          id: 'signoffs_present',
          label: 'done steps have substantive signoff',
          status: 'warn',
          evidence: `${weak.length} weak signoff(s): step(s) ${weak.map((s) => s.id).join(',')}`,
        });
      }
    }

    const errored = this.steps.filter((s) => s.status === 'error');
    if (errored.length === 0) {
      checks.push({
        id: 'no_error_steps',
        label: 'no step ended in error',
        status: 'pass',
      });
    } else if (errored.length === 1) {
      checks.push({
        id: 'no_error_steps',
        label: 'no step ended in error',
        status: 'warn',
        evidence: `step ${errored[0].id}: ${errored[0].note ?? ''}`.trim(),
      });
    } else {
      checks.push({
        id: 'no_error_steps',
        label: 'no step ended in error',
        status: 'fail',
        evidence: `${errored.length} errored: step(s) ${errored.map((s) => s.id).join(',')}`,
      });
    }

    return { verdict: verdictOf(checks), checks };
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
