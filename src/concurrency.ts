/**
 * Bounded parallelism.
 *
 * Lifted out of `model-validate.ts`, which had the only copy, when a second
 * caller appeared that needed it for a stronger reason: there, the fan-out
 * width is a lineup the user configured; in `claim-verifier.ts` it is the
 * number of claims a MODEL chose to emit. An unbounded `Promise.all` over a
 * model-chosen count is a burst nobody sized.
 */

/**
 * Runs `fn` over `items` with at most `limit` in flight, preserving input
 * order in the result.
 *
 * A fixed pool of workers pulling from a shared cursor, rather than chunking
 * into batches: batching would idle the whole pool waiting for the slowest
 * item in each batch, which matters when per-item latency varies as widely as
 * LLM calls do.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
