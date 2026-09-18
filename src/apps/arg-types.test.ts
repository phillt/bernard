import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  ARG_TYPES,
  ARG_TYPE_IDS,
  ArgSpecFields,
  DEFAULT_MAX_ITEMS,
  MAX_ARG_DEPTH,
  MAX_OBJECT_FIELDS,
  argSpecsSince,
  argTypeHandler,
  buildArgValidator,
  type ArgSpec,
} from './arg-types.js';
import { ArgSpecSchema, AppSchemaVersionSchema, LATEST_APP_SCHEMA_VERSION } from './manifest.js';

const spec = (over: Record<string, unknown>) => ArgSpecSchema.safeParse(over);

/** The shape `file_edit_lines` needs, `delete` included. The deepest legal one. */
const EDITS: unknown = {
  type: 'list',
  required: true,
  maxItems: 50,
  of: {
    type: 'object',
    fields: {
      action: { type: 'enum', required: true, values: ['replace', 'insert', 'delete', 'append'] },
      line: { type: 'number' },
      lines: { type: 'list', of: { type: 'number' } },
      content: { type: 'string', maxLength: 4000 },
    },
  },
};

describe('the arg-type table (#588)', () => {
  /**
   * The table walked in both directions. A type with no entry cannot be
   * declared, and an entry no schema offers is dead weight nobody notices —
   * which is the pair of failures a five-place hand-written type produced.
   */
  it('every entry is reachable and every reachable type has an entry', () => {
    expect(ARG_TYPES.length).toBeGreaterThan(0);
    expect([...ARG_TYPE_IDS].sort()).toEqual([...ARG_TYPES.map((h) => h.id)].sort());
    for (const id of ARG_TYPE_IDS) expect(argTypeHandler(id)?.id).toBe(id);

    // The level-0 enum is the table minus whatever is `nestedOnly`. Written
    // this way round rather than as a per-handler `if (handler.nestedOnly)`,
    // which branches on the very flag a mutation would delete and then passes
    // by taking the other arm.
    const atRoot: readonly string[] = ArgSpecFields.shape.type.options;
    const nestedOnly = ARG_TYPES.filter((h) => h.nestedOnly).map((h) => h.id);
    // The record, stated: `object` is the one type kept out of level 0, and
    // the reasons are expressiveness (a top-level record is two arguments
    // instead) and the size budget (the expansion is most expensive at the
    // root). An empty list here means that lever is silently gone.
    expect(nestedOnly).toEqual(['object']);
    expect([...atRoot].sort()).toEqual(
      ARG_TYPE_IDS.filter((id) => !nestedOnly.includes(id)).sort(),
    );

    // And a `nestedOnly` type really is reachable one level down — refused for
    // its empty `fields` rather than for being an unknown type, which is what
    // makes this about reachability and not about the enum.
    const element = ArgSpecSchema.safeParse({ type: 'list', of: { type: 'object', fields: {} } });
    expect(element.success).toBe(false);
    if (!element.success) {
      expect(element.error.issues.some((i) => /1 to 32 fields/.test(i.message))).toBe(true);
    }
  });

  // A key declared twice would silently take the first declaration's schema.
  it('no two types declare the same spec key', () => {
    const seen = new Set<string>();
    for (const handler of ARG_TYPES) {
      for (const field of handler.fields) {
        expect(seen.has(field.key), `${field.key} is declared twice`).toBe(false);
        seen.add(field.key);
      }
    }
  });

  // `since` feeds `schemaVersionDemands`, so a value outside the union would
  // demand a revision no manifest can state.
  it('every type declares a version this binary understands', () => {
    for (const handler of ARG_TYPES) {
      expect(AppSchemaVersionSchema.safeParse(handler.since).success).toBe(true);
      expect(handler.since).toBeLessThanOrEqual(LATEST_APP_SCHEMA_VERSION);
    }
  });

  /**
   * A control is what makes the button work at all: without one an argument
   * renders as nothing and the action is called with the field missing.
   *
   * Only the TAG is checked here, because that is what `page-template.ts`
   * branches on to build markup. That the page script has an arm for every
   * declared DECODER is asserted where the page is rendered, against the real
   * output — a list of decoder names repeated here would be a second copy of
   * the union, checked against itself.
   */
  it('every type declares a control the renderer knows how to build', () => {
    for (const handler of ARG_TYPES) {
      expect(['input', 'select', 'textarea'], handler.id).toContain(handler.control.tag);
    }
  });
});

