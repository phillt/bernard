/**
 * The corpus eval's fixture documents (#516/#517).
 *
 * **A separate fixture from `fixtures/retrieval/`, deliberately.** That one is
 * 51 conversational facts — short, atomic, one claim each. Corpus chunks are a
 * different population with different length statistics and different failure
 * modes, and mixing them makes one regression look like the other's.
 *
 * Written as whole DOCUMENTS rather than pre-split chunks, because the chunker
 * is part of what the eval measures: a boundary change that scatters an answer
 * across two chunks is exactly the regression this has to catch.
 */

export interface CorpusDocument {
  uri: string;
  mode: 'prose' | 'code';
  text: string;
}

export const CORPUS_DOCUMENTS: CorpusDocument[] = [
  {
    uri: '/handbook.md',
    mode: 'prose',
    text: [
      '# Deployment handbook',
      '',
      '## When we ship',
      '',
      'Deployments do not go out on a Friday afternoon. The team prefers Tuesday and Wednesday mornings, when everyone who might need to roll something back is awake and at a desk.',
      '',
      '## Rolling back',
      '',
      'A rollback is a deploy of the previous tag. There is no separate mechanism, and there is deliberately no button: the person rolling back should be looking at the same dashboard as the person who shipped.',
      '',
      '## Who to wake',
      '',
      'The escalation contact for a quota breach is the platform on-call rota, not the owning team. QUOTA-4417 is the code that pages them.',
    ].join('\n'),
  },
  {
    uri: '/policy.md',
    mode: 'prose',
    text: [
      '# Review policy',
      '',
      'Code review comments explain the reasoning rather than only naming the rule that was broken. A reviewer who writes "this violates rule 7" has told the author nothing they can act on.',
      '',
      'Reviews are not a gate on style. They are a gate on whether the next person to read this can understand it.',
    ].join('\n'),
  },
  {
    uri: '/policy.ts',
    mode: 'code',
    text: [
      'export function resolveSiteModel(config: BernardConfig, site: Site): SiteModel {',
      '  const lineup = config.lineups[config.activeLineupId];',
      '  if (!lineup) return { provider: config.provider, model: config.model, source: "default" };',
      '  const role = SITE_ROLE[site];',
      '  return { ...lineup.roles[role], source: "policy" };',
      '}',
      '',
      'export function lineupProviders(lineup: Lineup): string[] {',
      '  return [...new Set(Object.values(lineup.roles).map((r) => r.provider))];',
      '}',
    ].join('\n'),
  },
];

/** Plausible neighbours. Without them recall is trivially 1.0 at any threshold. */
export const CORPUS_FILLER: CorpusDocument[] = Array.from({ length: 12 }, (_, i) => ({
  uri: `/filler-${i}.md`,
  mode: 'prose' as const,
  text: [
    `# Background note ${i}`,
    '',
    `Routine operational detail number ${i} about configuration, build pipelines and caching. Nothing here answers a question anyone asks, and none of it names a distinguishing term.`,
    '',
    `Service ${i} is configured beside its deployment manifest and refreshed on a fixed schedule.`,
  ].join('\n'),
}));
