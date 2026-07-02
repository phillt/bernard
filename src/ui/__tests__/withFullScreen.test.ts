import { describe, it, expect } from 'vitest';
import { withFullScreen } from '../withFullScreen.js';

function fakeStdout() {
  const writes: string[] = [];
  const stream = {
    write: (s: string) => {
      writes.push(s);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stream, writes, joined: () => writes.join('') };
}

describe('withFullScreen', () => {
  it('enters the alt buffer, hides the cursor, and enables mouse on start', () => {
    const out = fakeStdout();
    const handle = withFullScreen({ mouse: true, stdout: out.stream });
    const joined = out.joined();
    expect(joined).toContain('\x1b[?1049h'); // alt buffer
    expect(joined).toContain('\x1b[?25l'); // hide cursor
    expect(joined).toContain('\x1b[?1000h\x1b[?1006h'); // mouse on
    // Alt buffer comes before mouse enable.
    expect(joined.indexOf('\x1b[?1049h')).toBeLessThan(joined.indexOf('\x1b[?1000h'));
    handle.teardown();
  });

  it('restores the terminal on teardown in reverse order', () => {
    const out = fakeStdout();
    const handle = withFullScreen({ mouse: true, stdout: out.stream });
    out.writes.length = 0; // isolate the teardown output
    handle.teardown();
    const joined = out.joined();
    expect(joined).toContain('\x1b[?1006l\x1b[?1000l'); // mouse off
    expect(joined).toContain('\x1b[?25h'); // show cursor
    expect(joined).toContain('\x1b[?1049l'); // leave alt buffer
    // Mouse disabled BEFORE leaving the alt buffer.
    expect(joined.indexOf('\x1b[?1000l')).toBeLessThan(joined.indexOf('\x1b[?1049l'));
  });

  it('teardown is idempotent (second call writes nothing)', () => {
    const out = fakeStdout();
    const handle = withFullScreen({ mouse: true, stdout: out.stream });
    handle.teardown();
    out.writes.length = 0;
    handle.teardown();
    expect(out.writes).toEqual([]);
  });

  it('omits mouse escapes when mouse is disabled', () => {
    const out = fakeStdout();
    const handle = withFullScreen({ mouse: false, stdout: out.stream });
    expect(out.joined()).not.toContain('\x1b[?1000h');
    out.writes.length = 0;
    handle.teardown();
    expect(out.joined()).not.toContain('\x1b[?1000l');
    expect(out.joined()).toContain('\x1b[?1049l');
  });

  it('removes its process listeners on teardown', () => {
    const before = process.listenerCount('SIGINT');
    const handle = withFullScreen({ mouse: true, stdout: fakeStdout().stream });
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
    handle.teardown();
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});