describe('cross-field rules', () => {
  it('demands a type its own fields require, and refuses another type’s', () => {
    expect(spec({ type: 'enum' }).success).toBe(false);
    expect(spec({ type: 'list' }).success).toBe(false);
    expect(spec({ type: 'string', values: ['a'] }).success).toBe(false);
    expect(spec({ type: 'number', maxLength: 10 }).success).toBe(false);
    expect(spec({ type: 'string', maxItems: 10 }).success).toBe(false);
  });

  // The message wording is what an author acts on, and two of these predate
  // the table — they are kept byte-for-byte so a refusal did not change.
  it('keeps the messages it had before the table', () => {
    const a = spec({ type: 'enum' });
    expect(a.success).toBe(false);
    if (!a.success) expect(a.error.issues[0].message).toBe("type 'enum' requires `values`");
    const b = spec({ type: 'string', values: ['x'] });
    expect(b.success).toBe(false);
    if (!b.success) expect(b.error.issues[0].message).toBe("`values` is only valid on type 'enum'");
  });

  /**
   * The rules run on nested specs too, and report at the real path. One
   * recursive pass rather than a refinement per level is what buys that — a
   * per-level `ZodEffects` would report at the root and would change what
   * `zod-to-json-schema` emits for the tool parameter `applet.ts` advertises.
   */
  it('reaches a bad spec three levels down and names where it is', () => {
    const res = spec({
      type: 'list',
      of: { type: 'object', fields: { xs: { type: 'list', of: { type: 'enum' } } } },
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0].path.join('.')).toBe('of.fields.xs.of.values');
      expect(res.error.issues[0].message).toBe("type 'enum' requires `values`");
    }
  });

  it('bounds how many fields an object declares', () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_OBJECT_FIELDS; i++) many[`f${i}`] = { type: 'number' };
    expect(spec({ type: 'list', of: { type: 'object', fields: many } }).success).toBe(false);
    expect(spec({ type: 'list', of: { type: 'object', fields: {} } }).success).toBe(false);
  });

  // `.strict()` at every level: an unknown key inside a spec is a spec this
  // binary does not fully understand, and ignoring it is what makes a shape
  // read as closed when it is not.
  it('rejects an unknown key inside a nested spec', () => {
    expect(spec({ type: 'list', of: { type: 'number', pattern: '^[0-9]+$' } }).success).toBe(false);
  });
});

describe('the depth bound', () => {
  it('accepts the deepest shape file_edit_lines needs', () => {
    const res = ArgSpecSchema.safeParse(EDITS);
    expect(res.success).toBe(true);
  });

  it('refuses one hop past it', () => {
    // list -> object -> list -> object: the fourth container.
    const tooDeep = {
      type: 'list',
      of: {
        type: 'object',
        fields: { xs: { type: 'list', of: { type: 'object', fields: { y: { type: 'number' } } } } },
      },
    };
    expect(ArgSpecSchema.safeParse(tooDeep).success).toBe(false);
    // Which level the enum stops offering containers at IS the bound, so state
    // it rather than trusting the example to be one hop over.
    expect(MAX_ARG_DEPTH).toBe(3);
  });

  /**
   * The bound and the representability check must agree, and the failure if
   * they drift is silent and fail-OPEN: `directInvocableRefusal` would admit a
   * tool whose parameter no manifest can name, `mapToolArgs` would omit it,
   * and the tool would be called missing a required argument.
   */
  it('agrees with `isRepresentableParam` at the boundary, in both directions', async () => {
    const { isRepresentableParam } = await import('./direct-tool.js');
    // Builds a zod node with exactly `hops` containers over a scalar, matching
    // the grammar's own alternation of list and object.
    const nest = (hops: number): z.ZodTypeAny =>
      hops === 0
        ? z.string()
        : hops % 2 === 1
          ? z.array(nest(hops - 1))
          : z.object({ a: nest(hops - 1) });
    expect(isRepresentableParam(nest(MAX_ARG_DEPTH))).toBe(true);
    expect(isRepresentableParam(nest(MAX_ARG_DEPTH + 1))).toBe(false);
  });
});

