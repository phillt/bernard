# Research prompt: should applet building have a planning step?

For **Applets Round 3** (milestone #13). Paste the fenced block below into a
model with deep-research capability. It is written to be self-contained — the
reader has no access to this repository.

## Why this exists

Observed while watching Bernard build an applet: he goes straight from the
interview to writing HTML. Nothing designs the application first.

Three facts were verified in the source before writing the prompt, and they
shape it:

- **There is no planning in the applet path at all.** No references to a
  planner or the `plan` tool in `src/tools/applet.ts` or `src/apps/interview.ts`.
- **Bernard already owns two planning mechanisms** — the Planner/Actor/Critic
  pipeline (`src/framework/pac/`) and the `plan` tool (`src/tools/plan.ts`) —
  and **neither is reachable from an applet build**. So the first question is
  not "build a planner" but "why is the existing one not wired here?"
- **The four-question interview builds early on purpose** (#473), decided on
  published evidence. Asked naively, a model will answer "gather more
  requirements first", which contradicts that evidence. The prompt therefore
  separates requirements elicitation (settled) from solution design (open) and
  says not to re-litigate the first.

The prompt also asks for the counterargument rather than assuming more agents
is better — Cognition published a fairly direct case against multi-agent
architectures for tasks of this shape.

## The prompt

```text
I'm designing a planning step for an AI agent that builds small web
applications on the user's behalf, and I want deep research into how this is
done well, grounded in industry practice and published evidence rather than
intuition. Please cite sources and say where evidence is thin.

## The system

"Bernard" is a local CLI AI agent. It can build **applets**: small local web
apps, each served on its own origin, whose buttons call back into the agent.
An applet is one HTML file plus optional CSS/JS files and a JSON manifest that
declares named actions with typed arguments. Constraints that shape everything:

- Strict CSP. No `unsafe-eval`, no inline `<style>`, no off-origin resources
  without an explicit per-applet grant. So: no build step, no bundler, no npm,
  no framework needing runtime template compilation.
- A served design-token stylesheet and a served 13 KB Preact+htm runtime are
  the only shared assets. Plain HTML is the default; the runtime is for pages
  with a changing list or more than ~4 controls.
- The end user is explicitly non-technical — someone who has an idea and
  cannot specify software.

## What already exists

1. **A four-question interview** conducted before building: what to make
   easier, what happened the last time you did it, what you started and
   finished with, who else would open it. Each question must name the build
   decision it changes.
2. **A brief** — a twelve-field record of intent (who, goal, trigger, example,
   current, friction, outcome, input, output, context, control, assumptions)
   that survives rebuilds.
3. **Write-time validation** that refuses a page that cannot work (missing
   required links, inline style the CSP would discard, hand-rolled protocol
   calls, invoking undeclared actions) and warns on the uncertain cases.
4. **A design pass** — a specialist that restyles the page after it is written.
5. **A reviewer** that reads the source and invokes every action, requiring
   success. It has no browser, so it cannot check layout or rendering.
6. **Generic planning machinery the agent already owns but does NOT use for
   applets**: a Planner→Actor→Critic pipeline (three separate agents with
   their own prompts, tool scopes and step budgets, with one retry on a critic
   failure) and a `plan` tool that records numbered steps with states.

## The observed problem

The agent goes straight from the interview to writing HTML. Nothing designs
the application first — no decision about what screens exist, what the data
shape is, what actions the manifest needs, what state lives where, or which of
the two rendering approaches to use. The result is plausible but arbitrary,
and structural mistakes surface only when a button is clicked.

## What is already settled — please do not re-litigate

The interview deliberately stops at four questions and builds immediately.
That was decided on evidence, not convenience:

- Respondent-fatigue research finds long instruments reduce reported items
  10–64%, and late answers degrade rather than merely thin out.
- The closest controlled analogue — LLM agents on deliberately
  underspecified software tasks — capped interaction at three turns and still
  recovered ~74% of lost performance.
- Requirements-elicitation research finds a prototype elicits better
  requirements than abstract questioning, and a low-fidelity prototype beat a
  high-fidelity one.
- Vibe-coding research documents that non-technical users lack the vocabulary
  to name what they want changed until they can see something.

So "gather more requirements first" is the wrong answer. **The open question
is whether a solution-design step belongs between the interview and the code,
and if so what shape it takes.** Requirements elicitation and solution design
are different activities; only the first has been settled here.

## What I want researched

1. **Prior art in agentic code generation.** How do production systems (Devin,
   OpenHands/OpenDevin, SWE-agent, Aider, Cursor/Windsurf agent modes, v0,
   Bolt, Lovable, Replit Agent, GitHub Copilot Workspace) separate planning
   from implementation? Where they use an explicit plan artifact, what is in
   it, is it shown to the user, and is it revised? Which of them measured a
   benefit, and which just assert one?

2. **Does planning-before-coding measurably help LLMs?** Evidence on
   plan-then-execute vs. direct generation for code: Plan-and-Solve, self-
   planning for code generation, ReAct vs. plan-first, Reflexion, LLM-Modulo,
   the "planning" results on SWE-bench / HumanEval / ClassEval. I especially
   want cases where planning did **not** help, or hurt — including whether a
   plan an LLM then ignores is worse than none, and how often a plan produced
   before any code survives contact with the code.

3. **The right artifact for a small app.** Industry practice for lightweight
   design records: ADRs, RFCs/design docs, C4, user-story mapping, job stories,
   Shape Up's "shaping"/breadboarding and fat-marker sketches, wireframes,
   information architecture, data-model-first design. Which of these are
   proportionate to a single-page app with one data store and 1–5 actions, and
   which are ceremony at that size? Is there published work on the *minimum
   viable* design artifact?

4. **Planner as prompt vs. planner as separate agent.** When is a distinct
   planning agent (own context, own tools, own critic) worth its cost versus a
   planning *phase* in one agent's context? Evidence on multi-agent vs.
   single-agent for well-scoped tasks — including findings that multi-agent
   pipelines underperform or add failure modes (e.g. Cognition's argument
   against multi-agent architectures, and any rebuttals).

5. **Critic/verification of a design, not of code.** Can a plan be
   meaningfully verified before implementation, and by what criteria? Prior art
   on LLM-as-judge for design artifacts, its known failure modes, and whether
   self-critique of one's own plan produces real gains or just longer plans.

6. **The non-technical user in the loop.** Should the plan be shown to someone
   who cannot read software design? Evidence on whether non-experts can
   usefully approve a design artifact, versus reacting to a running prototype.
   If shown, what representation works — prose, a sketch, a list of screens, a
   worked example with their own data?

## Output I want

- A recommendation, not a survey: what shape the planning step should take
  here, or a well-argued case that it should not exist and the problem is
  better solved another way (e.g. more write-time validation, or a stronger
  build→react loop).
- The specific artifact, with its fields, if you recommend one.
- Where it sits relative to the interview and the build, and whether the user
  sees it.
- What it costs — extra model calls, latency, added failure modes — and how
  that trades against errors caught.
- What would falsify the recommendation: what to measure to know it helped.
- Explicit flags where you are extrapolating rather than citing, and where
  the evidence contradicts the popular practice.
```

## When the research comes back

The answer that matters most is question 4: whether this is a **phase** in the
main agent's context or a **separate agent**. Bernard has both shapes already —
the `plan` tool is the first, PAC is the second — so the finding maps onto an
existing mechanism either way, and neither needs building from scratch.
