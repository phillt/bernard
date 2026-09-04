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
 * `./build/index.js`, so a deep import would break on any patch release.
 *
 * Terminals genuinely disagree about which of these they send (xterm `CSI H`,
 * application-cursor-mode `SS3 OH`, vt220 `CSI 1~`, rxvt `CSI 7~`), so all of
 * them have to be here — supporting only the one your terminal happens to emit
 * is how this reads as "works for me".
 */
const NAV_SEQUENCES: ReadonlyArray<readonly [string, NavKey]> = [
  ['[H', 'home'],
  ['OH', 'home'],
  ['[1~', 'home'],
  ['[7~', 'home'],
  ['[F', 'end'],
  ['OF', 'end'],
  ['[4~', 'end'],
  ['[8~', 'end'],
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
  if (!chunk.includes('\x1b')) return [];
  const found: NavKey[] = [];
  for (let i = 0; i < chunk.length; i++) {
    if (chunk[i] !== '\x1b') continue;
    for (const [seq, name] of NAV_SEQUENCES) {
      if (chunk.startsWith(seq, i + 1)) {
        found.push(name);
        i += seq.length; // skip the sequence; the loop's i++ covers the ESC
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
  return input.includes('[13;') ? input.replace(MODIFIED_ENTER_RE, '') : input;
}

/** True when `input` is a modified Enter and nothing else. */
export function isModifiedEnter(input: string): boolean {
  return input.length > 0 && stripModifiedEnter(input) === '';
}
