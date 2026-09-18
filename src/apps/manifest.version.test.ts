import { describe, it, expect, vi } from 'vitest';
import { useTempHome } from '../__tests__/temp-home.js';
import {
  AppSchemaVersionSchema,
  LATEST_APP_SCHEMA_VERSION,
  parseRawAppManifest,
  requiredSchemaVersion,
  schemaVersionDemands,
} from './manifest.js';

/**
 * The reader and the writer of the schema-version rule, pinned against each
 * other (#588).
 *
 * A manifest is read as the version it STATES, so a newer field on an older
 * manifest would make it half-that-version — readable here and rejected
 * wholesale by an older binary. That rule needs a reader (the refinement,
 * which refuses) and a writer (`src/tools/applet.ts`, which stamps), and
 * written twice they drift silently: too low and every write is refused, too
 * high and every applet pays its readability for a field it does not use.
 *
 * `requiredSchemaVersion` is the one function both go through. These tests are
 * what make that claim checkable rather than a comment.
 */

const AGENT = { kind: 'agent' as const, specialistId: 'web-wrapper', instructions: 'Do it.' };

const NESTED_ARG = {
  type: 'list',
  required: true,
  of: { type: 'object', fields: { start: { type: 'number' }, end: { type: 'number' } } },
};

function manifest(actions: Record<string, unknown>, permissions?: unknown) {
  return {
    id: 'demo',
    name: 'Demo',
    actions,
    ...(permissions ? { permissions } : {}),
  };
}

/** Every combination of features that moves the version, and what it demands. */
const CASES: Array<{ what: string; body: ReturnType<typeof manifest>; version: number }> = [
  {
    what: 'flat v1 action',
    body: manifest({ go: { instructions: 'x', specialistId: 'y' } }),
    version: 1,
  },
  { what: 'a dispatch', body: manifest({ go: { dispatch: AGENT } }), version: 2 },
  {
    what: 'a permission request',
    body: manifest(
      { go: { dispatch: AGENT } },
      { imgSrc: { origins: ['https://cdn.example.com'] } },
    ),
    version: 3,
  },
  {
    what: 'a nested argument',
    body: manifest({ go: { dispatch: AGENT, args: { ranges: NESTED_ARG } } }),
    version: 4,
  },
  {
    // A nested type reachable only BELOW the top level. The demand has to see
    // through a container, or this manifest is stamped 2 and refused by its
    // own refinement.
    what: 'a nested type only an element uses',
    body: manifest({
      go: {
        dispatch: AGENT,
        args: { xs: { type: 'list', of: { type: 'number' } } },
      },
    }),
    version: 4,
  },
];

describe('schema-version demands', () => {
  it.each(CASES)('$what demands schemaVersion $version', ({ body, version }) => {
    expect(requiredSchemaVersion(body)).toBe(version);
  });

  /**
   * Both directions, which is the pin that matters. Stamping what the writer
   * would stamp must parse; stamping one lower must not. The second half is
   * what catches a demand that exists in `schemaVersionDemands` and is never
   * enforced, and the first catches a demand enforced with no writer behind it.
   */
  it.each(CASES)('$what parses at its demand and is refused one below', ({ body, version }) => {
    expect(parseRawAppManifest({ ...body, schemaVersion: version }).ok).toBe(true);
    if (version === 1) return;
    const low = parseRawAppManifest({ ...body, schemaVersion: version - 1 });
    expect(low.ok).toBe(false);
    if (!low.ok) expect(low.error).toContain(`requires schemaVersion ${version}`);
  });

  // The refusal has to name what raised the demand. "requires schemaVersion 4"
  // with nothing pointing at the reason is a refusal an author goes hunting
  // for, and a nested type is the one whose reason is least obvious.
  it('names the feature that raised the demand', () => {
    const res = parseRawAppManifest({ ...CASES[3].body, schemaVersion: 3 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('`list` argument type');
  });

  it('reports every demand, not just the highest', () => {
    const both = manifest(
      { go: { dispatch: AGENT, args: { ranges: NESTED_ARG } } },
      { imgSrc: { origins: ['https://cdn.example.com'] } },
    );
    expect(
      schemaVersionDemands(both)
        .map((d) => d.version)
        .sort(),
    ).toEqual([2, 3, 4]);
  });

  it('never demands a revision this binary cannot state', () => {
    for (const { body } of CASES) {
      for (const demand of schemaVersionDemands(body)) {
        expect(AppSchemaVersionSchema.safeParse(demand.version).success).toBe(true);
      }
    }
    expect(AppSchemaVersionSchema.safeParse(LATEST_APP_SCHEMA_VERSION).success).toBe(true);
  });
});

describe('the writer stamps what the reader demands', () => {
  useTempHome('bernard-manifest-version');

  async function appletTool() {
    vi.resetModules();
    const { createAppletTool } = await import('../tools/applet.js');
    const { AppRegistry } = await import('./registry.js');
    return { tool: createAppletTool(new AppRegistry({ seed: false })), AppRegistry };
  }

  /**
   * The real `applet` tool, writing a real manifest with a nested argument,
   * and the registry reading it back. This is what a hand-written stamp in
   * `buildManifest` gets wrong: it would still be `permissions ? 3 : 2`, the
   * write would be refused by `parseRawAppManifest`, and the failure would be
   * a create that reports an error nobody can act on.
   */
  it('writes a nested-arg applet at a revision it can read back', async () => {
    const { tool, AppRegistry } = await appletTool();
    const out = (await tool.execute(
      {
        action: 'create',
        id: 'timesheet',
        name: 'Timesheet',
        description: 'Totals a set of time ranges.',
        actions: {
          total: {
            dispatch: {
              kind: 'tool',
              tool: 'time_range_total',
              args: { ranges: '$.ranges' },
            },
            args: { ranges: NESTED_ARG },
          },
        },
      } as never,
      {} as never,
    )) as string;
    expect(out).not.toMatch(/^Error/);

    const app = new AppRegistry({ seed: false }).get('timesheet');
    expect(app.ok).toBe(true);
    if (app.ok) expect(app.manifest.schemaVersion).toBe(4);
  });

  // The other half of "bumped only as far as it needs": an applet that uses no
  // v4 feature must not start costing its readability to an older binary.
  it('leaves a scalar-only applet where it was', async () => {
    const { tool, AppRegistry } = await appletTool();
    await tool.execute(
      {
        action: 'create',
        id: 'notes',
        name: 'Notes',
        description: 'Summarises a note.',
        actions: {
          summarise: { dispatch: AGENT, args: { text: { type: 'string', required: true } } },
        },
      } as never,
      {} as never,
    );
    const app = new AppRegistry({ seed: false }).get('notes');
    expect(app.ok).toBe(true);
    if (app.ok) expect(app.manifest.schemaVersion).toBe(2);
  });
});
