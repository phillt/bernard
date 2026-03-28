import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../mcp.js', () => ({
  addMCPUrlServer: vi.fn(),
}));

const { addMCPUrlServer } = await import('../mcp.js');
const { createMCPAddUrlTool } = await import('./mcp-url.js');

describe('createMCPAddUrlTool', () => {
  let tool: ReturnType<typeof createMCPAddUrlTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = createMCPAddUrlTool();
  });

  it('calls addMCPUrlServer with type "sse" for SSE URLs ending in /sse', async () => {
    const result = await tool.execute(
      { key: 'my-sse', url: 'http://localhost:6288/web/sse' },
      {} as any,
    );
    expect(addMCPUrlServer).toHaveBeenCalledWith('my-sse', 'http://localhost:6288/web/sse', 'sse');
    expect(result).toContain('Transport: sse');
  });

  it('calls addMCPUrlServer with type "http" for non-SSE URLs', async () => {
    const result = await tool.execute(
      { key: 'my-http', url: 'http://localhost:6288/api/mcp' },
      {} as any,
    );
    expect(addMCPUrlServer).toHaveBeenCalledWith(
      'my-http',
      'http://localhost:6288/api/mcp',
      'http',
    );
    expect(result).toContain('Transport: http');
  });

  it('return message includes the correct transport type for SSE', async () => {
    const result = await tool.execute(
      { key: 'test-sse', url: 'https://example.com/sse' },
      {} as any,
    );
    expect(result).toContain('Key: test-sse');
    expect(result).toContain('URL: https://example.com/sse');
    expect(result).toContain('Transport: sse');
    expect(result).toContain('Restart Bernard');
  });

  it('return message includes the correct transport type for HTTP', async () => {
    const result = await tool.execute(
      { key: 'test-http', url: 'https://example.com/mcp' },
      {} as any,
    );
    expect(result).toContain('Key: test-http');
    expect(result).toContain('URL: https://example.com/mcp');
    expect(result).toContain('Transport: http');
    expect(result).toContain('Restart Bernard');
  });

  it('returns error message when addMCPUrlServer throws', async () => {
    vi.mocked(addMCPUrlServer).mockImplementation(() => {
      throw new Error('Server "dup" already exists. Remove it first, then add again.');
    });
    const result = await tool.execute(
      { key: 'dup', url: 'http://localhost:6288/sse' },
      {} as any,
    );
    expect(result).toContain('Error adding server:');
    expect(result).toContain('already exists');
  });
});
