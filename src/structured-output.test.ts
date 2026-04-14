import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  extractJsonBlock,
  parseStructuredOutput,
  wrapWrapperResult,
  WrapperResultSchema,
  STRUCTURED_OUTPUT_RULES,
} from './structured-output.js';

describe('extractJsonBlock', () => {
  it('returns undefined when start does not point at {', () => {
    expect(extractJsonBlock('hello {world}', 0)).toBeUndefined();
    expect(extractJsonBlock('hello {world}', 6)).toBe('{world}');
  });

  it('extracts a simple object', () => {
    const text = '{"key":"value"}';
    expect(extractJsonBlock(text, 0)).toBe('{"key":"value"}');
  });

  it('extracts nested objects', () => {
    const text = '{"outer":{"inner":1}}';
    expect(extractJsonBlock(text, 0)).toBe('{"outer":{"inner":1}}');
  });

  it('ignores braces inside string values', () => {
    const text = '{"key":"has {brace} inside"}';
    expect(extractJsonBlock(text, 0)).toBe('{"key":"has {brace} inside"}');
  });

  it('handles escaped quotes inside strings', () => {
    const text = '{"key":"she said \\"hello {world}\\""}';
    expect(extractJsonBlock(text, 0)).toBe('{"key":"she said \\"hello {world}\\""}');
  });

  it('returns undefined for unbalanced braces', () => {
    expect(extractJsonBlock('{"unclosed":', 0)).toBeUndefined();
  });

  it('extracts block starting at offset within a longer string', () => {
    const text = 'prefix {"a":1} suffix';
    expect(extractJsonBlock(text, 7)).toBe('{"a":1}');
  });

  it('handles deeply nested objects', () => {
    const text = '{"a":{"b":{"c":42}}}';
    expect(extractJsonBlock(text, 0)).toBe('{"a":{"b":{"c":42}}}');
  });
});

const SimpleSchema = z.object({ foo: z.string() });
const NumSchema = z.object({ n: z.number() });

describe('parseStructuredOutput', () => {
  it('parses direct JSON that matches schema', () => {
    const result = parseStructuredOutput('{"foo":"bar"}', SimpleSchema);
    expect(result).toEqual({ foo: 'bar' });
  });

  it('finds JSON embedded in prose', () => {
    const text = 'Here is the answer: {"foo":"baz"} and that is it.';
    expect(parseStructuredOutput(text, SimpleSchema)).toEqual({ foo: 'baz' });
  });

  it('picks the first valid block when multiple exist', () => {
    const text = '{"foo":"first"} then {"foo":"second"}';
    expect(parseStructuredOutput(text, SimpleSchema)).toEqual({ foo: 'first' });
  });

  it('skips blocks that fail schema validation and tries the next', () => {
    const text = '{"wrong":"field"} then {"foo":"valid"}';
    expect(parseStructuredOutput(text, SimpleSchema)).toEqual({ foo: 'valid' });
  });

  it('returns undefined when schema is not satisfied by any block', () => {
    const text = '{"bar":"baz"} and {"quux":1}';
    expect(parseStructuredOutput(text, SimpleSchema)).toBeUndefined();
  });

  it('returns undefined when there is no JSON', () => {
    expect(parseStructuredOutput('just some plain text', SimpleSchema)).toBeUndefined();
  });

  it('handles numeric values in schema', () => {
    expect(parseStructuredOutput('{"n":42}', NumSchema)).toEqual({ n: 42 });
  });
});

