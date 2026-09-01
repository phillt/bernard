import { describe, it, expect } from 'vitest';
import {
  MCP_NAME_MAX,
  mcpServerSegment,
  mcpToolName,
  parseMCPToolName,
  aliasesOf,
  buildMCPAliasIndex,
  resolveMCPName,
} from './mcp-names.js';

describe('mcpServerSegment', () => {
  it('is deterministic and depends only on the server name', () => {
    expect(mcpServerSegment('playwright')).toBe(mcpServerSegment('playwright'));
    expect(mcpServerSegment('playwright')).toMatch(/^playwright_[0-9a-f]{6}$/);
  });

  // The entire reason the hash exists. The predecessor was a numeric suffix
  // assigned in iteration order, so adding a server could renumber a different
  // server's key — and that key is persisted in permission grants.
  it('does not move when other servers are added, removed or reordered', () => {
    const before = ['playwright', 'browsermcp'].map(mcpServerSegment);
    const after = ['browsermcp', 'zzz-new', 'playwright'].map(mcpServerSegment);
    expect(after).toContain(before[0]);
    expect(after).toContain(before[1]);
  });

  it('separates names that sanitize to the same label', () => {
    expect(mcpServerSegment('my.server')).not.toBe(mcpServerSegment('my-server'));
    expect(mcpServerSegment('my.server').startsWith('my_server_')).toBe(true);
    expect(mcpServerSegment('my-server').startsWith('my-server_')).toBe(true);
  });
});

describe('mcpToolName truncation ladder', () => {
  it('R0: keeps the readable form when it fits', () => {
    expect(mcpToolName('playwright', 'browser_click')).toMatch(
      /^playwright_[0-9a-f]{6}__browser_click$/,
    );
  });

  // Today's real worst case, from a live four-server config.
  it('R0 covers the longest name in a real config', () => {
    const n = mcpToolName('google-mcp', 'google_calendar_get_event_instances');
    expect(n.length).toBeLessThanOrEqual(MCP_NAME_MAX);
    expect(n).toContain('__google_calendar_get_event_instances');
  });

  // R0 is `label(<=24) + _ + hash6 + __ + tool` = 33 + tool, so the label is
  // never what overflows — a long *tool* name is. R1 buys back those 25
  // characters rather than cutting the tool, because the tool half is what a
  // reader needs to recognise the call.
  it('R1: drops the human label but keeps the hash and the whole tool name', () => {
    const tool = 'google_calendar_get_recurring_event_instances_v2';
    expect(`playwright_abc123__${tool}`.length).toBeGreaterThan(MCP_NAME_MAX);

    const n = mcpToolName('playwright', tool);

    expect(n).toBe(`${n.slice(0, 6)}__${tool}`);
    expect(n).toMatch(/^[0-9a-f]{6}__/);
    expect(n.length).toBeLessThanOrEqual(MCP_NAME_MAX);
  });

  it('R1 still separates two servers exporting the same long tool name', () => {
    const tool = 'google_calendar_get_recurring_event_instances_v2';
    expect(mcpToolName('alpha', tool)).not.toBe(mcpToolName('beta', tool));
  });

  it('R2: cuts the tool name in the middle, keeping both ends and a tool hash', () => {
    const n = mcpToolName('srv', 'a'.repeat(40) + 'MIDDLE' + 'z'.repeat(40));
    expect(n.length).toBe(MCP_NAME_MAX);
    expect(n).toMatch(/^[0-9a-f]{6}__a+_[0-9a-f]{4}_z+$/);
  });

  it('R2 keeps distinct tools distinct when both are truncated', () => {
    const long = 'x'.repeat(80);
    expect(mcpToolName('srv', `${long}_alpha`)).not.toBe(mcpToolName('srv', `${long}_beta`));
  });

  it('never exceeds the ceiling or the SDK charset, even for pathological input', () => {
    for (const [s, t] of [
      ['s'.repeat(200), 't'.repeat(200)],
      ['sérvér/with spaces', 'tool.with.dots'],
      ['a', 'b'],
    ]) {
      const n = mcpToolName(s, t);
      expect(n.length).toBeLessThanOrEqual(MCP_NAME_MAX);
      expect(n).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });
});

describe('parseMCPToolName', () => {
  it('round-trips R0 and R1', () => {
    expect(parseMCPToolName(mcpToolName('playwright', 'browser_click'))).toEqual({
      serverSegment: expect.stringMatching(/^playwright_[0-9a-f]{6}$/),
      tool: 'browser_click',
    });
    expect(parseMCPToolName(mcpToolName('a'.repeat(60), 'browser_click'))?.tool).toBe(
      'browser_click',
    );
  });

  it('returns null for a bare name or a built-in', () => {
    expect(parseMCPToolName('browser_click')).toBeNull();
    expect(parseMCPToolName('shell')).toBeNull();
    expect(parseMCPToolName('__leading')).toBeNull();
  });

  // Some servers really do export names containing `__`; re-splitting them
  // would invent a server that does not exist.
  it('splits on the first separator, leaving a tool name that contains one intact', () => {
    expect(parseMCPToolName('srv_abc123__weird__tool')).toEqual({
      serverSegment: 'srv_abc123',
      tool: 'weird__tool',
    });
  });
});

describe('alias index', () => {
  const playwrightClick = mcpToolName('playwright', 'browser_click');
  const browsermcpClick = mcpToolName('browsermcp', 'browser_click');
  const playwrightDrag = mcpToolName('playwright', 'browser_drag');

  it('resolves a bare stored name when exactly one server exports it', () => {
    const live = new Set([playwrightClick, playwrightDrag]);
    const ix = buildMCPAliasIndex(live);
    expect(resolveMCPName('browser_drag', live, ix)).toBe(playwrightDrag);
  });

  // The behaviour the user chose: ambiguous grants are not honoured.
  it('fails closed when two servers export the same bare name', () => {
    const live = new Set([playwrightClick, browsermcpClick]);
    const ix = buildMCPAliasIndex(live);
    expect(ix.get('browser_click')).toBeNull();
    expect(resolveMCPName('browser_click', live, ix)).toBeNull();
  });

  it('an exact live name always wins over any alias', () => {
    const live = new Set([playwrightClick, 'browser_click']);
    const ix = buildMCPAliasIndex(live);
    expect(resolveMCPName('browser_click', live, ix)).toBe('browser_click');
  });

  it('resolves the unhashed <server>__<tool> form', () => {
    const live = new Set([playwrightClick]);
    const ix = buildMCPAliasIndex(live);
    expect(resolveMCPName('playwright__browser_click', live, ix)).toBe(playwrightClick);
  });

  it('covers delegate keys so existing delegate grants keep resolving', () => {
    const key = `delegate_${mcpServerSegment('playwright')}`;
    expect(aliasesOf(key)).toContain('delegate_playwright');
    const live = new Set([key]);
    expect(resolveMCPName('delegate_playwright', live, buildMCPAliasIndex(live))).toBe(key);
  });

  it('returns null for a name nothing claims', () => {
    const live = new Set([playwrightClick]);
    expect(resolveMCPName('never_existed', live, buildMCPAliasIndex(live))).toBeNull();
  });

  it('does not alias Bernard built-ins', () => {
    expect(aliasesOf('shell')).toEqual([]);
    expect(aliasesOf('web_search')).toEqual([]);
  });
});
