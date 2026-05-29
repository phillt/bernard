import { describe, it, expect } from 'vitest';
import { classifyError } from './error-taxonomy.js';

describe('classifyError', () => {
  describe('HTTP status mapping', () => {
    it.each([
      [401, 'auth', false],
      [403, 'permission', false],
      [404, 'not_found', false],
      [408, 'rate_limit', false],
      [429, 'rate_limit', false],
      [500, 'transient', false],
      [502, 'transient', false],
      [503, 'transient', false],
      [504, 'transient', false],
    ] as const)('HTTP %s -> %s (correctable=%s)', (status, category, correctable) => {
      const cls = classifyError({ message: 'irrelevant', httpStatus: status });
      expect(cls.category).toBe(category);
      expect(cls.correctable).toBe(correctable);
    });
  });

  describe('errno mapping', () => {
    it('ENOENT -> not_found', () => {
      expect(classifyError({ message: '', errno: 'ENOENT' }).category).toBe('not_found');
    });
    it('EACCES -> permission', () => {
      expect(classifyError({ message: '', errno: 'EACCES' }).category).toBe('permission');
    });
    it('EPERM -> permission', () => {
      expect(classifyError({ message: '', errno: 'EPERM' }).category).toBe('permission');
    });
    it('ETIMEDOUT -> timeout', () => {
      expect(classifyError({ message: '', errno: 'ETIMEDOUT' }).category).toBe('timeout');
    });
    it('ECONNREFUSED -> transient', () => {
      expect(classifyError({ message: '', errno: 'ECONNREFUSED' }).category).toBe('transient');
    });
  });

  describe('message pattern matching', () => {
    it('detects pool exhaustion', () => {
      const cls = classifyError({
        message: 'Error (pool_exhausted): Maximum concurrent agents (4) reached.',
      });
      expect(cls.category).toBe('pool_exhausted');
      expect(cls.correctable).toBe(false);
    });

    it('detects parse_failed from wrapper marker', () => {
      const cls = classifyError({
        message: 'Specialist did not produce valid structured output',
      });
      expect(cls.category).toBe('parse_failed');
      expect(cls.correctable).toBe(false);
    });

    it('detects HTTP 404 in error string (web context, not correctable)', () => {
      const cls = classifyError({
        message: 'web_read failed: HTTP 404 Not Found for https://example.com/missing',
        toolName: 'web_read',
      });
      expect(cls.category).toBe('not_found');
      expect(cls.correctable).toBe(false);
    });

    it('detects rate limit phrasing', () => {
      const cls = classifyError({
        message: 'API rate limit exceeded for user',
      });
      expect(cls.category).toBe('rate_limit');
    });

    it('detects "command not found" in shell context (correctable)', () => {
      const cls = classifyError({
        message: 'bash: foobarbaz: command not found',
        toolName: 'shell',
      });
      expect(cls.category).toBe('not_found');
      expect(cls.correctable).toBe(true);
    });

    it('detects permission denied filesystem error', () => {
      const cls = classifyError({
        message: 'mkdir: cannot create directory ‘/root/x’: Permission denied',
      });
      expect(cls.category).toBe('permission');
    });

    it('detects timeout phrasing', () => {
      const cls = classifyError({ message: 'request timed out after 30s' });
      expect(cls.category).toBe('timeout');
    });

    it('detects missing API key', () => {
      const cls = classifyError({ message: 'Error: no API key configured for openai' });
      expect(cls.category).toBe('auth');
    });

    it('detects network failure', () => {
      const cls = classifyError({ message: 'fetch failed: ECONNRESET' });
      expect(cls.category).toBe('transient');
    });

    it('detects invalid arguments', () => {
      const cls = classifyError({ message: 'Invalid tool arguments: zod validation failed' });
      expect(cls.category).toBe('invalid_args');
      expect(cls.correctable).toBe(true);
    });

    it('detects generic shell exec failure', () => {
      const cls = classifyError({ message: 'command failed with exit code 1: syntax error' });
      expect(cls.category).toBe('exec_failed');
      expect(cls.correctable).toBe(true);
    });

    it('falls back to unknown', () => {
      const cls = classifyError({ message: 'something weird happened' });
      expect(cls.category).toBe('unknown');
      expect(cls.correctable).toBe(false);
    });

    it('detects user cancellation', () => {
      const cls = classifyError({ message: 'Operation cancelled by user' });
      expect(cls.category).toBe('cancelled');
    });
  });

  describe('not_found context split', () => {
    it('shell command-not-found is correctable', () => {
      const cls = classifyError({
        message: 'bash: nonesuch: command not found',
        toolName: 'shell',
      });
      expect(cls.correctable).toBe(true);
    });

    it('web 404 is NOT correctable even with same string match', () => {
      const cls = classifyError({
        message: 'HTTP 404 not found',
        toolName: 'web_read',
      });
      expect(cls.correctable).toBe(false);
    });

    it('not_found with no tool context is NOT correctable (safe default)', () => {
      const cls = classifyError({ message: 'HTTP 404 not found' });
      expect(cls.correctable).toBe(false);
    });
  });

  describe('severity', () => {
    it('auth is critical', () => {
      expect(classifyError({ message: '', httpStatus: 401 }).severity).toBe('critical');
    });
    it('permission is critical', () => {
      expect(classifyError({ message: '', httpStatus: 403 }).severity).toBe('critical');
    });
    it('rate_limit is normal', () => {
      expect(classifyError({ message: '', httpStatus: 429 }).severity).toBe('normal');
    });
    it('transient is low', () => {
      expect(classifyError({ message: '', httpStatus: 503 }).severity).toBe('low');
    });
  });

  describe('retryable', () => {
    it('transient errors are retryable', () => {
      expect(classifyError({ message: '', httpStatus: 503 }).retryable).toBe(true);
    });
    it('auth errors are NOT retryable', () => {
      expect(classifyError({ message: '', httpStatus: 401 }).retryable).toBe(false);
    });
    it('rate_limit is NOT auto-retryable', () => {
      expect(classifyError({ message: '', httpStatus: 429 }).retryable).toBe(false);
    });
  });

  describe('playbook', () => {
    it('every classification carries a playbook', () => {
      const cls = classifyError({ message: 'random error' });
      expect(cls.playbook.user).toBeTruthy();
      expect(cls.playbook.model).toBeTruthy();
    });
  });
});
