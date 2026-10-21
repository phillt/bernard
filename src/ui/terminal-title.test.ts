import { describe, it, expect, afterEach } from 'vitest';
import { setTerminalTitle } from './terminal-title.js';

function fakeStdout(isTTY: boolean) {
  const writes: string[] = [];
  return {
    writes,
    stream: {
      isTTY,
      write: (s: string) => (writes.push(s), true),
    } as unknown as NodeJS.WriteStream,
  };
}

describe('setTerminalTitle', () => {
  afterEach(() => process.removeAllListeners('exit'));

  it('saves the old title, sets the new one, and gives the old one back once', () => {
    const out = fakeStdout(true);
    const handle = setTerminalTitle('Bernard', out.stream);
    expect(out.writes).toEqual(['\x1b[22;0t\x1b]0;Bernard\x07']);
    handle.restore();
    handle.restore();
    expect(out.writes).toEqual(['\x1b[22;0t\x1b]0;Bernard\x07', '\x1b[23;0t']);
  });

  it('restores on process exit when nothing else did', () => {
    const out = fakeStdout(true);
    setTerminalTitle('Bernard', out.stream);
    process.emit('exit', 0);
    expect(out.writes.at(-1)).toBe('\x1b[23;0t');
  });

  it('writes nothing when stdout is not a terminal', () => {
    const out = fakeStdout(false);
    setTerminalTitle('Bernard', out.stream).restore();
    expect(out.writes).toEqual([]);
  });
});
