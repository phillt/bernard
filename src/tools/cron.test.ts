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

vi.mock('../cron/client.js', () => ({
  isDaemonRunning: vi.fn().mockReturnValue(false),
  startDaemon: vi.fn().mockReturnValue(true),
  stopDaemon: vi.fn().mockReturnValue(true),
}));

import { createCronTools } from './cron.js';

describe('cron tools', () => {
  let tools: ReturnType<typeof createCronTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    tools = createCronTools();
  });

  describe('cron_update parameter schema', () => {
    it('should parse update with prompt through Zod schema', () => {
      const input = {
        id: 'test-id-123',
        prompt: 'New prompt text here',
      };
      const parsed = tools.cron_update.parameters.parse(input);
      expect(parsed.id).toBe('test-id-123');
      expect(parsed.prompt).toBe('New prompt text here');
    });

    it('should parse update with all fields through Zod schema', () => {
      const input = {
        id: 'test-id-123',
        name: 'New name',
        schedule: '0 8 * * *',
        prompt: 'New prompt',
      };
      const parsed = tools.cron_update.parameters.parse(input);
      expect(parsed.name).toBe('New name');
      expect(parsed.schedule).toBe('0 8 * * *');
      expect(parsed.prompt).toBe('New prompt');
    });

    it('should parse update with only id (no optional fields)', () => {
      const input = { id: 'test-id-123' };
      const parsed = tools.cron_update.parameters.parse(input);
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

      const input = { id: 'test-id', prompt: longPrompt };
      const parsed = tools.cron_update.parameters.parse(input);
      expect(parsed.prompt).toBe(longPrompt);
    });
  });

  describe('cron_create parameter schema', () => {
    it('should require all three parameters', () => {
      const input = { name: 'Test', schedule: '0 * * * *', prompt: 'Do stuff' };
      const parsed = tools.cron_create.parameters.parse(input);
      expect(parsed.name).toBe('Test');
      expect(parsed.schedule).toBe('0 * * * *');
      expect(parsed.prompt).toBe('Do stuff');
    });

    it('should reject missing prompt', () => {
      expect(() => {
        tools.cron_create.parameters.parse({ name: 'Test', schedule: '0 * * * *' });
      }).toThrow();
    });
  });

  describe('cron_update execute', () => {
    it('should return error when no fields provided (only id)', async () => {
      const result = await tools.cron_update.execute!(
        { id: 'test-id-123' },
        {} as any,
      );

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

      const result = await tools.cron_update.execute!(
        { id: 'test-id-123', prompt: 'Updated prompt' },
        {} as any,
      );

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

      const result = await tools.cron_update.execute!(
        { id: 'test-id-123', name: 'New Name' },
        {} as any,
      );

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

      const result = await tools.cron_update.execute!(
        { id: 'test-id-123', schedule: '0 8 * * *' },
        {} as any,
      );

      expect(result).toContain('Job updated');
      expect(mockStore.updateJob).toHaveBeenCalledWith('test-id-123', { schedule: '0 8 * * *' });
    });

    it('should return error for invalid schedule on update', async () => {
      const result = await tools.cron_update.execute!(
        { id: 'test-id-123', schedule: 'not-a-cron' },
        {} as any,
      );

      expect(result).toContain('Error: Invalid cron expression');
    });

    it('should return error if job ID not found', async () => {
      mockStore.updateJob.mockReturnValue(undefined);

      const result = await tools.cron_update.execute!(
        { id: 'nonexistent-id', prompt: 'New prompt' },
        {} as any,
      );

      expect(result).toContain('Error: No job found');
    });

    it('should report received parameters dynamically in error', async () => {
      const result = await tools.cron_update.execute!(
        { id: 'test-id-123' },
        {} as any,
      );

      expect(result).toMatch(/Received parameters:.*id/);
    });

    it('should treat empty string prompt as missing', async () => {
      const result = await tools.cron_update.execute!(
        { id: 'test-id-123', prompt: '' },
        {} as any,
      );

      expect(result).toContain('Error: update requires at least one field to change');
    });
  });
});
