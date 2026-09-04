import { describe, it, expect } from 'vitest';
import {
  isGrantableSource,
  isWildcardSource,
  sanitizeCspGrant,
  normalizeSandboxTokens,
  isEmptyCspGrant,
  describeCspGrant,
  GRANTABLE_DIRECTIVES,
  GRANTABLE_SANDBOX_TOKENS,
  MAX_SOURCES_PER_DIRECTIVE,
} from './csp-grant.js';

describe('isGrantableSource', () => {
  it('accepts an origin, with or without a port', () => {
    expect(isGrantableSource('https://cdn.example.com')).toBe(true);
    expect(isGrantableSource('http://cdn.example.com:8080')).toBe(true);
    expect(isGrantableSource('https://example.com:65535')).toBe(true);
  });

  it('accepts one leading wildcard label', () => {
    expect(isGrantableSource('https://*.example.com')).toBe(true);
    // A wildcard anywhere but the leading label is not a CSP host-source.
    expect(isGrantableSource('https://cdn.*.com')).toBe(false);
    expect(isGrantableSource('https://*')).toBe(false);
  });

  it('accepts loopback and IPv4 literals', () => {
    // An applet talking to a local model server is a legitimate connect-src
    // grant; refusing it would push the user toward a broader one.
    expect(isGrantableSource('http://127.0.0.1:11434')).toBe(true);
    expect(isGrantableSource('http://localhost:3000')).toBe(true);
  });

  it('accepts a bare https: and refuses a bare http:', () => {
    // #467: a grant this broad "should be possible but should look as
    // alarming as it is" — so it is accepted here and shouted about by the
    // caller. Bare http: is that breadth plus cleartext, and nothing needs it.
    expect(isGrantableSource('https:')).toBe(true);
    expect(isGrantableSource('http:')).toBe(false);
  });

  it('refuses a bare wildcard', () => {
    expect(isGrantableSource('*')).toBe(false);
    expect(isGrantableSource('*:*')).toBe(false);
  });

  it('refuses every quoted keyword', () => {
    // Keywords are the host's business. 'self' and data: are already emitted
    // and cannot be removed, so accepting one here could only ever add an
    // 'unsafe-*'.
    for (const keyword of [
      "'self'",
      "'none'",
      "'unsafe-inline'",
      "'unsafe-eval'",
      "'strict-dynamic'",
      "'nonce-abc123'",
      "'sha256-abc'",
    ]) {
      expect(isGrantableSource(keyword)).toBe(false);
    }
  });

  it('refuses non-http schemes', () => {
    for (const scheme of ['data:', 'blob:', 'javascript:', 'file:', 'filesystem:', 'vscode:']) {
      expect(isGrantableSource(scheme)).toBe(false);
    }
  });

  it('refuses a path, query, fragment or trailing slash', () => {
    // CSP matches a host-source, so these do not mean what the user typing
    // them believes; refusing beats silently widening.
    expect(isGrantableSource('https://cdn.example.com/assets')).toBe(false);
    expect(isGrantableSource('https://cdn.example.com/')).toBe(false);
    expect(isGrantableSource('https://cdn.example.com?a=b')).toBe(false);
    expect(isGrantableSource('https://cdn.example.com#x')).toBe(false);
    expect(isGrantableSource('https://user:pw@cdn.example.com')).toBe(false);
  });

  it('refuses a value carrying a directive separator', () => {
    // The header-splitting case, spelled out: concatenated unchecked, this
    // adds a directive nobody granted.
    expect(isGrantableSource("https://x.example; script-src 'unsafe-eval'")).toBe(false);
    expect(isGrantableSource('https://x.example;')).toBe(false);
    expect(isGrantableSource('https://a.example,https://b.example')).toBe(false);
  });

  it('refuses CR, LF, tabs, spaces and quotes', () => {
    // CR/LF would make res.writeHead throw and kill the socket rather than
    // serve the applet at all.
    for (const bad of [
      'https://x.example\r\nX-Evil: 1',
      'https://x.example\n',
      'https://x.example\t',
      'https://x .example',
      'https://"x.example"',
    ]) {
      expect(isGrantableSource(bad)).toBe(false);
    }
  });

  it('refuses non-ASCII hosts', () => {
    // The user supplies punycode; a validator that IDNA-encodes is one that
    // can disagree with the browser about what was granted.
    expect(isGrantableSource('https://éxample.com')).toBe(false);
    expect(isGrantableSource('https://xn--xample-9ua.com')).toBe(true);
  });

  it('refuses an out-of-range or malformed port', () => {
    expect(isGrantableSource('https://example.com:0')).toBe(false);
    expect(isGrantableSource('https://example.com:65536')).toBe(false);
    expect(isGrantableSource('https://example.com:')).toBe(false);
    expect(isGrantableSource('https://example.com:80x')).toBe(false);
  });

  it('refuses an over-long host', () => {
    expect(isGrantableSource(`https://${'a'.repeat(300)}.com`)).toBe(false);
  });
});

describe('isWildcardSource', () => {
  it('flags whole-scheme and wildcard-label grants, not ordinary origins', () => {
    expect(isWildcardSource('https:')).toBe(true);
    expect(isWildcardSource('https://*.example.com')).toBe(true);
    expect(isWildcardSource('https://cdn.example.com')).toBe(false);
  });
});

