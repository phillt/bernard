import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Real files, real descriptors, real `O_APPEND` — deliberately not a mocked
 * `fs`.
 *
 * The property #587 is about is a kernel one: whether the descriptor a child
 * holds still points at the bounded file afterwards. A mocked `fs` would
 * assert that we called the functions we chose to call, which is the one thing
 * that cannot be wrong here. `setup-test-home.ts` already points
 * `BERNARD_HOME` at a throwaway directory, so this writes nowhere real.
 */
async function loadLogger() {
  // `logger.ts` latches its session id, its directory creation, its open
  // descriptors and its size-check timer at module scope — "the first sidecar
  // of the process" is only true once. Same treatment `notify.test.ts` gives
  // its own module-level flag.
  vi.resetModules();
  return import('./logger.js');
}

/** Where the sidecar for `suffix` lands, per `openSessionSidecarFd`. */
async function sidecarPath(logger: typeof import('./logger.js'), suffix: string): Promise<string> {
  const { SESSION_LOGS_DIR } = await import('./paths.js');
  return path.join(SESSION_LOGS_DIR, `${logger.getSessionId()}-${suffix}`);
}

/** The cap and tail `logger.ts` holds; restated by hand so the test is not self-consistent with them. */
const MAX_BYTES = 4 * 1024 * 1024;
const KEEP_BYTES = 512 * 1024;
const CHECK_MS = 30_000;

