import type { IntentField } from './brief.js';

/**
 * The intent interview: what to ask, and what not to (#473).
 *
 * A pure leaf — question text and prose, no model call and no I/O. The main
 * agent asks for it through `applet { action: 'interview' }` and conducts the
 * interview itself with `ask_user`, which renders a batch through the wizard
 * (one question per screen, back, edit, check-your-answers).
 *
 * ## Why the technique lives here and not in a system prompt
 *
 * It is ~200 lines of prose that matters on the handful of turns where someone
 * is building an applet. In `BASE_SYSTEM_PROMPT` it would be in the cached
 * prefix of every turn forever; returned as a tool result it costs nothing
 * until it is asked for. The idiom is `CREATE_SEED_PROMPTS` (`ui/App.tsx`),
 * which `/create-routine` and `/create-specialist` already use: a static
 * interactive playbook handed to the main agent on demand. (`writeScopePrompt`
 * and `slotStatusLine` are NOT the same shape — the first is composed into a
 * system prompt and the second is live state appended to a result.)
 *
 * ## Why the MAIN agent conducts it, not a dispatched specialist
 *
 * A tool-wrapper dispatch gets 13 steps and each question costs two model round
 * trips, so it runs out mid-interview — and `relabelStepLimit` then converts the
 * run into an error, **discarding every answer already given**. It would also
 * hold one of four agent-pool slots for the whole time the human is thinking,
 * its `ask_user` answers would never reach the transcript
 * (`injectAskUserHistoryMessages` scans main history only), and a twelve-field
 * result can be cap-truncated into unparseable JSON at the parent boundary. The
 * main agent has 25-75 steps, a continuation ladder that ASKS before giving up,
 * a cached prefix, and a transcript the answers land in.
 *
 * ## Four questions, not seven
 *
 * #473 specifies seven plus a conditional probe. Respondent-fatigue work finds
 * a 10-64% reduction in reported items in long instruments, and the mechanism is
 * that late answers get WORSE — people stop reading and satisfice — so question
 * six is not free, it degrades the answers around it. The closest controlled
 * analogue, LLM agents on deliberately underspecified software tasks, capped
 * interaction at three turns and still recovered ~74% of the lost performance.
 *
 * The four kept are the ones that change what gets built. The rest of the
 * elicitation happens against the running applet, where someone who cannot
 * build software still has the vocabulary to say "not that, more like this".
 */

/** One question, and the reason it is allowed to exist. */
export interface InterviewQuestion {
  /** Which brief field the answer fills. */
  field: IntentField;
  question: string;
  /** Standing help, rendered beside the question — never as placeholder text. */
  hint?: string;
  /** Short label for the review screen. */
  summary: string;
  /**
   * The build decision this answer changes.
   *
   * Required, and asserted by a test. GOV.UK's and the NHS's question protocol
   * is that every question must have a known use — *if you do not know how you
   * will use the answer, remove the question*. It doubles as the stopping rule:
   * stop when no remaining question would change what gets built.
   */
  decides: string;
  /**
   * Choices, only where the answer space genuinely IS small.
   *
   * Split-ballot experiments show respondent-generated categories repeatedly
   * fail to overlap with researcher-built lists even after pretesting, so a menu
   * on an open question does not merely constrain the answer — it changes it,
   * and you never learn what was lost. The first two questions are deliberately
   * open for that reason.
   */
  choices?: string[];
}

export const INTERVIEW_QUESTIONS: InterviewQuestion[] = [
  {
    field: 'goal',
    question: 'What would you love to make easier?',
    hint: 'A sentence or two is plenty.',
    summary: 'What to make easier',
    decides: 'What the applet is for, and whether it is worth building at all.',
  },
  {
    field: 'example',
    question: 'Tell me about the last time you had to do that. What happened?',
    hint: 'A real occasion, not a typical one — the details are the useful part.',
    summary: 'The last time',
    decides:
      'The actual steps, so the applet supports the real workflow rather than an imagined one.',
  },
  {
    field: 'input',
    question:
      'When you started, what did you have in front of you? And when you finished, what did you have?',
    hint: 'Whatever it was — a list, a photo, a spreadsheet, some notes.',
    summary: 'Start and finish',
    decides: 'The input and the output, which decide the applet’s controls and what it produces.',
  },
  {
    field: 'who',
    question: 'Besides you, who would ever open this?',
    summary: 'Who else opens it',
    decides: 'Whether it needs to explain itself to a stranger, or can assume you already know.',
    choices: ['Just me', 'Me and a few people I know', 'Anyone I share it with'],
  },
];

