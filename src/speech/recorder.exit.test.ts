import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const children: (EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: () => void;
})[] = [];
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      pid: 1,
      kill: vi.fn(),
    });
    children.push(child);
    return child;
  }),
}));

const { startMic } = await import('./recorder.js');

describe('startMic exit handling', () => {
  beforeEach(() => {
    children.length = 0;
  });

  it('reports a recorder that stops on its own with code 0', () => {
    const onError = vi.fn();
    startMic('pw-record', () => undefined, onError);
    children[0].emit('close', 0, null);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toContain('stopped on its own');
  });

  it('says nothing when we stopped it', () => {
    const onError = vi.fn();
    const mic = startMic('pw-record', () => undefined, onError);
    mic.stop();
    children[0].emit('close', null, 'SIGTERM');
    expect(onError).not.toHaveBeenCalled();
  });

  it('names the exit code and what the recorder said', () => {
    const onError = vi.fn();
    startMic('pw-record', () => undefined, onError);
    children[0].stderr.emit('data', Buffer.from('no such device\n'));
    children[0].emit('close', 1, null);
    expect((onError.mock.calls[0][0] as Error).message).toBe(
      'pw-record exited with code 1: no such device',
    );
  });
});
