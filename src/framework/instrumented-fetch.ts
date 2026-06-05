/**
 * @module framework/instrumented-fetch
 *
 * Debug-gated wrapper around `globalThis.fetch` that emits JSONL events for
 * every HTTP request the Node runtime makes. Lets a hung session log be read
 * end-to-end and answer "did the request leave the box? did headers come
 * back? did the body ever finish?"
 *
 * **Privacy contract.** We log ONLY the host, the path, the HTTP method, the
 * status code, byte counts, and timings. We never log:
 *   - query strings (may carry tokens / search terms)
 *   - request or response headers (carry the API key)
 *   - request or response bodies (carry prompts, completions, user content)
 *
 * The plan trades fine-grained debuggability for keeping the session log
 * shippable. If you need payload-level tracing, use the AI SDK's own.
 *
 * **Installation.** {@link installInstrumentedFetchIfDebug} is idempotent and
 * does nothing when `BERNARD_DEBUG` is off, so calling it unconditionally
 * from startup is safe.
 */
import crypto from 'node:crypto';
import { debugLog, isDebugEnabled } from '../logger.js';
import { getCurrentDispatchId } from './dispatch-context.js';

let installed = false;

interface BaseLogPayload {
  reqId: string;
  dispatchId?: string;
}

function baseLog(reqId: string): BaseLogPayload {
  const out: BaseLogPayload = { reqId };
  const dispatchId = getCurrentDispatchId();
  if (dispatchId) out.dispatchId = dispatchId;
  return out;
}

function safeUrl(input: RequestInfo | URL): { host: string; path: string } {
  try {
    const raw =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const u = new URL(raw);
    return { host: u.host, path: u.pathname };
  } catch {
    return { host: '<invalid>', path: '<invalid>' };
  }
}

function extractMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input === 'object' && input !== null && 'method' in input) {
    return (input as Request).method?.toUpperCase() ?? 'GET';
  }
  return 'GET';
}

export function installInstrumentedFetchIfDebug(): void {
  if (installed) return;
  if (!isDebugEnabled()) return;
  if (typeof globalThis.fetch !== 'function') return;

  const original = globalThis.fetch.bind(globalThis);

  const wrapped: typeof fetch = async (input, init) => {
    const reqId = crypto.randomBytes(3).toString('hex');
    const { host, path } = safeUrl(input);
    const method = extractMethod(input, init);
    const start = Date.now();

    debugLog('http:request:start', { ...baseLog(reqId), host, path, method });

    let res: Response;
    try {
      res = await original(input, init);
    } catch (err) {
      debugLog('http:request:error', {
        ...baseLog(reqId),
        ms: Date.now() - start,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    debugLog('http:response:headers', {
      ...baseLog(reqId),
      status: res.status,
      ttlms: Date.now() - start,
    });

    // Replace `res.body` with a TransformStream that counts bytes and emits
    // http:response:end on close. If the caller never reads the body we
    // never see the end event — that's OK, the start/headers pair is the
    // diagnostically useful piece for hang triage.
    if (!res.body) return res;
    let bytes = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
      flush() {
        debugLog('http:response:end', {
          ...baseLog(reqId),
          bytes,
          ttlmsTotal: Date.now() - start,
        });
      },
    });
    const piped = res.body.pipeThrough(counter);
    return new Response(piped, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };

  globalThis.fetch = wrapped;
  installed = true;
}

/** Test-only hook to undo the patch between vitest cases. */
export function __resetInstrumentedFetchForTesting(original: typeof fetch): void {
  globalThis.fetch = original;
  installed = false;
}
