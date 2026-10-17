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
// is catching that graph up, waits until the subscription is proven synced,
// at most `writeReadinessWait.timeoutMs`, and is then resolved once more, with
// every check. Catching up means (`context-graph-catchup-progress.ts`): a
// catch-up job for the graph is queued or running, its readiness repeat
// follows one or is armed, or an activation catch-up has the graph in hand or
// will read its admission again. While it waits, the write starts the graph's
// armed repeat at once when that repeat waited only for the graph's authority
// and the authority is in place. When the bound passes, the write is refused
// as not writable yet, retryable.
//
// Nothing else changes. A graph that nothing is catching up is refused at once,
// as before. So is every write this node may not make: the preflight refuses
// those before it reaches this wait.

import { contextGraphCatchupInProgress, hurryContextGraphCatchup } from './context-graph-catchup-progress.js';

/** How long a write waits for its graph's catch-up, and how often it looks. Test seam. */
export const writeReadinessWait = {
  /** As long as a share waits for a recipient key or for the legacy shared-memory fence. */
  timeoutMs: 30_000,
  pollMs: 250,
};

/** How a write's wait for its graph ended. */
export type WriteReadinessOutcome =
  /** The subscription is proven synced: the write is resolved again. */
  | 'ready'
  /** The graph is not subscribed, or nothing is catching it up (any more). */
  | 'not-catching-up'
  /** The graph was still being caught up when the bound passed. */
  | 'timed-out';

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

type SubscriptionFlags = { readonly subscribed?: unknown; readonly synced?: unknown };

/** Reads the agent's live subscription row of a graph; undefined for an agent without subscriptions. */
function subscriptionReader(agent: object): ((contextGraphId: string) => SubscriptionFlags | undefined) | undefined {
  const { getSubscribedContextGraphs } = agent as {
    getSubscribedContextGraphs?: () => ReadonlyMap<string, SubscriptionFlags>;
  };
  if (typeof getSubscribedContextGraphs !== 'function') return undefined;
  return (contextGraphId) => getSubscribedContextGraphs.call(agent).get(contextGraphId);
}

/**
 * Wait while this daemon catches up a subscribed graph that is not proven
 * synced yet, at most `writeReadinessWait.timeoutMs`. Returns at once when
 * there is nothing to wait for.
 */
export async function awaitContextGraphWriteReadiness(
  agent: object,
  contextGraphId: string,
): Promise<WriteReadinessOutcome> {
  const read = subscriptionReader(agent);
  if (read === undefined) return 'not-catching-up';
  const deadline = Date.now() + writeReadinessWait.timeoutMs;
  for (;;) {
    const subscription = read(contextGraphId);
    if (subscription?.subscribed !== true) return 'not-catching-up';
    if (subscription.synced === true) return 'ready';
    if (!contextGraphCatchupInProgress(contextGraphId)) return 'not-catching-up';
    hurryContextGraphCatchup(contextGraphId);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return 'timed-out';
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(writeReadinessWait.pollMs, remainingMs)).unref?.();
    });
  }
}

/**
 * Resolve a write target once; when that finds a known graph not writable on
 * this node, wait for its catch-up as above and, once it is proven synced,
 * resolve the target once more. `refuse` answers a graph still not writable.
 */
export async function resolveAwaitingWriteReadiness(
  agent: object,
  resolveOnce: () => Promise<string | KnownNotWritable | null>,
  refuse: (raw: string, outcome: WriteReadinessOutcome) => null,
): Promise<string | null> {
  const first = await resolveOnce();
  if (first === null || typeof first === 'string') return first;
  const outcome = await awaitContextGraphWriteReadiness(agent, first.notWritable);
  const again = outcome === 'ready' ? await resolveOnce() : first;
  if (again === null || typeof again === 'string') return again;
  return refuse(again.raw, outcome);
}

/**
 * The refusal of a write into a known graph that is not writable on this node:
 * not writable yet, retryable, when the bound passed while the graph was being
 * caught up; else not locally synced, as it always was.
 */
export function knownNotWritableAnswer(raw: string, outcome: WriteReadinessOutcome): KnownNotWritableAnswer {
  if (outcome === 'timed-out') {
    return {
      status: 503,
      body: {
        code: 'CONTEXT_GRAPH_NOT_WRITABLE',
        retryable: true,
        error: `Context graph "${raw}" is not writable yet: this node is still catching it up. `
          + 'Retry the write shortly.',
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
