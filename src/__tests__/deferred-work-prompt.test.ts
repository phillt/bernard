import { describe, it, expect } from 'vitest';

import { BASE_SYSTEM_PROMPT } from '../agent-prompt.js';

/**
 * The prompt must not contradict the tools (#479).
 *
 * This is not a style check. Before watchers landed, the Execution Model said
 * outright that Bernard "cannot ... check back later, poll for changes, or
 * initiate future actions", and that "the only mechanism for deferred or
 * recurring work is cron jobs". Both were true when written and both became
 * FALSE the moment `watcher` reached the main registry — and a prompt that
 * denies a capability is worse than one that never mentions it, because the
 * model will decline the request or reach for cron instead. The tool was
 * present, correctly scoped, fully tested, and effectively unreachable.
 *
 * The failure mode is silent: nothing errors, the user just gets "I can't do
 * that" from a Bernard that can.
 */
describe('the system prompt does not deny what the tools provide', () => {
  it('does not claim cron is the only way to defer work', () => {
    expect(BASE_SYSTEM_PROMPT).not.toMatch(/only mechanism for deferred/i);
  });

  it('does not claim it cannot check back or poll', () => {
    // Narrowly targeted: the old sentence listed these three verbs as things
    // Bernard cannot do. It is fine to say it cannot act on its OWN initiative
    // between turns — that is still true — but not that it cannot be asked to.
    expect(BASE_SYSTEM_PROMPT).not.toMatch(/cannot act between turns, check back later/i);
  });

  it('tells the model when to reach for a watcher', () => {
    // Presence in the registry is not discoverability. The tool description
    // says WHAT a watcher is; this says WHEN, which is the half that decides
    // whether it is ever used.
    expect(BASE_SYSTEM_PROMPT).toMatch(/\bwatcher\b/);
    expect(BASE_SYSTEM_PROMPT).toMatch(/set a watcher instead/i);
  });

  it('keeps cron and watchers distinguishable', () => {
    // They are not interchangeable and the difference is the one thing a model
    // will get wrong: cron recurs and outlives the session, a watcher is
    // one-shot and bound to it.
    expect(BASE_SYSTEM_PROMPT).toMatch(/RECURRING/);
    expect(BASE_SYSTEM_PROMPT).toMatch(/ONE-SHOT/);
  });

  it('states the limitation rather than overselling it', () => {
    // A watcher only polls while a session is open. A model that promises
    // overnight monitoring has made a promise the mechanism cannot keep.
    expect(BASE_SYSTEM_PROMPT).toMatch(/only polls while a session is open/i);
  });
});
