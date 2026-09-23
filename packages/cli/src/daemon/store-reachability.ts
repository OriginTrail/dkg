/**
 * A cheap check, for `dkg status`, that an external store answers at all.
 *
 * The quad count is too expensive to run on every status request, so it is
 * reused for minutes, and a store that dies meanwhile would keep showing its
 * last count. `ASK { ?s ?p ?o }` returns at the first triple, so it can run on
 * every explicit request.
 *
 * The probe is never aborted. On a managed Oxigraph, abandoning a read that
 * was already sent hands it to the retained-deadline recovery, which restarts
 * the server at the read's deadline because Oxigraph keeps evaluating it; a
 * slow probe must not restart a busy, healthy store. A caller waits a bounded
 * time instead, and concurrent callers share the probe that is still running.
 */
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { isStoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import type { StoreReachability } from '../status-store-quads-wire.js';

/** How long a status request waits for the store's answer. */
const STORE_PROBE_WAIT_MS = 5_000;

// Keyed by store, so each store has at most one probe running.
const runningProbes = new WeakMap<object, Promise<StoreReachability>>();

function runProbe(agent: DKGAgent): Promise<StoreReachability> {
  return Promise.resolve()
    .then(() => agent.store.query(
      'ASK { ?s ?p ?o }',
      { priority: 'health', source: 'daemon.status.storeProbe' },
    ))
    .then(
      // Any answer, false included (an empty store), means it is reachable.
      (): StoreReachability => 'reachable',
      // The daemon's store scheduler refused or timed out the queued probe:
      // that is daemon load, which says nothing about the store itself.
      (error: unknown): StoreReachability =>
        isStoreSchedulerBusyError(error) ? 'no-answer' : 'unreachable',
    );
}

/**
 * Whether the external store answers, waiting at most `waitMs` for it; a
 * probe that has not settled by then keeps running and later callers share
 * it. Never rejects.
 */
export async function probeExternalStore(
  agent: DKGAgent,
  waitMs: number = STORE_PROBE_WAIT_MS,
): Promise<StoreReachability> {
  const store = agent.store as object;
  let probe = runningProbes.get(store);
  if (probe === undefined) {
    const started = runProbe(agent);
    probe = started;
    runningProbes.set(store, started);
    void started.then(() => {
      if (runningProbes.get(store) === started) runningProbes.delete(store);
    });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const noAnswer = new Promise<StoreReachability>((resolve) => {
    timer = setTimeout(() => resolve('no-answer'), waitMs);
  });
  try {
    return await Promise.race([probe, noAnswer]);
  } finally {
    clearTimeout(timer);
  }
}
