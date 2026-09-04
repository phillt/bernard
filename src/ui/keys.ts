/**
 * Terminal key sequences Ink 5 does not hand us usefully (#399).
 *
 * Two distinct failures, one module, because they are the same class — an
 * escape sequence the input layer either discards or mistakes for text — and
 * both are decided by pattern alone, so this stays pure (no I/O, no React, no
 * Ink) and its tests need none of them. Same split as `mouse.ts` /
 * `useMouseWheel.ts` and `line-geometry.ts` / `use-line-editor.tsx`.
 *
 * **Home/End are parsed by Ink and then thrown away.**
 * `ink/build/parse-keypress.js` maps every encoding to the name `home`/`end`,
 * but `use-input.js` builds its `Key` from a hard-coded field list that has no
 * `home`/`end`, and blanks `input` because those names are in
 * `nonAlphanumericKeys`. So `useInput` sees `input: ''` with no flags —
 * indistinguishable from noise, which is why `use-line-editor` binds `Ctrl-A` /
 * `Ctrl-E` instead and why `TranscriptViewport`'s raw-escape match was dead
 * code. `PgUp` survives only because `Key` happens to have a `pageUp` field.
 *
 * Upgrading is not the cheap way out: `ink@6.6.0` adds the fields, and requires
 * **React >= 19** against our 18.3. So we decode the bytes ourselves, off a
 * `'data'` listener, exactly as CLAUDE.md already prescribes for mouse reports.
 *
 * **Modified Enter (CSI-u) is not parsed at all.** kitty/foot/ghostty send
 * Shift+Enter as `ESC [ 13 ; 2 u`; Ink's `fnKeyRe` cannot match a `;`-separated
 * parameter list ending in `u`, so it strips the ESC and passes `[13;2u` on as
 * ordinary printable text — which the editor then types.
 */

/** A navigation key Ink parses but does not surface. */
export type NavKey = 'home' | 'end';

/**
 * Every encoding Ink's own `keyName` table maps to `home`/`end`, mirrored here
 * because Ink's parser is not importable — its `exports` map exposes only
 * `./build/index.js`, so a deep import in production would break on any patch
 * release.
 *
 * Terminals genuinely disagree about which of these they send (xterm `CSI H`,
 * application-cursor-mode `SS3 OH`, vt220 `CSI 1~`, rxvt `CSI 7~` plus its
 * modified `$`/`^` forms), so all of them have to be here — supporting only the
 * one your terminal happens to emit is how this reads as "works for me".
 *
 * **A mirror drifts, so the drift is a test rather than a promise.** This list
 * shipped with four of Ink's twelve rows missing on its first draft, under a
 * docstring that already claimed to be complete — which is the whole argument
 * against mirroring, answering itself. `keys.test.ts` reads Ink's `keyName`
 * table out of `node_modules` by file path (the `exports` map does not restrict
 * that, and a test may depend on the installed tree in a way production must
 * not) and fails if any `home`/`end` row here is missing. Same direction as
 * `meta-coverage.test.ts`: walk the source of truth, not the copy.
 *
 * Known limit, since it decides how the next key lands: a literal-prefix table
 * cannot express **modified** Home/End (`ESC [ 1;5 H` = Ctrl+Home), which Ink
 * parses to `home` with a `ctrl` modifier. Supporting those means a regex, not
 * another row.
 */
const NAV_SEQUENCES: ReadonlyArray<readonly [string, NavKey]> = [
  ['[H', 'home'],
  ['OH', 'home'],
  ['[1~', 'home'],
  ['[7~', 'home'],
  ['[7$', 'home'], // rxvt Shift+Home
  ['[7^', 'home'], // rxvt Ctrl+Home
  ['[F', 'end'],
  ['OF', 'end'],
  ['[4~', 'end'],
  ['[8~', 'end'],
  ['[8$', 'end'], // rxvt Shift+End
  ['[8^', 'end'], // rxvt Ctrl+End
];

/**
 * Modified Enter in CSI-u encoding: `ESC [ <codepoint> ; <modifiers> u`, where
 * 13 is Return. The leading ESC is optional because Ink strips it before
 * handing the fragment to `useInput` — the same reason `mouse.ts`'s
 * `MOUSE_REPORT_RE` carries `\x1b?`.
 */
const MODIFIED_ENTER_RE = /\x1b?\[13;\d+u/g;

/**
 * Navigation keys found anywhere in a raw stdin chunk, in order.
 *
 * A scan rather than a whole-chunk match, because a TTY read returns whatever
 * was buffered: fast typing, key repeat, or a paste all coalesce several
 * keystrokes into one chunk. Ink 5 anchors its own parse at the start of the
 * chunk and so mis-handles exactly these cases (measured: `"abc" + Home`
 * arrives as the literal text `abc\x1b[H`, and `Home + "abc"` loses the `abc`
 * entirely). We cannot fix what Ink does with the chunk — there is no
 * consumption model, so it sees the same bytes regardless — but our own
 * decoding must not inherit the bug.
 *
 * Returns every occurrence, so a held-down End that coalesces into one chunk
 * still moves once per press rather than once per chunk.
 */
export function parseNavKeys(chunk: string): NavKey[] {
  const found: NavKey[] = [];
  // `indexOf` to jump between escapes rather than walking every character: a
  // chunk with no ESC costs one scan and returns, and — the case a plain
  // character loop gets wrong — a chunk that DOES contain one does not then pay
  // the 8-way comparison per character for its whole length. Measured on a
  // 100 KB paste carrying a single escape: 172 µs walking, 0.7 µs jumping.
  //
  // A `matchAll` over one alternation regex is shorter, matches `mouse.ts`'s
  // style, and was measured equivalent on all 18 cases in `keys.test.ts` — but
  // it is **60x slower** on that same paste (41.8 µs) and 8x on an ordinary
  // keystroke. This runs on every stdin chunk, from up to three listeners, so
  // the longer form wins the axis that matters. Do not "simplify" it back.
  for (let i = chunk.indexOf('\x1b'); i !== -1; i = chunk.indexOf('\x1b', i + 1)) {
    for (const [seq, name] of NAV_SEQUENCES) {
      if (chunk.startsWith(seq, i + 1)) {
        found.push(name);
        i += seq.length;
        break;
      }
    }
  }
  return found;
}

/**
 * `input` with any CSI-u modified-Enter sequences removed.
 *
 * Removal rather than a `looksLikeMouseReport`-style anchored "is this entirely
 * a report?" predicate, because the two cases differ: a mouse report is noise
 * whichever way it arrives, whereas a modified Enter can be coalesced with real
 * typing (`"[13;2uabc"`), and swallowing the whole chunk would silently eat the
 * `abc`. The caller inserts whatever is left — nothing, in the common case
 * where the keypress arrived alone.
 */
export function stripModifiedEnter(input: string): string {
  return input.replace(MODIFIED_ENTER_RE, '');
}

/**
 * True when `input` is a modified Enter and nothing else.
 *
 * `Prompt`'s newline intent, where the whole keypress must be the chord — it
 * inserts a real newline, so a chunk that also carried typing has to fall
 * through to the editor and be stripped there instead. Shared with
 * {@link stripModifiedEnter} rather than spelled again as a regex in
 * `Prompt.tsx`, which is where it lived and where it could drift from this one.
 */
export function isModifiedEnter(input: string): boolean {
  return input.length > 0 && stripModifiedEnter(input) === '';
}
