/**
 * Names the terminal tab "Bernard" while the REPL runs, and gives the old name
 * back on the way out.
 *
 * The old title is SAVED on the terminal's own title stack (xterm's
 * `CSI 22;0 t` push / `CSI 23;0 t` pop), because no terminal lets a program
 * read its title back. A terminal without the stack ignores both and keeps
 * "Bernard" until the shell's prompt sets a title of its own, which most do —
 * harmless either way, since an unknown CSI sequence is dropped, not printed.
 */
const PUSH_TITLE = '\x1b[22;0t';
const POP_TITLE = '\x1b[23;0t';
const setTitle = (title: string): string => `\x1b]0;${title}\x07`;

export interface TerminalTitleHandle {
  restore(): void;
}

export function setTerminalTitle(
  title: string,
  stdout: NodeJS.WriteStream = process.stdout,
): TerminalTitleHandle {
  // A piped or redirected stdout would get the escapes as literal bytes.
  if (!stdout.isTTY) return { restore: () => undefined };
  stdout.write(PUSH_TITLE + setTitle(title));
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    process.removeListener('exit', restore);
    stdout.write(POP_TITLE);
  };
  // The synchronous backstop: `withFullScreen`'s signal handlers exit through
  // `process.exit`, which fires this, so a Ctrl-C still hands the title back.
  process.on('exit', restore);
  return { restore };
}
