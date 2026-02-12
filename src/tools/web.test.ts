import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWebReadTool } from './web.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeResponse(body: string, init?: { status?: number; statusText?: string; headers?: Record<string, string> }) {
  const status = init?.status ?? 200;
  const statusText = init?.statusText ?? 'OK';
  const headers = new Map(Object.entries({
    'content-type': 'text/html; charset=utf-8',
    ...init?.headers,
  }));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: { get: (key: string) => headers.get(key) ?? null },
    arrayBuffer: () => Promise.resolve(new TextEncoder().encode(body).buffer),
  };
}

describe('createWebReadTool', () => {
  let webTool: ReturnType<typeof createWebReadTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    webTool = createWebReadTool();
  });

  it('returns markdown content for valid HTML response', async () => {
    mockFetch.mockResolvedValue(makeResponse('<html><body><p>Hello world</p></body></html>'));
    const result = await webTool.execute({ url: 'https://example.com' }, {} as any);
    expect(result).toContain('Hello world');
  });

  it('includes page title in output', async () => {
    mockFetch.mockResolvedValue(makeResponse('<html><head><title>My Page</title></head><body><p>Content</p></body></html>'));
    const result = await webTool.execute({ url: 'https://example.com' }, {} as any);
    expect(result).toContain('# My Page');
  });

  it('strips script/style/nav elements from output', async () => {
    const html = `<html><body>
      <script>alert('xss')</script>
      <style>.foo{color:red}</style>
      <nav><a href="/">Home</a></nav>
      <p>Actual content</p>
    </body></html>`;
    mockFetch.mockResolvedValue(makeResponse(html));
    const result = await webTool.execute({ url: 'https://example.com' }, {} as any);
    expect(result).toContain('Actual content');
    expect(result).not.toContain('alert');
    expect(result).not.toContain('.foo{color:red}');
    expect(result).not.toContain('Home');
  });

  it('respects selector parameter when provided', async () => {
    const html = '<html><body><div class="sidebar">Side</div><article>Main article</article></body></html>';
    mockFetch.mockResolvedValue(makeResponse(html));
    const result = await webTool.execute({ url: 'https://example.com', selector: 'article' }, {} as any);
    expect(result).toContain('Main article');
    expect(result).not.toContain('Side');
  });

  it('falls back to full body when selector does not match', async () => {
    const html = '<html><body><p>Fallback content</p></body></html>';
    mockFetch.mockResolvedValue(makeResponse(html));
    const result = await webTool.execute({ url: 'https://example.com', selector: '.nonexistent' }, {} as any);
    expect(result).toContain('Fallback content');
  });

  it('returns error string for non-2xx status codes', async () => {
    mockFetch.mockResolvedValue(makeResponse('Not Found', { status: 404, statusText: 'Not Found' }));
    const result = await webTool.execute({ url: 'https://example.com/missing' }, {} as any);
    expect(result).toContain('Error');
    expect(result).toContain('404');
  });

  it('returns error string for non-HTML content type', async () => {
    mockFetch.mockResolvedValue(makeResponse('binary', { headers: { 'content-type': 'application/pdf' } }));
    const result = await webTool.execute({ url: 'https://example.com/file.pdf' }, {} as any);
    expect(result).toContain('Error');
    expect(result).toContain('Non-HTML');
  });

  it('returns error string for invalid URLs (no protocol)', async () => {
    const result = await webTool.execute({ url: 'example.com' }, {} as any);
    expect(result).toContain('Error');
    expect(result).toContain('http');
  });

  it('truncates output longer than 20,000 chars', async () => {
    const longContent = '<html><body><p>' + 'a'.repeat(25000) + '</p></body></html>';
    mockFetch.mockResolvedValue(makeResponse(longContent));
    const result = await webTool.execute({ url: 'https://example.com' }, {} as any);
    expect(result.length).toBeLessThanOrEqual(25000); // some overhead for markdown + truncation message
    expect(result).toContain('… (truncated)');
  });

  it('sets appropriate User-Agent and Accept headers', async () => {
    mockFetch.mockResolvedValue(makeResponse('<html><body><p>Hi</p></body></html>'));
    await webTool.execute({ url: 'https://example.com' }, {} as any);
    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers['User-Agent']).toContain('Mozilla');
    expect(options.headers['Accept']).toBe('text/html');
  });

  it('handles fetch timeout/network errors gracefully', async () => {
    mockFetch.mockRejectedValue(new Error('Network timeout'));
    const result = await webTool.execute({ url: 'https://example.com' }, {} as any);
    expect(result).toContain('Error');
    expect(result).toContain('Network timeout');
  });
});