/** Neutral follow-ups. Deliberately tiny — a probe vocabulary, not a second script. */
export const PROBES = [
  'Tell me more about that.',
  'What happened next?',
  'Can you give me an example?',
  'What made that difficult?',
  'Where does that information come from?',
  'What happens when that goes wrong?',
] as const;

/** Questions that must never be asked, and what to ask instead. */
export const ANTI_PATTERNS: { avoid: string; instead: string; why: string }[] = [
  {
    avoid: 'What features do you want?',
    instead: 'What problem would that solve for you?',
    why: 'It jumps from the problem straight to a specification the person cannot write.',
  },
  {
    avoid: 'Would you use an app that…?',
    instead: 'What did you do the last time this happened?',
    why: 'People describe imagined behaviour confidently and predict their own choices badly.',
  },
  {
    avoid: 'Would AI help here?',
    instead: 'What part would you most like it to handle for you?',
    why: 'Technology selection follows the need. Bernard decides that, not the user.',
  },
  {
    avoid: 'Is doing it by hand frustrating because it takes so long?',
    instead: 'What is that part like for you?',
    why: 'It contains the interviewer’s theory and suggests its own answer.',
  },
  {
    avoid: 'What should it look like?',
    instead: 'Where and when would you be using it?',
    why: 'Derive the interface from the context — wet hands mean big controls, a desk means density.',
  },
];

/**
 * The playbook handed to the main agent.
 *
 * Generated from the question bank rather than written twice, so a question
 * added to `INTERVIEW_QUESTIONS` reaches the agent without a second edit — the
 * drift `applet-styler`'s token list needed a test to prevent.
 */
export function interviewPlaybook(): string {
  const why = INTERVIEW_QUESTIONS.map((q, i) => `${i + 1}. ${q.question}\n   → ${q.decides}`).join(
    '\n',
  );
  // The literal call, not prose for the model to paraphrase. Retyping is what
  // dropped `hint`, `summary` and question four's `choices` — all authored
  // here, none of them reaching a screen.
  const call = JSON.stringify(
    {
      questions: INTERVIEW_QUESTIONS.map((q) => ({
        question: q.question,
        ...(q.hint ? { hint: q.hint } : {}),
        summary: q.summary,
        ...(q.choices ? { choices: q.choices, allow_other: true } : {}),
      })),
    },
    null,
    2,
  );
  const fields = INTERVIEW_QUESTIONS.map((q) => `"${q.field}": "…"`).join(', ');
  const avoid = ANTI_PATTERNS.map(
    (a) => `- Never: "${a.avoid}" — ${a.why}\n  Ask instead: "${a.instead}"`,
  ).join('\n');

  return `# Interviewing someone who has never built software

They have an idea. They do not know what an app is made of, and asking them to
specify one will produce a worse answer than asking about their week. Your job
is to learn enough to build the smallest useful thing, then build it — not to
gather requirements.

## Say what is about to happen, then ask

Open with the shape, once: a few quick questions, then you build something they
can look at. Do not announce a number you might not keep.

## The questions

Ask ALL of them in ONE \`ask_user\` call. They are rendered one per screen with
back, edit, and a check-your-answers review, so a single call is a whole
interview — and asking them one call at a time costs a model round trip each.

Ask them with ONE \`ask_user\` call, exactly this:

\`\`\`json
${call}
\`\`\`

Why each one is allowed to exist — if an answer would not change what you build,
do not ask it:

${why}

## Then stop

Four is the budget. Late questions come back worse than early ones, not just
fewer, so a fifth costs you answers you already had. Ask a follow-up ONLY when
an answer left you unable to decide something you are about to build, and use
these words:

${PROBES.map((p) => `- "${p}"`).join('\n')}

When an answer turns abstract, go back to a real moment rather than probing the
abstraction.

## Never ask

${avoid}

## How to talk

Reading age nine. Short sentences, ordinary words, no jargon — not "inputs",
"outputs", "data model", "persistence", "users". React like a person who finds
their problem interesting ("ah, that makes sense", "that sounds annoying"), but
never praise an idea — "that's a great feature idea!" teaches them to pitch
features instead of describing their week.

## Then build, immediately

1. Write what you learned into the brief: \`applet\` with
   \`{"action":"create", …, "intent":{${fields}}}\`.
   Put what you are GUESSING in \`assumptions\` — that is what separates it from
   what you were told.
2. Build the smallest coherent thing: one input, one transformation, one
   useful result. Not a settings screen, not a database, not five actions.
3. It opens by itself. Then ask ONE question against the real thing:
   "Here it is — what is wrong with it?"

That last step is where the real requirements are. Someone who cannot build
software cannot describe one in the abstract, but can say "not that, more like
this" the moment they see it. Corrections go back through
\`applet {"action":"brief"}\` and \`applet {"action":"update"}\`.`;
}
