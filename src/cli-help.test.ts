import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { HELP_CONFIG } from './cli-help.js';

function program(): Command {
  const p = new Command();
  p.configureHelp(HELP_CONFIG).name('demo').description('d').exitOverride();
  p.option('-z, --zed <v>', 'last option');
  p.option('-a, --alpha', 'first option');
  p.command('zulu').description('the zulu command');
  p.command('alpha').description('the alpha command');
  return p;
}

const itemsUnder = (help: string, heading: string) =>
  (help.split(`${heading}:\n`)[1] ?? '')
    .split('\n')
    .filter((l) => /^ {2}\S/.test(l))
    .map((l) => l.trim().split(/\s{2,}/)[0]);

describe('bernard --help', () => {
  const help = program().helpInformation();

  it('sorts commands, so a name can be found without reading the list', () => {
    // The reported failure: registration order put `say` between `script` and
    // `cron-grant` in an unsorted list of twenty, and it read as missing.
    const cmds = itemsUnder(help, 'Commands');
    expect(cmds).toEqual([...cmds].sort((a, b) => a.localeCompare(b)));
    expect(cmds).toContain('alpha');
  });

  it('sorts options too', () => {
    const opts = itemsUnder(help, 'Options');
    expect(opts).toEqual([...opts].sort((a, b) => a.localeCompare(b)));
  });

  it('puts a blank line between items', () => {
    expect(help).toMatch(/-a, --alpha.*\n\n {2}-h, --help/);
  });

  it('keeps a wrapped description attached to its own term', () => {
    // The one thing the rendered-text approach could plausibly get wrong. A
    // continuation is indented to the description column, not to two spaces, so
    // it must not be split off as if it were a new item.
    const p = program();
    p.command('mike').description(
      'a much longer description that will certainly wrap when the terminal is narrow enough to force it and then some',
    );
    const out = p.helpInformation();
    const lines = out.split('\n');
    const i = lines.findIndex((l) => l.startsWith('  mike'));
    expect(i).toBeGreaterThan(-1);
    // The very next line is the continuation, NOT a blank.
    expect(lines[i + 1]).toMatch(/^\s{4,}\S/);
  });

  it('applies to subcommand help as well as the root', () => {
    // A `Help` SUBCLASS gets this wrong: Commander copies `configureHelp` onto
    // each subcommand as it is registered, but does not inherit an overridden
    // `createHelp`. That left `bernard --help` sorted and `bernard say --help`
    // not, which is worse than neither.
    const sub = program()
      .commands.find((c) => c.name() === 'alpha')!
      .helpInformation();
    expect(sub).toMatch(/Options:\n\n/);
  });
});
