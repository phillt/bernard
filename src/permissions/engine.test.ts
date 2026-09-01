import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PermissionRule } from '../tool-permissions.js';
import { resolveGrant } from './engine.js';
import {
  matchShellSpecifier,
  matchPathSpecifier,
  matchDomainSpecifier,
  matchMCPSpecifier,
} from './matchers.js';
import { breadthOptionsFor } from './breadth.js';

const rule = (
  effect: PermissionRule['effect'],
  tool: string,
  specifier?: string,
): PermissionRule =>
  specifier === undefined ? { effect, tool, _v: 2 } : { effect, tool, specifier, _v: 2 };

describe('matchShellSpecifier', () => {
  it('bare specifier matches only the bare command', () => {
    expect(matchShellSpecifier('git', 'git')).toBe(true);
    expect(matchShellSpecifier('git', 'git status')).toBe(false);
  });
  it('trailing * matches any args (and the bare command)', () => {
    expect(matchShellSpecifier('git *', 'git')).toBe(true);
    expect(matchShellSpecifier('git *', 'git status')).toBe(true);
    expect(matchShellSpecifier('git *', 'git push origin main')).toBe(true);
  });
  it('enforces a word boundary', () => {
    expect(matchShellSpecifier('git *', 'github-cli')).toBe(false);
    expect(matchShellSpecifier('git', 'github')).toBe(false);
  });
  it('multi-token prefix matches exactly or as a prefix with *', () => {
    expect(matchShellSpecifier('git status', 'git status')).toBe(true);
    expect(matchShellSpecifier('git status', 'git status --short')).toBe(false);
    expect(matchShellSpecifier('git status *', 'git status --short')).toBe(true);
    expect(matchShellSpecifier('npm *', 'git status')).toBe(false);
  });
});

describe('matchPathSpecifier (gitignore globs)', () => {
  const root = path.resolve('/proj');
  it('** matches recursively, * does not cross segments', () => {
    expect(matchPathSpecifier(`${root}/src/**`, `${root}/src/a/b.ts`)).toBe(true);
    expect(matchPathSpecifier(`${root}/src/**`, `${root}/other/b.ts`)).toBe(false);
    expect(matchPathSpecifier(`${root}/src/*`, `${root}/src/b.ts`)).toBe(true);
    expect(matchPathSpecifier(`${root}/src/*`, `${root}/src/a/b.ts`)).toBe(false);
  });
  it('exact path matches itself', () => {
    expect(matchPathSpecifier(`${root}/src/main.ts`, `${root}/src/main.ts`)).toBe(true);
    expect(matchPathSpecifier(`${root}/src/main.ts`, `${root}/src/other.ts`)).toBe(false);
  });
  it('~/ anchor expands to home', () => {
    const home = os.homedir();
    expect(matchPathSpecifier('~/docs/**', path.join(home, 'docs/a.txt'))).toBe(true);
  });
});

describe('matchDomainSpecifier', () => {
  it('domain: matches host and subdomains', () => {
    expect(matchDomainSpecifier('domain:example.com', 'https://example.com/x')).toBe(true);
    expect(matchDomainSpecifier('domain:example.com', 'https://sub.example.com/x')).toBe(true);
    expect(matchDomainSpecifier('domain:example.com', 'https://notexample.com/')).toBe(false);
  });
  it('exact-URL specifier matches only that URL', () => {
    expect(matchDomainSpecifier('https://a.com/p', 'https://a.com/p')).toBe(true);
    expect(matchDomainSpecifier('https://a.com/p', 'https://a.com/q')).toBe(false);
  });
  it('malformed URL → false', () => {
    expect(matchDomainSpecifier('domain:example.com', 'not a url')).toBe(false);
  });
});

describe('matchMCPSpecifier', () => {
  it('* matches any args', () => {
    expect(matchMCPSpecifier('*', { a: 1 })).toBe(true);
  });
  it('exact args match regardless of key order', () => {
    expect(matchMCPSpecifier('{"a":1,"b":2}', { b: 2, a: 1 })).toBe(true);
    expect(matchMCPSpecifier('{"a":1,"b":2}', { a: 1, b: 3 })).toBe(false);
  });
});

