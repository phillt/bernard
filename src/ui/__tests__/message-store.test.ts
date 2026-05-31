import { describe, it, expect, vi } from 'vitest';
import { MessageStore, type StreamEvent } from '../message-store.js';

describe('MessageStore', () => {
  it('returns an empty snapshot before any events', () => {
    const store = new MessageStore();
    expect(store.getSnapshot()).toEqual([]);
  });

  it('appends events and flips snapshot identity per append', () => {
    const store = new MessageStore();
    const a = store.getSnapshot();
    store.append({ kind: 'text-delta', text: 'hi' });
    const b = store.getSnapshot();
    store.append({ kind: 'text-delta', text: ' there' });
    const c = store.getSnapshot();
    // useSyncExternalStore relies on reference inequality to detect changes.
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(c).toEqual([
      { kind: 'text-delta', text: 'hi' },
      { kind: 'text-delta', text: ' there' },
    ]);
  });

  it('notifies subscribers on every append', () => {
    const store = new MessageStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.append({ kind: 'text-delta', text: 'a' });
    store.append({ kind: 'text-delta', text: 'b' });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    store.append({ kind: 'text-delta', text: 'c' });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('reset clears events and notifies subscribers', () => {
    const store = new MessageStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.append({ kind: 'text-delta', text: 'x' });
    listener.mockClear();
    store.reset();
    expect(store.getSnapshot()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reset is a no-op when the store is already empty', () => {
    const store = new MessageStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.reset();
    expect(listener).not.toHaveBeenCalled();
  });

  it('supports multiple independent subscribers', () => {
    const store = new MessageStore();
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = store.subscribe(a);
    store.subscribe(b);
    store.append({ kind: 'text-delta', text: '1' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    unsubA();
    store.append({ kind: 'text-delta', text: '2' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('subscribe / getSnapshot are bound so they work when destructured', () => {
    const store = new MessageStore();
    const { subscribe, getSnapshot } = store;
    const listener = vi.fn();
    subscribe(listener);
    store.append({ kind: 'text-delta', text: 'bound' });
    expect(listener).toHaveBeenCalled();
    expect(getSnapshot()).toEqual([{ kind: 'text-delta', text: 'bound' }]);
  });

  it('accepts every StreamEvent variant', () => {
    const store = new MessageStore();
    const events: StreamEvent[] = [
      { kind: 'text-delta', text: 'hello' },
      { kind: 'tool-call', callId: 'c1', toolName: 'shell', args: { command: 'ls' } },
      { kind: 'tool-result', callId: 'c1', result: 'ok', isError: false },
      {
        kind: 'tool-result',
        callId: 'c2',
        result: 'boom',
        isError: true,
        agentLabel: 'sub:2',
      },
    ];
    for (const e of events) store.append(e);
    expect(store.getSnapshot()).toEqual(events);
  });
});
