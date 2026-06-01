import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { SlashHints, SLASH_COMMANDS, matchSlashCommands } from '../SlashHints.js';

describe('matchSlashCommands', () => {
  it('returns nothing when buffer does not start with /', () => {
    expect(matchSlashCommands('hello')).toEqual([]);
  });

  it('returns every command for an empty / buffer', () => {
    expect(matchSlashCommands('/')).toEqual([...SLASH_COMMANDS]);
  });

  it('filters by prefix as the user types', () => {
    const matches = matchSlashCommands('/ex');
    expect(matches.map((c) => c.name)).toEqual(['/exit']);
  });

  it('returns nothing once the user types args', () => {
    expect(matchSlashCommands('/task foo')).toEqual([]);
  });

  it('matching is case-insensitive', () => {
    expect(matchSlashCommands('/EX').map((c) => c.name)).toEqual(['/exit']);
  });
});

describe('<SlashHints>', () => {
  it('renders nothing when matches is empty', () => {
    const { lastFrame } = render(
      createElement(SlashHints, { matches: [], selectedIndex: 0 }),
    );
    expect(lastFrame()).toBe('');
  });

  it('renders the supplied matches with the selected row highlighted', () => {
    const matches = matchSlashCommands('/c');
    const { lastFrame } = render(
      createElement(SlashHints, { matches, selectedIndex: 0 }),
    );
    const frame = lastFrame() ?? '';
    for (const cmd of matches) expect(frame).toContain(cmd.name);
    // The selection marker prefixes only the highlighted row.
    expect(frame).toContain(`› ${matches[0].name}`);
  });
});
