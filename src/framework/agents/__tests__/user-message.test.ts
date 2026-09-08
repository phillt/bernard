import { describe, it, expect } from 'vitest';
import {
  attachTo,
  buildBriefUserMessage,
  renderBrief,
  renderTaskText,
  untrustedData,
} from '../user-message.js';
import { pacPlannerDefinition } from '../pac-planner.js';
import { pacActorDefinition } from '../pac-actor.js';
import { pacCriticDefinition } from '../pac-critic.js';
import { toolWrapperDefinition } from '../tool-wrapper.js';

/**
 * One brief, and the invariant that makes replacing four builders with it safe:
 * **the bytes do not move** (#509).
 *
 * `renderTaskText`'s literal output is load-bearing in five test assertions
 * elsewhere, in `policy/scratch.ts`'s `TASK_PREFIX_RE`, and in `App.tsx`, which
 * feeds the rendered string to the policy engine so the decision cannot diverge
 * from the real dispatch. Changing the wire format is a behavioural change
 * across every dispatch in the product, unmeasurable without evals — so the
 * change is to the TYPE, and this file is what says so.
 *
 * The expectations below are the literals the previous hand-rolled builders
 * produced, written out rather than computed. Computing them from the new
 * renderer would make the test agree with whatever the renderer does, which is
 * the one thing it must not do.
 */

describe('the common brief renders exactly what renderTaskText always did', () => {
  it.each([
    [{ task: 'do the thing' }, 'Task: do the thing'],
    [{ task: 'do the thing', context: 'on node 22' }, 'Task: do the thing\n\nContext: on node 22'],
    [{ task: 'do it', label: 'Request' }, 'Request: do it'],
    [{ task: 'do it', label: 'Request', context: 'here' }, 'Request: do it\n\nContext: here'],
  ])('%j', (input, expected) => {
    expect(renderTaskText(input)).toBe(expected);
  });

  it('drops an empty context rather than emitting a bare heading', () => {
    // The old form tested `input.context` for truthiness, so `''` produced no
    // section. A renderer that emitted `Context: ` for it would be a byte
    // change on every caller that passes an optional field through.
    expect(renderTaskText({ task: 'a', context: '' })).toBe('Task: a');
    expect(renderBrief({ task: 'a', sections: [{ label: 'Context', body: '' }] })).toBe('Task: a');
  });
});

describe('the three PAC phases render exactly what they hand-rolled', () => {
  const attachments = undefined;

  it('planner: task, context, prior plan, critic feedback', () => {
    const msg = pacPlannerDefinition.buildUserMessage({
      task: 'ship it',
      context: 'staging only',
      priorPlan: '1. do X',
      criticFeedback: 'X was wrong',
      slotId: 0,
      attachments,
    } as never);
    expect(msg).toEqual({
      role: 'user',
      content:
        'Task: ship it\n\n' +
        'Context: staging only\n\n' +
        'Prior plan (rejected by Critic):\n1. do X\n\n' +
        'Critic feedback to address:\nX was wrong',
    });
  });

  it('planner: omits the retry sections on a first pass', () => {
    const msg = pacPlannerDefinition.buildUserMessage({ task: 'ship it', slotId: 0 } as never);
    expect(msg).toEqual({ role: 'user', content: 'Task: ship it' });
  });

  it('actor: task, context, plan', () => {
    const msg = pacActorDefinition.buildUserMessage({
      task: 'ship it',
      context: 'staging only',
      plan: '1. do X',
      slotId: 0,
    } as never);
    expect(msg).toEqual({
      role: 'user',
      content: 'Task: ship it\n\nContext: staging only\n\nPlan to execute:\n1. do X',
    });
  });

  it('critic: its own leading label, and its trailing unlabelled instruction', () => {
    // `Original task:` rather than `Task:`, and a final paragraph with no
    // heading at all. Both preserved as data rather than normalised: the
    // divergence is now visible in one table instead of buried in a third
    // builder, which is what #509 asked for. Making the labels agree moves the
    // bytes and needs an eval.
    const msg = pacCriticDefinition.buildUserMessage({
      task: 'ship it',
      context: 'staging only',
      plan: '1. do X',
      actorOutput: 'did X',
      slotId: 0,
    } as never);
    expect(msg).toEqual({
      role: 'user',
      content:
        'Original task: ship it\n\n' +
        'Context: staging only\n\n' +
        'Plan (from Planner):\n1. do X\n\n' +
        "Actor's report:\ndid X\n\n" +
        'Verify the success criteria. Emit your final JSON verdict per the format rules.',
    });
  });
});

describe('tool-wrapper keeps its label and gains a data channel', () => {
  it('renders Request:, not Task:', () => {
    // Kept for byte stability. An earlier comment claimed prompts and tests read
    // it verbatim; measured, `grep "Request:"` over src/ and docs/ returns
    // nothing — the real reason is that every wrapper dispatch has read it.
    const msg = toolWrapperDefinition.buildUserMessage({
      specialistId: 's',
      input: 'run ls',
      slotId: 0,
      childTools: {},
      wantStructured: false,
    } as never);
    expect(msg).toEqual({ role: 'user', content: 'Request: run ls' });
  });

  it('renders caller data under the same heading it always did', () => {
    // `apps/dispatch.ts` has always put `renderArgsBlock`'s output in the
    // context slot. The channel is a distinct field now and the type refuses a
    // swap, but the wire format is unchanged — the block carries its own
    // "DATA supplied by an external caller" banner, so the heading adds nothing
    // semantically and could be renamed once an eval says what it costs.
    const msg = toolWrapperDefinition.buildUserMessage({
      specialistId: 's',
      input: 'answer the question',
      data: untrustedData('BANNER\n```json\n{"q":"x"}\n```'),
      slotId: 0,
      childTools: {},
      wantStructured: false,
    } as never);
    expect(msg).toEqual({
      role: 'user',
      content: 'Request: answer the question\n\nContext: BANNER\n```json\n{"q":"x"}\n```',
    });
  });

  it('renders the data channel LAST, after every instruction section', () => {
    const msg = toolWrapperDefinition.buildUserMessage({
      specialistId: 's',
      input: 'go',
      context: 'author-written',
      data: untrustedData('CALLER BYTES'),
      slotId: 0,
      childTools: {},
      wantStructured: false,
    } as never);
    const content = (msg as { content: string }).content;
    expect(content.indexOf('author-written')).toBeLessThan(content.indexOf('CALLER BYTES'));
  });
});

describe('attachTo', () => {
  it('returns a plain string on the zero-attachment path', () => {
    // The array form is a shape change, and applying it on a path that is not
    // using the feature would be blast radius — it is also what keeps every
    // `toEqual({role:'user', content:'Task: …'})` in the suite true.
    expect(attachTo('Task: plain')).toEqual({ role: 'user', content: 'Task: plain' });
  });

  it('splices attachments in after the text', () => {
    const msg = buildBriefUserMessage({
      task: 'look at this',
      attachments: [{ mimeType: 'image/png', data: Buffer.from('x') }],
    });
    expect(Array.isArray(msg.content)).toBe(true);
    expect((msg.content as unknown[])[0]).toEqual({ type: 'text', text: 'Task: look at this' });
  });
});