describe('WrapperResultSchema', () => {
  it('validates a correct ok shape', () => {
    const input = { status: 'ok', result: 'done' };
    const r = WrapperResultSchema.safeParse(input);
    expect(r.success).toBe(true);
  });

  it('validates a correct error shape with optional fields', () => {
    const input = {
      status: 'error',
      result: null,
      error: 'something failed',
      reasoning: ['tried tool A', 'tried tool B'],
    };
    const r = WrapperResultSchema.safeParse(input);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.error).toBe('something failed');
      expect(r.data.reasoning).toHaveLength(2);
    }
  });

  it('allows ok/error without optional fields', () => {
    expect(WrapperResultSchema.safeParse({ status: 'ok', result: 42 }).success).toBe(true);
    expect(WrapperResultSchema.safeParse({ status: 'error', result: {} }).success).toBe(true);
  });

  it('rejects when status is missing', () => {
    const r = WrapperResultSchema.safeParse({ result: 'x' });
    expect(r.success).toBe(false);
  });

  it('rejects when status is an invalid enum value', () => {
    const r = WrapperResultSchema.safeParse({ status: 'unknown', result: 'x' });
    expect(r.success).toBe(false);
  });

  it('accepts when result is missing (z.any() permits undefined)', () => {
    // WrapperResultSchema uses z.any() for result, so an absent key is valid
    const r = WrapperResultSchema.safeParse({ status: 'ok' });
    expect(r.success).toBe(true);
  });

  it('rejects when reasoning is not an array of strings', () => {
    const r = WrapperResultSchema.safeParse({ status: 'ok', result: 'x', reasoning: 'flat string' });
    expect(r.success).toBe(false);
  });
});

describe('wrapWrapperResult', () => {
  it('parses a valid ok JSON string correctly', () => {
    const text = JSON.stringify({ status: 'ok', result: 'success' });
    const result = wrapWrapperResult(text);
    expect(result.status).toBe('ok');
    expect(result.result).toBe('success');
    expect(result.error).toBeUndefined();
    expect(result.reasoning).toBeUndefined();
  });

  it('parses a valid error JSON string correctly', () => {
    const text = JSON.stringify({
      status: 'error',
      result: null,
      error: 'command not found',
      reasoning: ['tried ls', 'tried find'],
    });
    const result = wrapWrapperResult(text);
    expect(result.status).toBe('error');
    expect(result.result).toBeNull();
    expect(result.error).toBe('command not found');
    expect(result.reasoning).toEqual(['tried ls', 'tried find']);
  });

  it('does not include error key when not present in parsed output', () => {
    const text = JSON.stringify({ status: 'ok', result: 42 });
    const result = wrapWrapperResult(text);
    expect('error' in result).toBe(false);
  });

  it('does not include reasoning key when not present in parsed output', () => {
    const text = JSON.stringify({ status: 'ok', result: 42 });
    const result = wrapWrapperResult(text);
    expect('reasoning' in result).toBe(false);
  });

  it('returns structured error with parse_failed for invalid JSON', () => {
    const result = wrapWrapperResult('this is not json at all');
    expect(result.status).toBe('error');
    expect(result.error).toBe('parse_failed');
    expect(result.result).toBe('Specialist did not produce valid structured output');
    expect(Array.isArray(result.reasoning)).toBe(true);
  });

  it('returns structured error with parse_failed for JSON that fails schema validation', () => {
    const result = wrapWrapperResult('{"wrong_key":"value"}');
    expect(result.status).toBe('error');
    expect(result.error).toBe('parse_failed');
  });

  it('includes truncated original text in reasoning on parse_failed', () => {
    const longText = 'x'.repeat(600);
    const result = wrapWrapperResult(longText);
    expect(result.reasoning).toBeDefined();
    expect(result.reasoning![0]).toHaveLength(500);
  });

  it('extracts valid JSON embedded in surrounding prose', () => {
    const text = 'Some preamble\n{"status":"ok","result":"extracted"}\nsome trailing text';
    const result = wrapWrapperResult(text);
    expect(result.status).toBe('ok');
    expect(result.result).toBe('extracted');
  });
});

describe('STRUCTURED_OUTPUT_RULES', () => {
  it('is a non-empty string', () => {
    expect(typeof STRUCTURED_OUTPUT_RULES).toBe('string');
    expect(STRUCTURED_OUTPUT_RULES.length).toBeGreaterThan(0);
  });

  it('mentions required JSON keys', () => {
    expect(STRUCTURED_OUTPUT_RULES).toContain('status');
    expect(STRUCTURED_OUTPUT_RULES).toContain('result');
    expect(STRUCTURED_OUTPUT_RULES).toContain('reasoning');
  });
});
