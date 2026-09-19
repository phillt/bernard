import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

// --- Mocks ---

const mockStore = {
  loadJobs: vi.fn().mockReturnValue([]),
  getJob: vi.fn(),
  createJob: vi.fn(),
  updateJob: vi.fn(),
  deleteJob: vi.fn(),
  saveJobs: vi.fn(),
  listAlerts: vi.fn().mockReturnValue([]),
};

vi.mock('../cron/store.js', () => ({
  CronStore: vi.fn(() => mockStore),
}));

const mockRunJob = vi.hoisted(() => vi.fn());

vi.mock('../cron/runner.js', () => ({
  runJob: mockRunJob,
}));

vi.mock('../cron/client.js', () => ({
  isDaemonRunning: vi.fn().mockReturnValue(false),
  startDaemon: vi.fn().mockReturnValue(true),
  stopDaemon: vi.fn().mockReturnValue(true),
}));

import { createCronTool } from './cron.js';

/**
 * Cron tools were consolidated from 18 single-purpose tools into 3 action-enum
 * tools (#253). These tests are a deliberate like-for-like migration — same
 * setup, same assertions — so behaviour drift surfaces as a failure rather than
 * being edited away. `call('create')` stands in for `tools.cron_create.execute!`.
 */
describe('cron tools', () => {
  let tools: ReturnType<typeof createCronTool>;

  const call =
    (action: string) =>
    (args: any = {}) =>
      (tools.cron as any).execute({ action, ...args }, {} as any);

  beforeEach(() => {
    vi.clearAllMocks();
    tools = createCronTool();
  });

  describe('parameter schema', () => {
    // One schema now serves every action, so each field is optional and
    // per-action requirements are enforced in the handler instead (#253).
    // These parse-level tests still matter: they guard against a field being
    // dropped or mangled on the way through zod — the long-prompt case below
    // is the one that caught real truncation before.
    const parse = (input: Record<string, unknown>) => (tools.cron as any).parameters.parse(input);

    it('should parse update with prompt through Zod schema', () => {
      const parsed = parse({ action: 'update', id: 'test-id-123', prompt: 'New prompt text here' });
      expect(parsed.id).toBe('test-id-123');
      expect(parsed.prompt).toBe('New prompt text here');
    });

    it('should parse update with all fields through Zod schema', () => {
      const parsed = parse({
        action: 'update',
        id: 'test-id-123',
        name: 'New name',
        schedule: '0 8 * * *',
        prompt: 'New prompt',
      });
      expect(parsed.name).toBe('New name');
      expect(parsed.schedule).toBe('0 8 * * *');
      expect(parsed.prompt).toBe('New prompt');
    });

    it('should parse update with only id (no optional fields)', () => {
      const parsed = parse({ action: 'update', id: 'test-id-123' });
      expect(parsed.prompt).toBeUndefined();
      expect(parsed.name).toBeUndefined();
      expect(parsed.schedule).toBeUndefined();
    });

    it('should preserve a long multi-line prompt through Zod parsing', () => {
      const longPrompt = `Good morning! Please provide Phil with his daily briefing. Include:

1. **Email Check**: Use the Google Gmail API tools
2. **Calendar**: Check today's schedule
3. **Weather**: Get the local forecast

If anything urgent needs Phil's attention, use the notify tool to alert him.`;

      const parsed = parse({ action: 'update', id: 'test-id', prompt: longPrompt });
      expect(parsed.prompt).toBe(longPrompt);
    });

    it('should parse create with all three parameters', () => {
      const parsed = parse({
        action: 'create',
        name: 'Test',
        schedule: '0 * * * *',
        prompt: 'Do stuff',
      });
      expect(parsed.name).toBe('Test');
      expect(parsed.schedule).toBe('0 * * * *');
      expect(parsed.prompt).toBe('Do stuff');
    });

    it('rejects an unknown action at the schema level', () => {
      expect(() => parse({ action: 'nope' })).toThrow();
    });
  });

  describe('per-action required fields', () => {
    // Consolidation moved these checks from zod to the handlers: a shared
    // schema cannot say "id is required, but only for six of ten actions".
    // The handler must therefore answer with actionable guidance rather than
    // throwing, which is what these pin.
    it('create reports the fields it needs instead of throwing', async () => {
      const result = await call('create')({ name: 'Test', schedule: '0 * * * *' });
      expect(result).toContain('requires');
      expect(result).toContain('prompt');
    });

    it.each(['get', 'delete', 'enable', 'disable', 'run', 'update'])(
      '%s reports that it needs an id',
      async (action) => {
        const result = await call(action)({});
        expect(result).toContain('requires');
        expect(result).toContain('id');
      },
    );
  });

  describe('cron_update execute', () => {
    it('should return error when no fields provided (only id)', async () => {
      const result = await call('update')({ id: 'test-id-123' });

      expect(result).toContain('Error: update requires at least one field to change');
      expect(result).toContain('Received parameters:');
      const receivedPart = result.split('Received parameters: ')[1];
      expect(receivedPart).toBe('id.');
      expect(receivedPart).not.toContain('prompt');
      expect(receivedPart).not.toContain('name');
      expect(receivedPart).not.toContain('schedule');
    });

    it('should successfully update when prompt is provided', async () => {
      const updatedJob = {
        id: 'test-id-123',
        name: 'My Job',
        schedule: '0 * * * *',
        prompt: 'Updated prompt',
        enabled: true,
        createdAt: '2025-01-01T00:00:00.000Z',
      };
      mockStore.updateJob.mockReturnValue(updatedJob);

      const result = await call('update')({ id: 'test-id-123', prompt: 'Updated prompt' });

      expect(result).toContain('Job updated');
      expect(result).not.toContain('Error');
      expect(mockStore.updateJob).toHaveBeenCalledWith('test-id-123', { prompt: 'Updated prompt' });
    });

    it('should successfully update when name is provided', async () => {
      const updatedJob = {
        id: 'test-id-123',
        name: 'New Name',
        schedule: '0 * * * *',
        prompt: 'Existing prompt',
        enabled: true,
        createdAt: '2025-01-01T00:00:00.000Z',
      };
      mockStore.updateJob.mockReturnValue(updatedJob);

      const result = await call('update')({ id: 'test-id-123', name: 'New Name' });

      expect(result).toContain('Job updated');
      expect(mockStore.updateJob).toHaveBeenCalledWith('test-id-123', { name: 'New Name' });
    });

    it('should successfully update when schedule is provided', async () => {
      const updatedJob = {
        id: 'test-id-123',
        name: 'My Job',
        schedule: '0 8 * * *',
        prompt: 'Existing prompt',
        enabled: true,
        createdAt: '2025-01-01T00:00:00.000Z',
      };
      mockStore.updateJob.mockReturnValue(updatedJob);

      const result = await call('update')({ id: 'test-id-123', schedule: '0 8 * * *' });

      expect(result).toContain('Job updated');
      expect(mockStore.updateJob).toHaveBeenCalledWith('test-id-123', { schedule: '0 8 * * *' });
    });

    it('should return error for invalid schedule on update', async () => {
      const result = await call('update')({ id: 'test-id-123', schedule: 'not-a-cron' });

      expect(result).toContain('Error: Invalid cron expression');
    });

    it('should return error if job ID not found', async () => {
      mockStore.updateJob.mockReturnValue(undefined);

      const result = await call('update')({ id: 'nonexistent-id', prompt: 'New prompt' });

      expect(result).toContain('Error: No job found');
    });

    it('should report received parameters dynamically in error', async () => {
      const result = await call('update')({ id: 'test-id-123' });

      expect(result).toMatch(/Received parameters:.*id/);
    });

    it('should treat empty string prompt as missing', async () => {
      const result = await call('update')({ id: 'test-id-123', prompt: '' });

      expect(result).toContain('Error: update requires at least one field to change');
    });
  });

  describe('cron_run execute', () => {
    it('should return error when job not found', async () => {
      mockStore.getJob.mockReturnValue(undefined);

      const result = await call('run')({ id: 'nonexistent' });

      expect(result).toContain('Error: No job found');
    });

    it('should call runJob and return formatted output on success', async () => {
      const job = {
        id: 'test-id',
        name: 'Test Job',
        schedule: '0 * * * *',
        prompt: 'Do something',
        enabled: true,
        createdAt: '2025-01-01T00:00:00.000Z',
      };
      mockStore.getJob.mockReturnValue(job);
      mockRunJob.mockResolvedValue({ success: true, output: 'Task completed' });

      const result = await call('run')({ id: 'test-id' });

      expect(result).toContain('Test Job');
      expect(result).toContain('Success');
      expect(result).toContain('Task completed');
      expect(mockRunJob).toHaveBeenCalledWith(job, expect.any(Function));
      expect(mockStore.updateJob).toHaveBeenCalledWith(
        'test-id',
        expect.objectContaining({
          lastRunStatus: 'running',
        }),
      );
      expect(mockStore.updateJob).toHaveBeenCalledWith(
        'test-id',
        expect.objectContaining({
          lastRunStatus: 'success',
        }),
      );
    });

    it('should catch runJob throw and update status to error', async () => {
      const job = {
        id: 'test-id',
        name: 'Throwing Job',
        schedule: '0 * * * *',
        prompt: 'Do something',
        enabled: true,
        createdAt: '2025-01-01T00:00:00.000Z',
      };
      mockStore.getJob.mockReturnValue(job);
      mockRunJob.mockRejectedValue(new Error('config load failed'));

      const result = await call('run')({ id: 'test-id' });

      expect(result).toContain('Throwing Job');
      expect(result).toContain('Error');
      expect(result).toContain('config load failed');
      expect(mockStore.updateJob).toHaveBeenCalledWith(
        'test-id',
        expect.objectContaining({
          lastRunStatus: 'error',
          lastResult: 'config load failed',
        }),
      );
    });

    it('should include disabled notice for disabled jobs', async () => {
      const job = {
        id: 'test-id',
        name: 'Disabled Job',
        schedule: '0 * * * *',
        prompt: 'Do something',
        enabled: false,
        createdAt: '2025-01-01T00:00:00.000Z',
      };
      mockStore.getJob.mockReturnValue(job);
      mockRunJob.mockResolvedValue({ success: true, output: 'Done' });

      const result = await call('run')({ id: 'test-id' });

      expect(result).toContain('currently disabled');
      expect(result).toContain('Success');
    });

    it('should return error when job is already running', async () => {
      const job = {
        id: 'test-id',
        name: 'Running Job',
        schedule: '0 * * * *',
        prompt: 'Do something',
        enabled: true,
        createdAt: '2025-01-01T00:00:00.000Z',
        lastRunStatus: 'running',
      };
      mockStore.getJob.mockReturnValue(job);

      const result = await call('run')({ id: 'test-id' });

      expect(result).toContain('already running');
      expect(mockRunJob).not.toHaveBeenCalled();
      expect(mockStore.updateJob).not.toHaveBeenCalled();
    });

    it('should handle runJob failure', async () => {
      const job = {
        id: 'test-id',
        name: 'Failing Job',
        schedule: '0 * * * *',
        prompt: 'Do something',
        enabled: true,
        createdAt: '2025-01-01T00:00:00.000Z',
      };
      mockStore.getJob.mockReturnValue(job);
      mockRunJob.mockResolvedValue({ success: false, output: 'Error: API down' });

      const result = await call('run')({ id: 'test-id' });

      expect(result).toContain('Failing Job');
      expect(result).toContain('Error');
      expect(result).toContain('API down');
      expect(mockStore.updateJob).toHaveBeenCalledWith(
        'test-id',
        expect.objectContaining({
          lastRunStatus: 'error',
        }),
      );
    });
  });

  describe('create refuses a twin of an enabled job (#401)', () => {
    const existing = {
      id: 'old-id',
      name: 'Nightly',
      schedule: '0 0 * * *',
      prompt: 'do the thing',
      enabled: true,
      createdAt: '2026-06-12T00:00:00.000Z',
    };

    it('refuses, and names the job and both ways forward', async () => {
      // 42 identical jobs were created without a murmur. A warning that still
      // writes the row is what would have happened 42 times.
      mockStore.loadJobs.mockReturnValue([existing]);

      const result = await call('create')({
        name: 'Something else entirely',
        schedule: '0 0 * * *',
        prompt: 'do the thing',
      });

      expect(result).toContain('Error');
      expect(result).toContain('old-id');
      expect(result).toContain('"action":"update"');
      expect(mockStore.createJob).not.toHaveBeenCalled();
    });

    it('ignores the name, because two jobs differing only in label still collide', async () => {
      mockStore.loadJobs.mockReturnValue([{ ...existing, name: 'Totally Different' }]);
      const result = await call('create')({
        name: 'Nightly',
        schedule: '0 0 * * *',
        prompt: 'do the thing',
      });
      expect(result).toContain('Error');
    });

    it('creates when the prompt or the schedule differs', async () => {
      mockStore.loadJobs.mockReturnValue([existing]);
      mockStore.createJob.mockReturnValue({ ...existing, id: 'new-id', prompt: 'something else' });

      const result = await call('create')({
        name: 'Nightly',
        schedule: '0 0 * * *',
        prompt: 'something else',
      });
      expect(result).toContain('Cron job created');
      expect(mockStore.createJob).toHaveBeenCalled();
    });

    it('creates but points at a disabled twin, which is probably the job that was meant', async () => {
      mockStore.loadJobs.mockReturnValue([{ ...existing, enabled: false }]);
      mockStore.createJob.mockReturnValue({ ...existing, id: 'new-id' });

      const result = await call('create')({
        name: 'Nightly',
        schedule: '0 0 * * *',
        prompt: 'do the thing',
      });
      expect(result).toContain('Cron job created');
      expect(result).toContain('a disabled job has the same schedule and prompt');
      expect(result).toContain('old-id');
    });

    it('says how many jobs there are once the pile is large enough to matter', async () => {
      const many = Array.from({ length: 21 }, (_, i) => ({
        ...existing,
        id: `j${i}`,
        prompt: `prompt ${i}`,
      }));
      mockStore.loadJobs.mockReturnValue(many);
      mockStore.createJob.mockReturnValue({ ...existing, id: 'new-id' });

      const result = await call('create')({
        name: 'Nightly',
        schedule: '0 0 * * *',
        prompt: 'brand new prompt',
      });
      expect(result).toContain('21 cron jobs');
      expect(result).toContain('cron-delete');
    });
  });

  describe('catchUp (#400)', () => {
    it('is carried through create and reported back', async () => {
      mockStore.loadJobs.mockReturnValue([]);
      mockStore.createJob.mockImplementation(
        (name: string, schedule: string, prompt: string, options: Record<string, unknown>) => ({
          id: 'new-id',
          name,
          schedule,
          prompt,
          enabled: true,
          createdAt: 'now',
          ...options,
        }),
      );

      const result = await call('create')({
        name: 'Monitor',
        schedule: '0 */2 * * *',
        prompt: 'check replies',
        catchUp: true,
      });
      expect(mockStore.createJob).toHaveBeenCalledWith('Monitor', '0 */2 * * *', 'check replies', {
        catchUp: true,
      });
      expect(result).toContain('Catch up missed runs: true');
    });

    it('is a field update on its own, with nothing else changed', async () => {
      // Without this, turning catch-up on would require also re-sending the
      // prompt or the schedule, which is how a prompt gets clobbered.
      mockStore.updateJob.mockReturnValue({
        id: 'test-id',
        name: 'Monitor',
        schedule: '0 */2 * * *',
        enabled: true,
        catchUp: true,
      });

      const result = await call('update')({ id: 'test-id', catchUp: true });
      expect(mockStore.updateJob).toHaveBeenCalledWith('test-id', { catchUp: true });
      expect(result).toContain('Catch up missed runs: true');
    });

    it('still refuses an update that changes nothing at all', async () => {
      const result = await call('update')({ id: 'test-id' });
      expect(result).toContain('at least one field');
      expect(result).toContain('catchUp');
    });
  });
});