describe('session sidecars are bounded within a session (#587)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('BERNARD_DEBUG', '1');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  /**
   * The acceptance criterion. Rotation counts SESSIONS and runs once per
   * process, so a daemon that never restarts never rotates; without an
   * in-session bound this file grows until the disk does.
   */
  it('truncates a sidecar that grew past the cap', async () => {
    const logger = await loadLogger();
    const fd = logger.openSessionSidecarFd('test-stderr.log');
    expect(fd).not.toBeNull();
    const file = await sidecarPath(logger, 'test-stderr.log');

    // Written through the descriptor, the way the child writes.
    fs.writeSync(fd!, 'x'.repeat(MAX_BYTES + 100_000) + '\n');
    expect(fs.statSync(file).size).toBeGreaterThan(MAX_BYTES);

    vi.advanceTimersByTime(CHECK_MS);

    const after = fs.statSync(file).size;
    expect(after).toBeLessThanOrEqual(KEEP_BYTES + 200);
  });

  /**
   * The reason a tmp+rename rotation — the idiom every other bounded file in
   * the tree uses — is not available here. The child holds this descriptor for
   * its whole life; renaming the file out from under it bounds nothing,
   * because the child keeps writing to the renamed inode. Truncating in place
   * is what keeps the two ends pointing at the same file.
   *
   * This is the assertion that carries #587, and the size check above is not:
   * mutation-checked against a naive rename rotation, "truncates a sidecar
   * that grew past the cap" PASSES — the path really is small — while the disk
   * fills with an inode nothing can see.
   */
  it('leaves the childs descriptor writing to the same bounded file', async () => {
    const logger = await loadLogger();
    const fd = logger.openSessionSidecarFd('test-stderr.log')!;
    const file = await sidecarPath(logger, 'test-stderr.log');

    fs.writeSync(fd, 'x'.repeat(MAX_BYTES + 100_000) + '\n');
    vi.advanceTimersByTime(CHECK_MS);

    // The same fd the child was handed, used after the truncation.
    fs.writeSync(fd, 'AFTER-THE-TRUNCATION\n');

    expect(fs.readFileSync(file, 'utf-8')).toContain('AFTER-THE-TRUNCATION');
    // And nothing was left behind for the retention sweep to mistake for
    // another session.
    expect(fs.existsSync(file + '.old')).toBe(false);
    expect(fs.existsSync(file + '.1')).toBe(false);
  });

  /**
   * A sidecar exists to be read after a child misbehaved, so the last thing it
   * said is the part worth keeping — the policy `CronLogStore.rotate` already
   * applies to a file Bernard does own. Truncating to zero would bound the
   * file and discard exactly what someone opens it for.
   */
  it('keeps the tail, not the head', async () => {
    const logger = await loadLogger();
    const fd = logger.openSessionSidecarFd('test-stderr.log')!;
    const file = await sidecarPath(logger, 'test-stderr.log');

    fs.writeSync(fd, 'FIRST-THING-IT-SAID\n');
    fs.writeSync(fd, 'x\n'.repeat(MAX_BYTES / 2));
    fs.writeSync(fd, 'LAST-THING-IT-SAID\n');

    vi.advanceTimersByTime(CHECK_MS);

    const body = fs.readFileSync(file, 'utf-8');
    expect(body).toContain('LAST-THING-IT-SAID');
    expect(body).not.toContain('FIRST-THING-IT-SAID');
  });

  // A bounded thing says so — otherwise a reader cannot tell a truncated
  // sidecar from a child that only ever said this much.
  it('names how many bytes it dropped', async () => {
    const logger = await loadLogger();
    const fd = logger.openSessionSidecarFd('test-stderr.log')!;
    const file = await sidecarPath(logger, 'test-stderr.log');

    fs.writeSync(fd, 'x\n'.repeat(MAX_BYTES));
    vi.advanceTimersByTime(CHECK_MS);

    const head = fs.readFileSync(file, 'utf-8').split('\n')[0];
    expect(head).toMatch(/^--- bernard: dropped \d+ earlier bytes/);
    expect(head).not.toContain('dropped 0 earlier bytes');
  });

  // stderr is line-oriented and gets grepped; opening on half a stack frame is
  // a puzzle rather than a record.
  it('starts the kept block on a line boundary', async () => {
    const logger = await loadLogger();
    const fd = logger.openSessionSidecarFd('test-stderr.log')!;
    const file = await sidecarPath(logger, 'test-stderr.log');

    // Fixed-width lines, so a cut at an arbitrary byte lands mid-line unless
    // something realigns it.
    fs.writeSync(fd, ('LINE ' + 'y'.repeat(60) + '\n').repeat(MAX_BYTES / 66 + 5000));
    vi.advanceTimersByTime(CHECK_MS);

    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    expect(lines[0]).toMatch(/^--- bernard: dropped/);
    expect(lines[1]).toBe('LINE ' + 'y'.repeat(60));
  });

  it('leaves a sidecar within budget byte-identical', async () => {
    const logger = await loadLogger();
    const fd = logger.openSessionSidecarFd('test-stderr.log')!;
    const file = await sidecarPath(logger, 'test-stderr.log');

    fs.writeSync(fd, 'a quiet server\n');
    vi.advanceTimersByTime(CHECK_MS * 10);

    expect(fs.readFileSync(file, 'utf-8')).toBe('a quiet server\n');
  });

  /**
   * The check is installed lazily, on the first successful open, so every
   * process that never hands a descriptor to a child — every CLI subcommand,
   * every debug-off run, most tests — never creates the timer at all.
   */
  it('installs no timer when debug is off', async () => {
    vi.stubEnv('BERNARD_DEBUG', '');
    const logger = await loadLogger();

    expect(logger.openSessionSidecarFd('test-stderr.log')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('installs exactly one timer however many sidecars are opened', async () => {
    const logger = await loadLogger();

    logger.openSessionSidecarFd('one.log');
    logger.openSessionSidecarFd('two.log');
    logger.openSessionSidecarFd('one.log');

    expect(vi.getTimerCount()).toBe(1);
  });

  // One descriptor per suffix per process: the child is handed the fd once and
  // holds it, and re-opening would leave the previous one growing unwatched.
  it('hands back the same descriptor for a suffix it already opened', async () => {
    const logger = await loadLogger();

    const first = logger.openSessionSidecarFd('test-stderr.log');
    expect(logger.openSessionSidecarFd('test-stderr.log')).toBe(first);
  });

  /**
   * Retention stays per SESSION. A sidecar is one of the files a session
   * writes, so the bound above must not have taught the sweep to rank it on
   * its own — that would let a single run consume several `MAX_SESSIONS` slots
   * and retain a sidecar whose transcript had already been deleted.
   */
  it('still groups a sidecar with its own transcript for retention', async () => {
    const logger = await loadLogger();
    const { SESSION_LOGS_DIR } = await import('./paths.js');

    logger.openSessionSidecarFd('test-stderr.log');
    logger.debugLog('hello', {});

    const id = logger.getSessionId();
    const names = fs.readdirSync(SESSION_LOGS_DIR).filter((n) => n.startsWith(id));
    expect(names).toContain(`${id}.jsonl`);
    expect(names).toContain(`${id}-test-stderr.log`);
  });
});
