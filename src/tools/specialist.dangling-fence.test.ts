import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mcpToolName, mcpServerSegment } from '../mcp-names.js';
import type { Specialist } from '../specialists.js';

/**
 * A `targetTools` fence naming a server that is gone (#377).
 *
 * Removing an MCP server deliberately never edits a specialist, so the only
 * thing standing between a user and a permanently degraded record is being
 * told — and `buildChildTools` drops an unmatched fence entry in silence
 * (#331), so nothing says it at use time. These are the standing surfaces.
 *
 * `../mcp.js` is mocked rather than driven through a real `mcp.json`, because
 * the sibling suite mocks `node:fs` wholesale for the specialist store and the
 * two reads would fight over the same mock.
 */
const listMCPServers = vi.fn<[], Array<{ key: string }>>(() => []);
vi.mock('../mcp.js', () => ({ listMCPServers: () => listMCPServers() }));

const records: Specialist[] = [];
vi.mock('../specialists.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../specialists.js')>();
  return {
    ...actual,
    SpecialistStore: class {
      list() {
        return records;
      }
      get(id: string) {
        return records.find((r) => r.id === id);
      }
    },
  };
});

const { createSpecialistTool } = await import('./specialist.js');

function record(id: string, targetTools?: string[]): Specialist {
  return {
    id,
    name: id,
    description: 'test',
    systemPrompt: 'test',
    kind: 'tool-wrapper',
    createdAt: 'x',
    updatedAt: 'x',
    guidelines: [],
    goodExamples: [],
    badExamples: [],
    ...(targetTools ? { targetTools } : {}),
  } as Specialist;
}

const PW_CLICK = mcpToolName('playwright', 'browser_click');
const PW_DELEGATE = `delegate_${mcpServerSegment('playwright')}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (args: Record<string, unknown>) =>
  createSpecialistTool().execute!(args as any, {} as any);

beforeEach(() => {
  records.length = 0;
  listMCPServers.mockReturnValue([]);
});

describe('dangling fence entries', () => {
  it('flags a fence entry whose server is no longer configured', async () => {
    records.push(record('browser-driver', [PW_CLICK, 'shell']));
    listMCPServers.mockReturnValue([{ key: 'beeper' }]);

    const read = (await run({ action: 'read', id: 'browser-driver' })) as string;

    expect(read).toContain(PW_CLICK);
    expect(read).toContain('names no configured MCP server');
    // Singular entry, singular grammar.
    expect(read).toContain('runs without it.');
    // The remedy, named — a warning that does not say what to do is noise.
    expect(read).toContain('Update targetTools, or re-add the server');
  });

  it('says nothing when the server is still configured', async () => {
    records.push(record('browser-driver', [PW_CLICK, PW_DELEGATE]));
    listMCPServers.mockReturnValue([{ key: 'playwright' }]);

    const read = (await run({ action: 'read', id: 'browser-driver' })) as string;

    expect(read).toContain('Target tools:');
    expect(read).not.toContain('no configured MCP server');
  });

  it('never flags a bare name, for the reason it is never attributed', async () => {
    // Indistinguishable from a Bernard built-in from here, so flagging it would
    // mean flagging `shell` and `web_read` in every fence on the install.
    records.push(record('mixed', ['browser_click', 'shell', 'web_read', 'file_read_lines']));
    listMCPServers.mockReturnValue([{ key: 'beeper' }]);

    const read = (await run({ action: 'read', id: 'mixed' })) as string;

    expect(read).not.toContain('no configured MCP server');
  });

  it('covers the delegate spellings too', async () => {
    records.push(record('deleg', [PW_DELEGATE, 'delegate_playwright']));
    listMCPServers.mockReturnValue([{ key: 'beeper' }]);

    const read = (await run({ action: 'read', id: 'deleg' })) as string;

    expect(read).toContain(PW_DELEGATE);
    expect(read).toContain('delegate_playwright');
    // Two entries, plural grammar — the other half of the same rule.
    expect(read).toContain('name no configured MCP server');
    expect(read).toContain('runs without them.');
  });

  it('marks the row and footers the listing', async () => {
    records.push(record('browser-driver', [PW_CLICK]), record('fine', ['shell']));
    listMCPServers.mockReturnValue([{ key: 'beeper' }]);

    const list = (await run({ action: 'list' })) as string;

    expect(list).toContain('browser-driver');
    expect(list).toContain('⚠ 1 dead tool');
    expect(list).toContain('  - browser-driver: ' + PW_CLICK);
    // The healthy record keeps its row clean, or the mark means nothing.
    expect(list.split('\n').find((l) => l.includes('- fine —'))).not.toContain('⚠');
  });

  it('says nothing at all when no fence is dangling', async () => {
    records.push(record('fine', ['shell']), record('wide', undefined));
    listMCPServers.mockReturnValue([{ key: 'beeper' }]);

    const list = (await run({ action: 'list' })) as string;

    expect(list).not.toContain('⚠');
  });

  it('does flag everything MCP-shaped when the config is simply empty', async () => {
    // The other half of the `null`-not-`[]` distinction: no servers configured
    // is a real answer, and an MCP-shaped fence entry then genuinely names
    // nothing. Without this the silent-on-unreadable case below could be
    // "satisfied" by never flagging anything.
    records.push(record('browser-driver', [PW_CLICK]));
    listMCPServers.mockReturnValue([]);

    const read = (await run({ action: 'read', id: 'browser-driver' })) as string;

    expect(read).toContain('no configured MCP server');
  });

  it('stays silent when mcp.json cannot be read, rather than flagging everything', async () => {
    // "The question cannot be answered" is not "everything is dangling", and a
    // listing must never fail over a config file.
    records.push(record('browser-driver', [PW_CLICK]));
    listMCPServers.mockImplementation(() => {
      throw new Error('Invalid JSON in mcp.json');
    });

    const list = (await run({ action: 'list' })) as string;
    const read = (await run({ action: 'read', id: 'browser-driver' })) as string;

    expect(list).not.toContain('⚠');
    expect(read).not.toContain('no configured MCP server');
  });
});
