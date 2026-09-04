/**
 * Whether a process is still running.
 *
 * `kill(pid, 0)` sends no signal — it only asks whether the process exists and
 * is signallable. The third hand-rolled copy of these four lines was about to
 * be written (`cron/client.ts` and `host/client.ts` each carry one inline), so
 * it lives here instead.
 *
 * **What it cannot tell you** is whether the PID still belongs to the process
 * that wrote it down: an exited process's id can be recycled. `host/client.ts`
 * argues, correctly, that a health probe beats this for a SERVER — a stale
 * port entry can hand a payload to a stranger. What it costs elsewhere depends
 * on what a false "alive" leads to, so a caller relying on this should say
 * which way it fails.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
