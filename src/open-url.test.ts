import { describe, it, expect } from 'vitest';
import { browserCommand } from './open-url.js';

describe('browserCommand', () => {
  it('uses each platform’s own opener', () => {
    expect(browserCommand('http://x', 'darwin')).toEqual({ command: 'open', args: ['http://x'] });
    expect(browserCommand('http://x', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['http://x'],
    });
  });

  /**
   * `start` is a cmd builtin, and its FIRST quoted argument is the window
   * title. Without the empty string a quoted URL is read as the title and
   * nothing opens — the classic way this is got wrong.
   */
  it('passes the empty title argument Windows start requires', () => {
    const cmd = browserCommand('http://x', 'win32');
    expect(cmd).toEqual({ command: 'cmd', args: ['/c', 'start', '', 'http://x'] });
  });

  it('has nothing to try on an unknown platform, rather than guessing', () => {
    expect(browserCommand('http://x', 'freebsd')).toBeNull();
  });
});
