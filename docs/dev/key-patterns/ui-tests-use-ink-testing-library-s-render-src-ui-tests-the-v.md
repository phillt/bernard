<!-- Moved out of CLAUDE.md, which keeps a pointer here. -->

# UI tests use ink-testing-library's render (src/ui/**tests**/). The Vitest include glob covers both .test.ts and .test.tsx. useInput handlers subscribe asynchronously — tests must await tick() between stdin.write calls and assertions; the shared keystroke constants live in src/ui/**tests**/\_keys.ts.

- UI tests use `ink-testing-library`'s `render` (`src/ui/__tests__/`). The Vitest include glob covers both `.test.ts` and `.test.tsx`. `useInput` handlers subscribe asynchronously — tests must `await tick()` between `stdin.write` calls and assertions; the shared keystroke constants live in `src/ui/__tests__/_keys.ts`.
