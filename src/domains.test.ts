import { describe, it, expect } from 'vitest';
import {
  DOMAIN_REGISTRY,
  DEFAULT_DOMAIN,
  getDomainIds,
  getDomain,
  type MemoryDomain,
} from './domains.js';

describe('DOMAIN_REGISTRY', () => {
  it('contains tool-usage, user-preferences, and general domains', () => {
    expect(DOMAIN_REGISTRY).toHaveProperty('tool-usage');
    expect(DOMAIN_REGISTRY).toHaveProperty('user-preferences');
    expect(DOMAIN_REGISTRY).toHaveProperty('general');
  });

  it('all domains have required fields', () => {
    for (const [key, domain] of Object.entries(DOMAIN_REGISTRY)) {
      expect(domain.id).toBe(key);
      expect(domain.name).toBeTruthy();
      expect(domain.description).toBeTruthy();
      expect(domain.extractionPrompt).toBeTruthy();
    }
  });

  it('each extraction prompt contains "Extract:" and "Do NOT extract:" sections', () => {
    for (const domain of Object.values(DOMAIN_REGISTRY)) {
      expect(domain.extractionPrompt).toContain('Extract:');
      expect(domain.extractionPrompt).toContain('Do NOT extract:');
    }
  });

  it('each extraction prompt requests JSON array output', () => {
    for (const domain of Object.values(DOMAIN_REGISTRY)) {
      expect(domain.extractionPrompt).toContain('JSON array of strings');
    }
  });

  it('each extraction prompt contains Good/Bad examples', () => {
    for (const domain of Object.values(DOMAIN_REGISTRY)) {
      expect(domain.extractionPrompt).toContain('Good:');
      expect(domain.extractionPrompt).toContain('Bad:');
    }
  });

  it('each extraction prompt emphasizes durable/long-term knowledge', () => {
    for (const domain of Object.values(DOMAIN_REGISTRY)) {
      expect(domain.extractionPrompt).toMatch(/durable|long-term/i);
    }
  });

  it('general prompt mentions people and relationships', () => {
    const prompt = DOMAIN_REGISTRY['general'].extractionPrompt;
    expect(prompt).toContain('People, relationships, and contact methods');
  });

  it('general prompt excludes ephemeral UI state', () => {
    const prompt = DOMAIN_REGISTRY['general'].extractionPrompt;
    expect(prompt).toContain('Ephemeral UI state');
  });

  it('tool-usage prompt requires application or system context', () => {
    const prompt = DOMAIN_REGISTRY['tool-usage'].extractionPrompt;
    expect(prompt).toContain('application or system being operated on');
  });

  it('tool-usage prompt excludes individual UI interactions without context', () => {
    const prompt = DOMAIN_REGISTRY['tool-usage'].extractionPrompt;
    expect(prompt).toContain('Individual UI interactions');
  });

  it('user-preferences prompt excludes task-specific preferences', () => {
    const prompt = DOMAIN_REGISTRY['user-preferences'].extractionPrompt;
    expect(prompt).toContain('only apply to the current task');
  });
});

describe('DEFAULT_DOMAIN', () => {
  it('is "general"', () => {
    expect(DEFAULT_DOMAIN).toBe('general');
  });

  it('exists in the registry', () => {
    expect(DOMAIN_REGISTRY).toHaveProperty(DEFAULT_DOMAIN);
  });
});

describe('getDomainIds', () => {
  it('returns all registered domain IDs', () => {
    const ids = getDomainIds();
    expect(ids).toContain('tool-usage');
    expect(ids).toContain('user-preferences');
    expect(ids).toContain('general');
    expect(ids).toHaveLength(Object.keys(DOMAIN_REGISTRY).length);
  });
});

describe('getDomain', () => {
  it('returns the correct domain for a known ID', () => {
    const domain = getDomain('tool-usage');
    expect(domain.id).toBe('tool-usage');
    expect(domain.name).toBe('Tool Usage Patterns');
  });

  it('falls back to general for unknown IDs', () => {
    const domain = getDomain('nonexistent-domain');
    expect(domain.id).toBe('general');
    expect(domain.name).toBe('General Knowledge');
  });

  it('falls back to general for empty string', () => {
    const domain = getDomain('');
    expect(domain.id).toBe('general');
  });
});