describe('resolveGrant', () => {
  it('dangerous shell always asks, even with a matching allow', () => {
    expect(resolveGrant('shell', { command: 'rm -rf /' }, [rule('allow', 'shell')], true)).toBe(
      'ask',
    );
    expect(
      resolveGrant('shell', { command: 'rm -rf /' }, [rule('allow', 'shell', 'rm *')], true),
    ).toBe('ask');
  });
  it('deny wins over allow regardless of order', () => {
    const rules = [rule('allow', 'shell', 'git *'), rule('deny', 'shell', 'git *')];
    expect(resolveGrant('shell', { command: 'git status' }, rules, false)).toBe('deny');
  });
  it('ask wins over allow', () => {
    const rules = [rule('allow', 'shell', 'git *'), rule('ask', 'shell', 'git *')];
    expect(resolveGrant('shell', { command: 'git status' }, rules, false)).toBe('ask');
  });
  it('a matching allow proceeds; non-match defaults to ask', () => {
    const rules = [rule('allow', 'shell', 'git *')];
    expect(resolveGrant('shell', { command: 'git push' }, rules, false)).toBe('allow');
    expect(resolveGrant('shell', { command: 'npm i' }, rules, false)).toBe('ask');
  });
  describe('action-scoped rules (#253)', () => {
    // Cron consolidated 10 tools into one `cron(action)`. An allow granted
    // while listing jobs must NOT authorise deleting them.
    it('an action:list allow does not permit a delete', () => {
      const rules = [rule('allow', 'cron', 'action:list')];
      expect(resolveGrant('cron', { action: 'list' }, rules, false)).toBe('allow');
      expect(resolveGrant('cron', { action: 'delete', id: 'x' }, rules, false)).toBe('ask');
    });

    it('matches the same action regardless of other arguments', () => {
      const rules = [rule('allow', 'cron', 'action:delete')];
      expect(resolveGrant('cron', { action: 'delete', id: 'a' }, rules, false)).toBe('allow');
      expect(resolveGrant('cron', { action: 'delete', id: 'b' }, rules, false)).toBe('allow');
    });

    it('a deny on one action still beats a broad allow', () => {
      const rules = [rule('allow', 'cron'), rule('deny', 'cron', 'action:delete')];
      expect(resolveGrant('cron', { action: 'list' }, rules, false)).toBe('allow');
      expect(resolveGrant('cron', { action: 'delete' }, rules, false)).toBe('deny');
    });

    it('stale pre-consolidation rules fail closed, never open', () => {
      // The consolidation is a breaking change for stored rules: a user's
      // `cron_delete` grant no longer names a live tool. This pins the
      // direction of that break — such a rule must stop *allowing*, and must
      // never accidentally match the consolidated tool. Default is `ask`, so
      // the user is re-prompted rather than silently granted.
      const stale = [
        rule('allow', 'cron_delete'),
        rule('allow', 'cron_list'),
        rule('allow', 'cron_logs_cleanup'),
      ];
      for (const action of ['delete', 'list', 'cleanup']) {
        expect(resolveGrant('cron', { action, id: 'x' }, stale, false)).toBe('ask');
        expect(resolveGrant('cron_logs', { action, job_id: 'x' }, stale, false)).toBe('ask');
      }
    });

    it('a stale deny still denies its own tool name', () => {
      // The inverse direction: a stale rule going inert must not resurrect a
      // capability the user had explicitly denied. `cron_delete` is no longer
      // reachable as a tool name at all, so nothing can invoke it.
      expect(resolveGrant('cron_delete', { id: 'x' }, [rule('deny', 'cron_delete')], false)).toBe(
        'deny',
      );
    });

    it('asks when the call carries no readable action', () => {
      const rules = [rule('allow', 'cron', 'action:list')];
      expect(resolveGrant('cron', {}, rules, false)).toBe('ask');
    });
  });

  it('no-specifier rule matches any invocation of the tool', () => {
    expect(
      resolveGrant('web_read', { url: 'https://x.com' }, [rule('allow', 'web_read')], false),
    ).toBe('allow');
  });
  it('file path grant covers files under the directory glob', () => {
    const root = path.resolve('/proj');
    const rules = [rule('allow', 'file_write', `${root}/src/**`)];
    expect(resolveGrant('file_write', { path: `${root}/src/a/b.ts` }, rules, false)).toBe('allow');
    expect(resolveGrant('file_write', { path: `${root}/other.ts` }, rules, false)).toBe('ask');
  });
  it('complex shell (parse-error) is not covered by a command specifier', () => {
    // Non-dangerous compound — the regex stub yields parse-error so a
    // `touch *` specifier cannot match (would need real AST splitting).
    const rules = [rule('allow', 'shell', 'touch *')];
    expect(resolveGrant('shell', { command: 'touch a && touch b' }, rules, false)).toBe('ask');
  });
});

