import { defineFixture } from '../fixture-schema.js';

/**
 * Issue #175 — concise-by-default is on unless explicitly disabled.
 * `undefined` treats as on (matches `DEFAULT_CONCISE_MODE`).
 */
export const conciseFixture = defineFixture({
  name: 'concise',
  category: 'concise',
  invariants: [
    { type: 'concise_enabled_when', config: { conciseMode: true }, expected: true },
    { type: 'concise_enabled_when', config: { conciseMode: false }, expected: false },
    { type: 'concise_enabled_when', config: {}, expected: true },
  ],
});
