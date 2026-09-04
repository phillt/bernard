import { describe, it, expect } from 'vitest';
import { ANTI_PATTERNS, INTERVIEW_QUESTIONS, PROBES, interviewPlaybook } from './interview.js';
import { INTENT_FIELDS } from './brief.js';

describe('the question bank', () => {
  it('every question names the build decision it changes', () => {
    // GOV.UK's and the NHS's question protocol: if you do not know how you will
    // use the answer, remove the question. It is also the stopping rule — stop
    // when no remaining question would change what gets built — so this is the
    // one invariant that keeps the interview from growing back.
    for (const q of INTERVIEW_QUESTIONS) {
      expect(q.decides, `"${q.question}" has no stated use`).toBeTruthy();
      expect(q.decides.length).toBeGreaterThan(20);
    }
  });

  it('fills real brief fields, so an answer has somewhere to go', () => {
    for (const q of INTERVIEW_QUESTIONS) {
      expect(INTENT_FIELDS).toContain(q.field);
    }
  });

  it('stays inside the four-question budget', () => {
    // Fatigue work finds late answers are worse, not merely fewer, so a fifth
    // question costs answers already given. #473 asks for seven; the evidence
    // does not support them.
    expect(INTERVIEW_QUESTIONS.length).toBeLessThanOrEqual(4);
  });

  it('asks the opening questions OPEN, with choices only where the space is small', () => {
    // Split-ballot experiments: respondent-generated categories repeatedly fail
    // to overlap with researcher-built lists, so a menu on an open question
    // changes the answer and hides what was lost.
    expect(INTERVIEW_QUESTIONS[0].choices).toBeUndefined();
    expect(INTERVIEW_QUESTIONS[1].choices).toBeUndefined();
    const closed = INTERVIEW_QUESTIONS.filter((q) => q.choices);
    for (const q of closed) expect(q.choices!.length).toBeLessThanOrEqual(4);
  });

  it('offers no "not sure" escape anywhere', () => {
    // A no-opinion option measurably encourages satisficing. A typed "not sure"
    // is a signal the question was wrong, and is handled conversationally.
    for (const q of INTERVIEW_QUESTIONS) {
      for (const c of q.choices ?? []) {
        expect(c.toLowerCase()).not.toMatch(/not sure|don'?t know|n\/a|skip/);
      }
    }
  });

  it('gives every question a short review label', () => {
    for (const q of INTERVIEW_QUESTIONS) expect(q.summary.length).toBeLessThan(30);
  });
});

describe('the playbook', () => {
  const text = interviewPlaybook();

  it('emits the literal `ask_user` call, not prose to paraphrase', () => {
    // Retyping is what dropped `hint`, `summary` and question four's `choices`
    // — all authored in the bank, none of them reaching a screen.
    for (const q of INTERVIEW_QUESTIONS) {
      expect(text).toContain(JSON.stringify(q.question));
      expect(text).toContain(JSON.stringify(q.summary));
      if (q.hint) expect(text).toContain(JSON.stringify(q.hint));
      for (const c of q.choices ?? []) expect(text).toContain(JSON.stringify(c));
    }
  });

  it('names the intent keys from the bank rather than a second hand-written list', () => {
    for (const q of INTERVIEW_QUESTIONS) expect(text).toContain(`"${q.field}"`);
  });

  it('carries every probe and every anti-pattern', () => {
    for (const p of PROBES) expect(text).toContain(p);
    for (const a of ANTI_PATTERNS) expect(text).toContain(a.avoid);
  });

  it('tells the agent to ask in ONE call', () => {
    // Four separate calls cost four extra model round trips for the same four
    // answers; the wizard already renders a batch one question per screen.
    expect(text).toMatch(/ONE `ask_user` call/);
  });

  it('tells the agent to build immediately and then ask against the real thing', () => {
    // The finding that most changes the shape: a person who cannot build
    // software cannot describe one, but can react to one.
    expect(text).toContain('what is wrong with it?');
    expect(text.toLowerCase()).toContain('smallest coherent');
  });

  it('names the jargon it must not use', () => {
    expect(text).toContain('inputs');
    expect(text).toContain('Reading age nine');
  });

  it('does not announce a question count it might not keep', () => {
    expect(text).not.toMatch(/\b(four|4|seven|7) questions\b/i);
  });
});
