import { createRequire } from 'node:module';
import type { Agent } from 'undici';

/**
 * Node's built-in fetch (undici) stops waiting after 300 s without response
 * headers or without body bytes: `headersTimeout` and `bodyTimeout` both
 * default to 300e3 ms. Local-agent bridges answer a non-streaming turn only
 * when the agent finishes, and a streamed turn can go quiet through a long tool
 * call, so channel forwards on the default dispatcher were cut off after about
 * 5 minutes whatever their AbortSignal allowed, and failed as `fetch failed` or
 * `terminated` instead of as a TimeoutError.
 *
 * Channel forwards therefore run on a dispatcher whose socket timers sit past
 * the forward's own deadline, which leaves the AbortSignal as the only
 * deadline. The dispatcher comes from undici 7 because its Agent accepts the
 * handlers of the undici that Node bundles on every supported line (6 on
 * Node 22, 7 on Node 24/25, 8 on Node 26). It is loaded on the first forward
 * rather than at import time: every CLI command imports the daemon routes.
 */
const DISPATCHER_TIMER_MARGIN_MS = 60_000;

const requireUndici = createRequire(import.meta.url);
const dispatchers = new Map<number, Agent>();

/** undici header/body timer used for a forward whose deadline is `deadlineMs`. */
export function localAgentChannelDispatcherTimeoutMs(deadlineMs: number): number {
  return deadlineMs + DISPATCHER_TIMER_MARGIN_MS;
}

function localAgentChannelDispatcher(deadlineMs: number): Agent {
  let dispatcher = dispatchers.get(deadlineMs);
  if (!dispatcher) {
    const undici = requireUndici('undici') as typeof import('undici');
    const timeoutMs = localAgentChannelDispatcherTimeoutMs(deadlineMs);
    dispatcher = new undici.Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
    dispatchers.set(deadlineMs, dispatcher);
  }
  return dispatcher;
}

/**
 * `fetch` options for a local-agent channel forward that may run for
 * `deadlineMs`: an AbortSignal at the deadline, and a dispatcher that does not
 * give up before it.
 */
export function localAgentChannelFetchInit(deadlineMs: number): RequestInit {
  // `dispatcher` is undici's extension to RequestInit; the DOM typings omit it.
  return {
    signal: AbortSignal.timeout(deadlineMs),
    dispatcher: localAgentChannelDispatcher(deadlineMs),
  } as RequestInit;
}

/**
 * True when undici's own header or body timer ended the request
 * (`UND_ERR_HEADERS_TIMEOUT` / `UND_ERR_BODY_TIMEOUT`). fetch reports them as
 * `TypeError('fetch failed')` or `TypeError('terminated')` with the timer error
 * as `cause`. Either way the forward reached the agent and went unanswered, so
 * callers must report a timeout and must not retry the turn on another target.
 */
export function isUndiciResponseTimeoutError(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null | undefined;
  return [e?.code, e?.cause?.code].some(
    (code) => code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT',
  );
}
