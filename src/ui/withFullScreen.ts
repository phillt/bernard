import { MOUSE_ENABLE, MOUSE_DISABLE } from './mouse.js';

/**
 * Full-screen terminal lifecycle: enter the alternate screen buffer (so the
 * REPL owns the whole viewport, vim/htop style) and guarantee the user's screen
 * is restored on every exit path.
 *
 * This is an in-repo utility rather than the `fullscreen-ink` npm package
 * because teardown ordering matters: `src/index.ts` must leave the alt buffer
 * BEFORE running its post-unmount `cleanup()` (which prints via
 * `printInfo`/`printError`), so that output lands on the restored normal screen.
 * Returning a plain `teardown()` gives the caller that control; a render-wrapping
 * library does not.
 *
 * Escapes written (DECSET/DECRST), in order on enter and reverse on exit:
 *   ?1049h — alternate screen buffer (saves the primary screen + cursor)
 *   ?25l   — hide cursor
 *   mouse  — `MOUSE_ENABLE` (?1000h ?1006h), only when `mouse` is true
 *
 * The single owner of this terminal state. The mouse-wheel hook only attaches a
 * stdin parser; it never writes these escapes, so tracking is enabled and torn
 * down exactly with the alt buffer.
 */
export interface FullScreenHandle {
  /** Idempotently restore the terminal and remove the safety-net handlers. */
  teardown: () => void;
}

export interface FullScreenOptions {
  /** Capture the mouse wheel (write the mouse tracking escapes). */
  mouse: boolean;
  /** Output stream to drive. Defaults to `process.stdout` (overridable in tests). */
  stdout?: NodeJS.WriteStream;
}

const ENTER_ALT = '\x1b[?1049h';
const LEAVE_ALT = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

export function withFullScreen(options: FullScreenOptions): FullScreenHandle {
  const stdout = options.stdout ?? process.stdout;
  const { mouse } = options;

  stdout.write(ENTER_ALT + HIDE_CURSOR + (mouse ? MOUSE_ENABLE : ''));

  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    // Reverse order: stop emitting mouse bytes, show the cursor, then drop back
    // to the primary screen. Done before leaving the alt buffer so there is no
    // window where the alt screen is gone but tracking is still on.
    stdout.write((mouse ? MOUSE_DISABLE : '') + SHOW_CURSOR + LEAVE_ALT);
  };

  // Safety net: any abrupt exit must still restore the terminal, or the user is
  // left on a blank alt screen with a hidden cursor and (if mouse is on) a shell
  // that spews `\x1b[<…M` on every pointer move. `process.on('exit')` is the
  // synchronous backstop; signal/exception handlers restore then re-exit.
  const onExit = () => restore();
  const onUncaught = (err: unknown) => {
    restore();
    // Surface the failure on the restored screen, then exit non-zero.
    console.error(err);
    process.exit(1);
  };

  const sigintHandler = () => {
    restore();
    process.exit(130);
  };
  const sigtermHandler = () => {
    restore();
    process.exit(143);
  };
  const sighupHandler = () => {
    restore();
    process.exit(129);
  };

  process.on('exit', onExit);
  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);
  process.on('SIGHUP', sighupHandler);
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);

  return {
    teardown() {
      restore();
      process.removeListener('exit', onExit);
      process.removeListener('SIGINT', sigintHandler);
      process.removeListener('SIGTERM', sigtermHandler);
      process.removeListener('SIGHUP', sighupHandler);
      process.removeListener('uncaughtException', onUncaught);
      process.removeListener('unhandledRejection', onUncaught);
    },
  };
}
