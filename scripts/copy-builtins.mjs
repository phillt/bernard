import { chmodSync, cpSync, rmSync } from 'node:fs';

/**
 * Copy the bundled data directories into `dist`.
 *
 * **Each destination is removed first, and that is not tidiness.** `cpSync`
 * merges — it never deletes — and `tsc` does not clean either, so a file
 * removed or renamed in `src` stays in `dist` forever across incremental
 * builds. That shipped a real defect: `src/docs/applet-ui-runtime.md` was moved
 * into `docs-generated.ts`, and the stale `dist/docs/applet-ui-runtime.md`
 * meant a built install served that document TWICE — the generated one bound to
 * the live constants, and the drifted hand-written copy that was deleted
 * precisely because it had drifted.
 *
 * It is invisible to the test suite by construction: vitest resolves `src/`, so
 * every finder answers `src/docs` and no test can see `dist` at all. And it is
 * invisible to `git`, since `dist/` is ignored — but `prepublishOnly` runs this
 * against whatever `dist` already exists, so a publish from a working tree
 * carries it.
 *
 * The same hazard applies to the other three: a renamed bundled specialist
 * would leave the old file in `dist`, where `seedOnce` would seed a record the
 * repo no longer has.
 *
 * (Stale `.js` from a deleted `.ts` is the same class one level up and is NOT
 * fixed here — that needs `tsc --build` with a clean step, or an `rm -rf dist`
 * in the build script, and it has its own blast radius.)
 */
for (const dir of ['builtin-specialists', 'builtin-apps', 'data', 'docs']) {
  rmSync(`dist/${dir}`, { recursive: true, force: true });
  cpSync(`src/${dir}`, `dist/${dir}`, { recursive: true });
}

/**
 * Restore the executable bit on the `bin` target.
 *
 * `package.json` points `bin.bernard` at `dist/index.js`, and npm chmods that
 * file when it installs or links the package — once. `tsc` then rewrites it on
 * every build as an ordinary `0644` file, so the shebang survives and the
 * permission does not, and the globally linked `bernard` command dies with a
 * bare `Permission denied` from the shell. Nothing in the test suite can see
 * it: vitest resolves `src/`, and `node dist/index.js` works fine, so the code
 * is provably correct and the command is provably broken at the same time.
 *
 * Local-only by nature — a published tarball is chmodded by npm at install
 * time on the user's machine — which is exactly why it goes unnoticed: it
 * breaks the maintainer's own `bernard`, silently, on every single build.
 */
chmodSync('dist/index.js', 0o755);
