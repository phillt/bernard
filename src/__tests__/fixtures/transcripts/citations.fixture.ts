import { defineFixture } from '../fixture-schema.js';

/**
 * Issue #173 — `[^Sn]` markers must map to registered ProvenanceStore ids,
 * and an empty store filters all markers out (so an "unsupported claim with
 * a fake marker" never registers as cited).
 */
export const citationsFixture = defineFixture({
  name: 'citations',
  category: 'citations',
  invariants: [
    {
      type: 'citation_markers_resolve',
      text: 'The README says X. [^S1] And per the notes file, Y. [^S2]',
      storeItems: [
        {
          kind: 'web',
          label: 'README',
          contentPreview: 'X is the default',
          rawRef: 'https://example.com/readme',
        },
        {
          kind: 'file',
          label: 'notes.md',
          contentPreview: 'Y is the answer',
          rawRef: 'notes.md:1-5',
        },
      ],
      expectResolved: ['S1', 'S2'],
    },
    {
      type: 'unverified_text_has_no_marker',
      text: 'The sky is blue. [^S99] is a fake marker that points nowhere.',
    },
  ],
});
