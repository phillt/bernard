import { describe, it, expect } from 'vitest';
import { Narrator } from './narrator.js';

describe('Narrator', () => {
  it('says what was written before each tool call, and never the final reply', () => {
    const said: string[] = [];
    const n = new Narrator((t) => said.push(t));
    n.onEvent({ kind: 'text-delta', text: 'Let me check ' });
    n.onEvent({ kind: 'text-delta', text: 'your inbox.' });
    n.onEvent({ kind: 'tool-call', callId: 'a', toolName: 'gmail', args: {} });
    n.onEvent({ kind: 'tool-call', callId: 'b', toolName: 'gmail', args: {} });
    n.onEvent({ kind: 'text-delta', text: 'You have three unread emails.' });
    expect(said).toEqual(['Let me check your inbox.']);
  });

  it("ignores a sub-agent's text", () => {
    const said: string[] = [];
    const n = new Narrator((t) => said.push(t));
    n.onEvent({ kind: 'text-delta', text: 'internal working', agentLabel: 'sub:1' });
    n.onEvent({ kind: 'tool-call', callId: 'a', toolName: 'x', args: {} });
    expect(said).toEqual([]);
  });

  it('forgets what it collected on reset', () => {
    const said: string[] = [];
    const n = new Narrator((t) => said.push(t));
    n.onEvent({ kind: 'text-delta', text: 'from the last turn' });
    n.reset();
    n.onEvent({ kind: 'tool-call', callId: 'a', toolName: 'x', args: {} });
    expect(said).toEqual([]);
  });
});
