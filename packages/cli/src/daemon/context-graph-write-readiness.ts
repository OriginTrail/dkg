// daemon/context-graph-write-readiness.ts
//
// A write into a Context Graph that this node is still catching up waits,
// bounded, for the catch-up to prove the graph, instead of being refused at once.
//
// The write preflight (`resolveRequiredWriteContextGraphId` in `http-utils.ts`)
// accepts a subscribed graph only once its subscription is proven synced, or
// once the node holds content of it. A subscription the agent restores at
// start comes back unsynced, and a catch-up job proves it again. For a graph
// registered on chain that job asks the graph's peers through its RFC-64
// shared-memory lane, which opens only once the node has accepted the graph's
// authority, read from the chain seconds after start; until then the readiness
// repeat runs the job again. A write in that window was refused with
// CONTEXT_GRAPH_NOT_WRITABLE: a graph's owner, restarted while its graph held
// nothing yet, had its first write refused and had to send it again 13 to 23 s
// later.
//
// So a write that finds its graph subscribed and unsynced, while this daemon
// is catching that graph up, waits until the subscription is proven synced or
// the catch-up stops, at most `writeReadinessWait.timeoutMs`, and is then
// resolved once more, with every check. Catching up means
// (`context-graph-catchup-progress.ts`): a catch-up job for the graph is
// queued or running, its readiness repeat follows one or is armed, or an
// activation catch-up has the graph in hand or will read its admission again.
// While it waits, the write starts the graph's armed repeat at once when that
// repeat waited only for the graph's authority and the authority is in place.
// When the bound passes and the graph is still not writable, the write is
// refused as not writable yet, retryable.
//
// A waiting write never outlives the daemon's shutdown or its own request.
// Graceful shutdown closes the HTTP server before it drains catch-up jobs,
// within a hard deadline, so it ends every wait first: the write is refused at
// once, retryable, and from then on no write waits. A write whose client
// disconnects stops waiting too. Neither is resolved again.
//
// Nothing else changes. A graph that nothing is catching up is refused at once,
// as before. So is every write this node may not make: the preflight refuses
// those before it reaches this wait.

import { contextGraphCatchupInProgress, hurryContextGraphCatchup } from './context-graph-catchup-progress.js';

/** How long a write waits for its graph's catch-up, and how often it looks. Test seam. */
export const writeReadinessWait = {
  /**
   * Well inside the 30 s that clients give a quick write (the OpenClaw
   * adapter's default deadline), with room left for the write itself: a write
   * that waits this long still gets its answer, never the client's own timeout.
   */
  timeoutMs: 20_000,
  pollMs: 250,
};

/** How a write's wait for its graph ended. */
export type WriteReadinessOutcome =
  /** The subscription is proven synced. */
  | 'ready'
  /** Nothing to wait for: the graph is not subscribed, or nothing is catching it up. */
  | 'not-catching-up'
  /** The write waited, and the catch-up stopped without proving the graph, or the subscription went. */
  | 'stopped'
  /** The graph was still being caught up when the bound passed. */
  | 'timed-out'
  /** The daemon began to shut down: the write is refused now, retryable, and never resolved again. */
  | 'shutting-down'
  /** The request went away (its client disconnected): nothing is left to answer. */
  | 'abandoned';

/** The agent's live subscription rows, as far as a write's wait reads them. */
export interface ContextGraphSubscriptionReader {
  getSubscribedContextGraphs?(): ReadonlyMap<string, { readonly subscribed?: boolean; readonly synced?: boolean }>;
}

/** The request a write's wait serves (the route's response): the wait ends when it closes. */
export interface WriteReadinessRequest {
  readonly destroyed?: boolean;
  once?(event: 'close', listener: () => void): unknown;
  removeListener?(event: 'close', listener: () => void): unknown;
}

/** Wakes the writes that wait now. */
const waiting = new Set<() => void>();
/** Shutdown began: no write waits from then on. */
let waitsEnded = false;

/**
 * The daemon begins to shut down: every write that waits for its graph's
 * catch-up is refused now, and no write waits from here on. Shutdown closes
 * the HTTP server before it drains catch-up jobs, within a hard deadline, so a
 * write left waiting for a running job would hold that close until the
 * deadline cut the shutdown off. Called by `beginGracefulShutdown`.
 */
export function endContextGraphWriteReadinessWaits(): void {
  waitsEnded = true;
  for (const wake of waiting) wake();
}

