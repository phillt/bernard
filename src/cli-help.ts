import { Help, type Command } from 'commander';

/**
 * `bernard --help`, sorted and spaced — and every subcommand's help too.
 *
 * The default is registration order, which put `say` between `script` and
 * `cron-grant` in an unsorted list of twenty. Findable only by reading the
 * whole thing, which is exactly how it came to be reported as missing.
 *
 * A plain config object rather than a `Help` subclass, because Commander COPIES
 * this onto every subcommand it creates and does not inherit an overridden
 * `createHelp`. With the subclass, `bernard --help` was sorted and spaced while
 * `bernard say --help` was neither — the inconsistency being more confusing
 * than the original problem.
 */
export const HELP_CONFIG = {
  sortSubcommands: true,
  sortOptions: true,

  /**
   * Inserts a blank line before each item.
   *
   * Done on the RENDERED text, which is the ugly part and is deliberate. The
   * hooks Commander offers for this — `subcommandDescription`,
   * `optionDescription` — feed into `helper.wrap`, which normalises whitespace,
   * so a trailing newline there is discarded; measured, not assumed. The only
   * other route is reimplementing `formatHelp`'s layout, which is a copy of
   * Commander's internals that rots silently on upgrade.
   *
   * Anchored on an item term's exact two-space indent. A wrapped continuation
   * is indented to the description column — far more than two — so it stays
   * attached to its term rather than being split off, which is the one thing
   * this could plausibly get wrong.
   */
  formatHelp(this: Help, cmd: Command, helper: Help): string {
    return Help.prototype.formatHelp.call(this, cmd, helper).replace(/\n {2}(?=\S)/g, '\n\n  ');
  },
};
