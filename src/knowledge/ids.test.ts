import { describe, it, expect } from 'vitest';
import { isValidLibraryId } from './ids.js';

describe('isValidLibraryId', () => {
  it.each(['a', 'docs', 'bernard-docs', '9lives', 'a'.repeat(64)])('accepts %j', (id) => {
    expect(isValidLibraryId(id)).toBe(true);
  });

  // The id becomes a directory name, so traversal and separators are the cases
  // that matter. `..` is the one that would escape `DATA_DIR/knowledge/`.
  it.each([
    ['', 'empty'],
    ['..', 'parent traversal'],
    ['../etc', 'traversal with a tail'],
    ['a/b', 'a path separator'],
    ['a\\b', 'a windows separator'],
    ['a.b', 'a dot — `..` is the reason dots are out entirely'],
    ['Docs', 'uppercase — a case-insensitive filesystem would collide it with `docs`'],
    ['-lead', 'hyphen-initial'],
    ['a'.repeat(65), 'over 64 characters'],
    ['a b', 'a space'],
  ])('rejects %j (%s)', (id) => {
    expect(isValidLibraryId(id)).toBe(false);
  });

  it.each([null, undefined, 42, {}, ['docs']])('rejects the non-string %j', (v) => {
    expect(isValidLibraryId(v)).toBe(false);
  });

  it('is a shape check, not an existence check', () => {
    // The load-bearing property. `knowledgeScope`'s predicate asks whether a
    // domain EXISTS, which is why a library name in that field resolves to `[]`
    // — silent deny-all. A scope naming a library that has not been created yet
    // must survive validation and fail closed later by matching nothing.
    expect(isValidLibraryId('not-created-yet')).toBe(true);
  });

  it('has no imports, so it cannot throw or touch disk on the pre-dispatch path', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./ids.ts', import.meta.url), 'utf-8'),
    );
    // The whole test. A `LIBRARY_ID_RE.source` truthiness check used to sit
    // beside this and could not fail for any non-empty regex.
    expect(src).not.toMatch(/^\s*import\s/m);
  });
});
