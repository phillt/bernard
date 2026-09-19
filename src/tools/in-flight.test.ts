import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  LONG_CALL_NOTICE_MS,
  __resetInFlightCalls,
  beginToolCall,
  displayToolName,
  endToolCall,
  pendingCallNotice,
  runTracked,
  inFlightForDispatch,
  enterToolWrapper,
  exitToolWrapper,
  __wrapperDepthSize,
} from './in-flight.js';
import { runWithDispatchId } from '../framework/dispatch-context.js';
import type { ToolMeta } from '../framework/tools/types.js';

describe('the in-flight registry (#594)', () => {
  beforeEach(() => __resetInFlightCalls());

  it('says nothing until a call has been running long enough', () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    beginToolCall('beeper.send_message');
    vi.restoreAllMocks();

    expect(pendingCallNotice(now + LONG_CALL_NOTICE_MS - 1, LONG_CALL_NOTICE_MS)).toBeNull();
    expect(pendingCallNotice(now + LONG_CALL_NOTICE_MS, LONG_CALL_NOTICE_MS)).toEqual({
      label: 'beeper.send_message',
      ms: LONG_CALL_NOTICE_MS,
    });
  });

  it('names the most recently started call, not the longest running', () => {
    // The incident nested three dispatches: `delegate_beeper` →
    // `specialist_run` → `beeper.send_message`. The longest running is the
    // OUTERMOST, and naming a frame that is merely waiting on another frame says
    // less than naming the one that is actually blocked.
    const now = 1_000_000;
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(now);
    beginToolCall('delegate_beeper');
    clock.mockReturnValue(now + 100);
    beginToolCall('specialist_run');
    clock.mockReturnValue(now + 200);
    beginToolCall('beeper.send_message');
    clock.mockRestore();

    expect(pendingCallNotice(now + 60_000, 10_000)?.label).toBe('beeper.send_message');
  });

  it('forgets a call that has finished', () => {
    const id = beginToolCall('shell');
    endToolCall(id);
    expect(pendingCallNotice(Date.now() + 60_000, 0)).toBeNull();
  });

  it('keys on a minted id, so one tool can be in flight twice', () => {
    // A name-keyed map would have the second registration evict the first, and
    // the first completion clear both — and the SDK runs a step's tool calls in
    // parallel while four dispatches run concurrently.
    const a = beginToolCall('web_read');
    beginToolCall('web_read');
    endToolCall(a);
    expect(pendingCallNotice(Date.now() + 60_000, 0)?.label).toBe('web_read');
  });

  it('deregisters through `runTracked` even when the call throws', () => {
    // A hung call staying registered is the point; a FAILED one staying
    // registered would pin a stale name on the spinner for the rest of the
    // session.
    return expect(runTracked('shell', () => Promise.reject(new Error('boom'))))
      .rejects.toThrow('boom')
      .then(() => {
        expect(pendingCallNotice(Date.now() + 60_000, 0)).toBeNull();
      });
  });
});

describe('what a call is called', () => {
  const meta = (over: Partial<ToolMeta>): ToolMeta => ({ name: 'x', kind: 'read', ...over });

  it('rebuilds an MCP name from the metadata the manager authored', () => {
    // The registry key is namespaced and, at the truncation ladder's last rung,
    // not invertible — so this reads `category` / `rawName` rather than parsing
    // the key back apart.
    expect(
      displayToolName(
        'beeper_654785__send_message',
        meta({ category: 'mcp.beeper', rawName: 'send_message' }),
      ),
    ).toBe('beeper.send_message');
  });

  it('leaves a built-in tool under its own name', () => {
    expect(displayToolName('shell', meta({ category: 'shell' }))).toBe('shell');
    expect(displayToolName('subagent')).toBe('subagent');
  });

  it('falls back to the key when the metadata is incomplete', () => {
    expect(displayToolName('beeper_654785__send_message', meta({ category: 'mcp.beeper' }))).toBe(
      'beeper_654785__send_message',
    );
  });
});

/**
 * The wrapper-depth registry (#607). Separate from the call registry above
 * because the two want different brackets: the notice wants the narrow one, the
 * runner's liveness guard the widest available.
 */
describe('inFlightForDispatch (#607)', () => {
  beforeEach(() => __resetInFlightCalls());

  it('counts only the wrappers this dispatch is inside', async () => {
    // Keying on the dispatch is what makes the guard recursive: a parent blocked
    // on `subagent` pauses on its OWN wrapper while the child's tools belong to
    // the child's clock. Counted globally, one busy dispatch would silence every
    // other dispatch's guard for as long as it ran.
    const seen: Record<string, number> = {};
    await runWithDispatchId('aaaa', async () => {
      const outer = enterToolWrapper();
      await runWithDispatchId('bbbb', async () => {
        const a = enterToolWrapper();
        const b = enterToolWrapper();
        seen.childFromChild = inFlightForDispatch('bbbb');
        seen.parentFromChild = inFlightForDispatch('aaaa');
        exitToolWrapper(a);
        exitToolWrapper(b);
      });
      exitToolWrapper(outer);
    });
    expect(seen).toEqual({ childFromChild: 2, parentFromChild: 1 });
    expect(inFlightForDispatch('aaaa')).toBe(0);
    expect(inFlightForDispatch('cccc')).toBe(0);
  });

  it('is the WIDE bracket: a pending gate counts, and the notice still does not name it', () => {
    // The whole reason this is a second registry. `runTracked` sits inside
    // `runOrdered`, after both permission gates, so a call parked on a confirm
    // prompt is not a running call — but the dispatch is unmistakably inside a
    // tool and its step cannot finish.
    runWithDispatchId('aaaa', () => {
      const id = enterToolWrapper();
      expect(inFlightForDispatch('aaaa')).toBe(1);
      expect(pendingCallNotice(Date.now() + 60_000, 10_000)).toBeNull();
      exitToolWrapper(id);
    });
    expect(inFlightForDispatch('aaaa')).toBe(0);
  });

  it('forgets a dispatch once its last wrapper returns', () => {
    // A dispatch id is never reused, so a key left holding a `0` is an unbounded
    // map in a process that stays up for days — the cron daemon, the applet host.
    runWithDispatchId('aaaa', () => exitToolWrapper(enterToolWrapper()));
    expect(__wrapperDepthSize()).toBe(0);
  });

  it('registers nothing when no dispatch is active', () => {
    // `apps/tool-dispatch.ts` runs a tool with no model at all. Nothing there is
    // waiting on a step boundary, so an un-keyed wrapper must not be
    // attributable to some other dispatch's id.
    const id = enterToolWrapper();
    expect(id).toBeUndefined();
    expect(inFlightForDispatch('aaaa')).toBe(0);
    exitToolWrapper(id);
    expect(__wrapperDepthSize()).toBe(0);
  });
});