describe('normalizeSandboxTokens', () => {
  it('resolves the links alias to both popup tokens', () => {
    // allow-popups alone means the popup INHERITS the sandbox — an external
    // page with no scripts, storage or forms, which is broken more
    // confusingly than not opening. The pair is the only coherent state.
    expect(normalizeSandboxTokens(['links'])).toEqual([
      'allow-popups',
      'allow-popups-to-escape-sandbox',
    ]);
  });

  it('resolves the navigate alias', () => {
    expect(normalizeSandboxTokens(['navigate'])).toEqual([
      'allow-top-navigation-by-user-activation',
    ]);
  });

  it('re-adds allow-popups when only the escape token is present', () => {
    // Repaired in this direction only: the reverse would silently widen a
    // grant the user actually made.
    expect(normalizeSandboxTokens(['allow-popups-to-escape-sandbox'])).toEqual([
      'allow-popups',
      'allow-popups-to-escape-sandbox',
    ]);
    expect(normalizeSandboxTokens(['allow-popups'])).toEqual(['allow-popups']);
  });

  it('refuses every token outside the grantable set', () => {
    expect(
      normalizeSandboxTokens([
        'allow-top-navigation',
        'allow-forms',
        'allow-downloads',
        'allow-modals',
        'allow-scripts',
        'allow-same-origin',
        'allow-anything',
      ]),
    ).toEqual([]);
  });

  it('emits in declaration order so a rebuilt header does not shuffle', () => {
    expect(normalizeSandboxTokens(['navigate', 'links'])).toEqual([...GRANTABLE_SANDBOX_TOKENS]);
  });
});

describe('sanitizeCspGrant', () => {
  it('keeps valid sources per directive', () => {
    expect(
      sanitizeCspGrant({ imgSrc: ['https://a.example'], connectSrc: ['https://b.example'] }),
    ).toEqual({ imgSrc: ['https://a.example'], connectSrc: ['https://b.example'] });
  });

  it('drops unknown keys rather than passing them through', () => {
    // A typo'd directive must be inert, not arrive somewhere that trusts it.
    const grant = sanitizeCspGrant({
      styleSrc: ['https://a.example'],
      scriptSrc: ['https://a.example'],
      defaultSrc: ["'unsafe-inline'"],
      imgSrc: ['https://a.example'],
    });
    expect(grant).toEqual({ imgSrc: ['https://a.example'] });
  });

  it('does not take __proto__ as a directive', () => {
    const grant = sanitizeCspGrant(JSON.parse('{"__proto__": {"imgSrc": ["https:"]}}'));
    expect(isEmptyCspGrant(grant)).toBe(true);
    expect(({} as Record<string, unknown>).imgSrc).toBeUndefined();
  });

  it('drops individual invalid sources but keeps the valid ones', () => {
    expect(
      sanitizeCspGrant({
        imgSrc: ['https://ok.example', "https://bad; script-src 'unsafe-eval'", 42],
      }),
    ).toEqual({ imgSrc: ['https://ok.example'] });
  });

  it('drops a non-array value and a non-object grant', () => {
    expect(sanitizeCspGrant({ imgSrc: 'https://a.example' })).toEqual({});
    expect(sanitizeCspGrant(null)).toEqual({});
    expect(sanitizeCspGrant(['https://a.example'])).toEqual({});
    expect(sanitizeCspGrant('https://a.example')).toEqual({});
  });

  it('dedupes and caps the source count', () => {
    const many = Array.from({ length: 30 }, (_, i) => `https://h${i}.example`);
    expect(sanitizeCspGrant({ imgSrc: many }).imgSrc).toHaveLength(MAX_SOURCES_PER_DIRECTIVE);
    expect(sanitizeCspGrant({ imgSrc: ['https://a.example', 'https://a.example'] }).imgSrc).toEqual(
      ['https://a.example'],
    );
  });

  it('normalizes sandbox tokens and drops the key when nothing survives', () => {
    expect(sanitizeCspGrant({ sandbox: ['links'] }).sandbox).toEqual([
      'allow-popups',
      'allow-popups-to-escape-sandbox',
    ]);
    expect(sanitizeCspGrant({ sandbox: ['allow-forms'] }).sandbox).toBeUndefined();
  });
});

describe('isEmptyCspGrant', () => {
  it('is true once everything has been dropped', () => {
    expect(
      isEmptyCspGrant(sanitizeCspGrant({ imgSrc: ["'self'"], sandbox: ['allow-forms'] })),
    ).toBe(true);
    expect(isEmptyCspGrant({})).toBe(true);
    expect(isEmptyCspGrant({ imgSrc: [] })).toBe(true);
    expect(isEmptyCspGrant({ imgSrc: ['https://a.example'] })).toBe(false);
  });
});

describe('describeCspGrant', () => {
  it('renders one line per granted directive, in table order', () => {
    expect(describeCspGrant({ imgSrc: ['https://a.example'], sandbox: ['allow-popups'] })).toEqual([
      'img-src: https://a.example',
      'sandbox: allow-popups',
    ]);
  });

  it('says nothing about a directive that was not granted', () => {
    expect(describeCspGrant({})).toEqual([]);
  });
});

describe('the grantable tables', () => {
  it('never offers script-src or style-src', () => {
    // #424 made the served stylesheet mandatory by refusing inline style, and
    // an off-origin script is what the origin boundary cannot survive.
    expect(GRANTABLE_DIRECTIVES).not.toContain('scriptSrc');
    expect(GRANTABLE_DIRECTIVES).not.toContain('styleSrc');
    expect(GRANTABLE_DIRECTIVES).not.toContain('defaultSrc');
  });

  it('never offers a sandbox token that removes the base pair or opens forms', () => {
    expect(GRANTABLE_SANDBOX_TOKENS).not.toContain('allow-scripts');
    expect(GRANTABLE_SANDBOX_TOKENS).not.toContain('allow-same-origin');
    expect(GRANTABLE_SANDBOX_TOKENS).not.toContain('allow-forms');
    expect(GRANTABLE_SANDBOX_TOKENS).not.toContain('allow-top-navigation');
  });
});
