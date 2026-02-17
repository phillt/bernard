import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockNotify, mockOn, mockSpawn, mockExecSync } = vi.hoisted(() => ({
  mockNotify: vi.fn(),
  mockOn: vi.fn(),
  mockSpawn: vi.fn(() => ({ unref: vi.fn() })),
  mockExecSync: vi.fn(),
}));

let mockPlatform = 'linux';

vi.mock('node-notifier', () => ({
  default: {
    notify: mockNotify,
    on: mockOn,
  },
}));

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

vi.mock('node:os', () => ({
  platform: () => mockPlatform,
}));

import { sendNotification } from './notify.js';

describe('sendNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlatform = 'linux';
  });

  // This test must run first — the click listener is registered once per module lifecycle
  it('registers click listener on first call', () => {
    sendNotification({
      title: 'T',
      message: 'M',
      severity: 'normal',
      alertId: 'alert-first',
    });

    expect(mockOn).toHaveBeenCalledWith('click', expect.any(Function));
  });

  it('calls notifier.notify with correct title and message', () => {
    sendNotification({
      title: 'Test Title',
      message: 'Test message',
      severity: 'normal',
      alertId: 'alert-1',
    });

    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Test Title',
        message: 'Test message',
      }),
    );
  });

  it('sets urgency from severity', () => {
    sendNotification({
      title: 'T',
      message: 'M',
      severity: 'critical',
      alertId: 'alert-2',
    });

    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        urgency: 'critical',
      }),
    );
  });

  it('enables sound only for critical severity', () => {
    sendNotification({
      title: 'T',
      message: 'M',
      severity: 'normal',
      alertId: 'alert-3',
    });

    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ sound: false }));

    mockNotify.mockClear();

    sendNotification({
      title: 'T',
      message: 'M',
      severity: 'critical',
      alertId: 'alert-4',
    });

    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ sound: true }));
  });

  it('disables wait on Linux (click callbacks not supported)', () => {
    mockPlatform = 'linux';

    sendNotification({
      title: 'T',
      message: 'M',
      severity: 'normal',
      alertId: 'alert-5',
    });

    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ wait: false }));
  });

  it('enables wait on macOS', () => {
    mockPlatform = 'darwin';

    sendNotification({
      title: 'T',
      message: 'M',
      severity: 'normal',
      alertId: 'alert-6',
    });

    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ wait: true }));
  });

  it('does not register multiple click listeners', () => {
    sendNotification({
      title: 'T',
      message: 'M',
      severity: 'normal',
      alertId: 'alert-8',
    });

    sendNotification({
      title: 'T2',
      message: 'M2',
      severity: 'low',
      alertId: 'alert-9',
    });

    // on('click') should have been called at most once across the module lifetime
    // (the beforeEach clears mocks, but the module-level flag persists)
    const clickCalls = mockOn.mock.calls.filter(([event]: [string]) => event === 'click');
    expect(clickCalls.length).toBeLessThanOrEqual(1);
  });
});