describe('breadthOptionsFor', () => {
  it('shell: exact → command *', () => {
    const opts = breadthOptionsFor('shell', { command: 'git status' });
    expect(opts.map((o) => o.specifier)).toEqual(['git status', 'git *']);
  });
  it('shell: bare command yields a single level', () => {
    const opts = breadthOptionsFor('shell', { command: 'ls' });
    expect(opts).toHaveLength(1);
    expect(opts[0].specifier).toBe('ls');
  });
  it('shell: complex command → no grant offered', () => {
    expect(breadthOptionsFor('shell', { command: 'a | b' })).toEqual([]);
  });
  it('web: exact url → domain', () => {
    const opts = breadthOptionsFor('web_read', { url: 'https://docs.example.com/a' });
    expect(opts.map((o) => o.specifier)).toEqual([
      'https://docs.example.com/a',
      'domain:docs.example.com',
    ]);
  });
  it('mcp/other: exact args → any args', () => {
    const opts = breadthOptionsFor('srv__tool', { a: 1 });
    expect(opts.map((o) => o.specifier)).toEqual(['{"a":1}', '*']);
  });
  it('web_search (no url arg) falls back to the generic args ladder', () => {
    const opts = breadthOptionsFor('web_search', { query: 'cats', limit: 5 });
    expect(opts.map((o) => o.specifier)).toEqual(['{"limit":5,"query":"cats"}', '*']);
  });
});

describe('stableArgsString totality', () => {
  it('fails closed to a fixed string on unstringifiable args', () => {
    expect(matchMCPSpecifier('null', undefined)).toBe(true);
    expect(matchMCPSpecifier('null', 10n)).toBe(true);
  });
  it('still distinguishes real args', () => {
    expect(matchMCPSpecifier('null', { a: 1 })).toBe(false);
  });
});

// #413: MCP tools are namespaced per server, but grants persisted before that
// name a bare tool. The engine stays pure — the resolver is injected.
describe('resolveGrant with an alias resolver', () => {
  const stored: PermissionRule[] = [{ effect: 'allow', tool: 'browser_click', _v: 2 }];

  it('honors a bare-name grant when it resolves to the live tool', () => {
    const resolve = (n: string) =>
      n === 'browser_click' ? 'playwright_ab12cd__browser_click' : null;
    expect(resolveGrant('playwright_ab12cd__browser_click', {}, stored, false, resolve)).toBe(
      'allow',
    );
  });

  // Fail closed: two servers export the name, so which one the user meant is
  // unknowable. Asking again is the only safe answer.
  it('does not honor it when the resolver reports ambiguity', () => {
    const resolve = () => null;
    expect(resolveGrant('playwright_ab12cd__browser_click', {}, stored, false, resolve)).toBe(
      'ask',
    );
  });

  it('without a resolver, behaves exactly as before (exact match only)', () => {
    expect(resolveGrant('playwright_ab12cd__browser_click', {}, stored, false)).toBe('ask');
    expect(resolveGrant('browser_click', {}, stored, false)).toBe('allow');
  });

  // A `deny` must not become reachable-but-skippable through an alias miss.
  it('an aliased deny still wins over an exact allow', () => {
    const rules: PermissionRule[] = [
      { effect: 'allow', tool: 'srv_aaa111__x', _v: 2 },
      { effect: 'deny', tool: 'x', _v: 2 },
    ];
    const resolve = (n: string) => (n === 'x' ? 'srv_aaa111__x' : null);
    expect(resolveGrant('srv_aaa111__x', {}, rules, false, resolve)).toBe('deny');
  });
});