describe('validators built from the table', () => {
  const parsed = ArgSpecSchema.parse(EDITS) as ArgSpec;

  it('accepts a real edit list and rebuilds it rather than passing it through', () => {
    const value = buildArgValidator(parsed).safeParse([
      { action: 'replace', line: 5, content: 'hi' },
      { action: 'delete', lines: [7, 8] },
    ]);
    expect(value.success).toBe(true);
  });

  /**
   * The property the whole design rests on: what reaches a tool is a zod
   * reconstruction of the declared shape, not the caller's object. `.strict()`
   * at every level is what makes "mapped, never passed through" true one level
   * down as well as at the top.
   */
  it('refuses an undeclared key inside an element', () => {
    const value = buildArgValidator(parsed).safeParse([
      { action: 'replace', line: 1, content: 'x', __proto__: 'evil', smuggled: 'yes' },
    ]);
    expect(value.success).toBe(false);
  });

  it('bounds a list, by default and by declaration', () => {
    const unbounded = ArgSpecSchema.parse({ type: 'list', of: { type: 'number' } }) as ArgSpec;
    const many = Array.from({ length: DEFAULT_MAX_ITEMS + 1 }, (_, i) => i);
    expect(buildArgValidator(unbounded).safeParse(many).success).toBe(false);
    expect(buildArgValidator(unbounded).safeParse(many.slice(0, DEFAULT_MAX_ITEMS)).success).toBe(
      true,
    );

    const tight = ArgSpecSchema.parse({
      type: 'list',
      maxItems: 2,
      of: { type: 'number' },
    }) as ArgSpec;
    expect(buildArgValidator(tight).safeParse([1, 2, 3]).success).toBe(false);
  });

  it('applies a field’s own optionality inside an object', () => {
    const value = buildArgValidator(parsed);
    // `action` is required; the other three are not.
    expect(value.safeParse([{ action: 'append', content: 'x' }]).success).toBe(true);
    expect(value.safeParse([{ line: 3 }]).success).toBe(false);
  });

  // Nothing in the grammar produces an unknown type, but a spec built in code
  // could name one, and a widening fallback would accept anything for it.
  it('fails closed on a type it does not know', () => {
    const bogus = { type: 'anything', required: true } as unknown as ArgSpec;
    expect(buildArgValidator(bogus).safeParse('x').success).toBe(false);
    expect(buildArgValidator(bogus).safeParse(undefined).success).toBe(false);
  });
});

describe('argSpecsSince', () => {
  it('reads the demand off the table and names what raised it', () => {
    const scalars = [ArgSpecSchema.parse({ type: 'string' }) as ArgSpec];
    expect(argSpecsSince(scalars)).toEqual({ version: 1, because: undefined });

    const nested = [ArgSpecSchema.parse(EDITS) as ArgSpec];
    const { version, because } = argSpecsSince(nested);
    expect(version).toBe(argTypeHandler('list')?.since);
    expect(because).toBe('list');
  });

  /**
   * The child walk is INSURANCE, and today it is unobservable — stated rather
   * than left to be discovered by whoever deletes it as dead code.
   *
   * Only a container can hold another spec, and both containers shipped at the
   * same revision, so a nested spec's demand never exceeds its parent's and a
   * top-level read gives the same answer. Add a scalar type at a later
   * revision — a `date` at 5, say — and a `list` of it would be stamped 4,
   * written, and refused by the manifest's own refinement on the next read.
   * That is precisely the silent failure `since`-on-the-handler exists to
   * prevent, so the walk stays.
   *
   * The condition is asserted rather than described: while every type at the
   * newest revision is itself a container, this test cannot distinguish a walk
   * from a top-level read, and the day that stops being true the walk needs
   * real coverage.
   */
  it('is currently unable to observe its own child walk, and says why', () => {
    const newest = Math.max(...ARG_TYPES.map((h) => h.since));
    const newestNesting = Math.max(...ARG_TYPES.filter((h) => h.nests).map((h) => h.since));
    expect(
      newestNesting,
      'a non-container type now carries the newest revision — `argSpecsSince`’s ' +
        'child walk is load-bearing and needs a test that can see it',
    ).toBe(newest);

    const nested = [ArgSpecSchema.parse({ type: 'list', of: { type: 'number' } }) as ArgSpec];
    expect(argSpecsSince(nested).version).toBe(argTypeHandler('list')?.since);
  });
});