/** Test seam: writes wait again, as before a shutdown began. */
export function resumeContextGraphWriteReadinessWaits(): void {
  waitsEnded = false;
}

/** A known graph that the preflight found not writable on this node. */
export interface KnownNotWritable {
  /** The graph's id, as this node holds its subscription. */
  readonly notWritable: string;
  /** The id as the request named it. */
  readonly raw: string;
}

/** The answer to a write into a known graph that is not writable on this node. */
export interface KnownNotWritableAnswer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers?: Record<string, string>;
}

/**
 * Wait while this daemon catches up a subscribed graph that is not proven
 * synced yet, at most `writeReadinessWait.timeoutMs`. Returns at once when
 * there is nothing to wait for, when shutdown has begun, or when `request`
 * has closed; shutdown and a closing request also end a wait in progress.
 */
export async function awaitContextGraphWriteReadiness(
  agent: ContextGraphSubscriptionReader,
  contextGraphId: string,
  request?: WriteReadinessRequest,
): Promise<WriteReadinessOutcome> {
  const deadline = Date.now() + writeReadinessWait.timeoutMs;
  let waited = false;
  let wake: (() => void) | undefined;
  const interrupt = (): void => wake?.();
  waiting.add(interrupt);
  request?.once?.('close', interrupt);
  try {
    for (;;) {
      if (waitsEnded) return 'shutting-down';
      if (request?.destroyed === true) return 'abandoned';
      const subscription = agent.getSubscribedContextGraphs?.().get(contextGraphId);
      if (subscription?.subscribed === true && subscription.synced === true) return 'ready';
      if (subscription?.subscribed !== true || !contextGraphCatchupInProgress(contextGraphId)) {
        return waited ? 'stopped' : 'not-catching-up';
      }
      hurryContextGraphCatchup(contextGraphId);
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return 'timed-out';
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, Math.min(writeReadinessWait.pollMs, remainingMs)).unref?.();
      });
      wake = undefined;
      waited = true;
    }
  } finally {
    waiting.delete(interrupt);
    request?.removeListener?.('close', interrupt);
  }
}

/**
 * Resolve a write target once; when that finds a known graph not writable on
 * this node, wait for its catch-up as above and resolve the target once more,
 * with every check, however the wait ended: a catch-up that stops without
 * proving the graph may still have left content that makes it writable.
 * `refuse` answers a graph still not writable. A write with nothing to wait
 * for, one that shutdown ended and one whose request closed are refused
 * without a second pass: none of them may go through.
 */
export async function resolveAwaitingWriteReadiness(
  agent: ContextGraphSubscriptionReader,
  resolveOnce: () => Promise<string | KnownNotWritable | null>,
  refuse: (raw: string, outcome: WriteReadinessOutcome) => null,
  request?: WriteReadinessRequest,
): Promise<string | null> {
  const first = await resolveOnce();
  if (first === null || typeof first === 'string') return first;
  const outcome = await awaitContextGraphWriteReadiness(agent, first.notWritable, request);
  const resolveAgain = outcome === 'ready' || outcome === 'stopped' || outcome === 'timed-out';
  const again = resolveAgain ? await resolveOnce() : first;
  if (again === null || typeof again === 'string') return again;
  return refuse(again.raw, outcome);
}

/**
 * The refusal of a write into a known graph that is not writable on this node:
 * not writable yet, retryable, when the wait ended before the graph's catch-up
 * did (the bound passed, shutdown began, or the request closed); else not
 * locally synced, as it always was.
 */
export function knownNotWritableAnswer(raw: string, outcome: WriteReadinessOutcome): KnownNotWritableAnswer {
  if (outcome === 'timed-out' || outcome === 'shutting-down' || outcome === 'abandoned') {
    return {
      status: 503,
      body: {
        code: 'CONTEXT_GRAPH_NOT_WRITABLE',
        retryable: true,
        error: outcome === 'shutting-down'
          ? `Context graph "${raw}" is not writable yet: this node is shutting down. Retry the write once it is back up.`
          : `Context graph "${raw}" is not writable yet: this node is still catching it up. Retry the write shortly.`,
      },
      headers: { 'Retry-After': '5' },
    };
  }
  return {
    status: 400,
    body: {
      code: 'CONTEXT_GRAPH_NOT_WRITABLE',
      error: `Context graph "${raw}" is known but is not locally synced for writes. `
        + 'Subscribe/sync the context graph first, then retry the write.',
    },
  };
}
