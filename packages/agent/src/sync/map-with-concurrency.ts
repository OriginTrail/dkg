// map-with-concurrency.ts
//
// Bounded-concurrency ordered map. The catch-up fan-out
// (`runCatchupOverPeers`) previously fired a full durable+SWM sync at EVERY
// connected sync-capable peer via one unbounded `Promise.all` — the top
// amplifier of the 2026-07-07 mainnet "sync storm": one `/api/subscribe` on a
// large-degree node launched N concurrent full-CG pulls, saturating the triple
// store and the muxer. This caps the number of peer syncs running AT ONCE
// without dropping any peer (coverage preserved, just staggered) and without
// changing the result shape callers aggregate over — the returned array is in
// input order, one entry per item, exactly like `Promise.all(items.map(fn))`.

/**
 * Like `Promise.all(items.map(fn))` but with at most `limit` callbacks
 * in flight at any moment. Results preserve input order. `fn` receives the
 * item and its original index. A rejecting `fn` rejects the whole call (same
 * as `Promise.all`) — callers that want per-item isolation must catch inside
 * `fn`, as the catch-up fan-out already does.
 *
 * `limit <= 0` or `limit >= items.length` degrades to a plain `Promise.all`
 * (no pool overhead, byte-identical behaviour to the pre-cap code).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  if (!Number.isInteger(limit) || limit <= 0 || limit >= items.length) {
    return Promise.all(items.map((item, i) => fn(item, i)));
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  // `limit` workers drain the shared cursor; each awaits its item before
  // pulling the next, so no more than `limit` `fn` calls are ever in flight.
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

/**
 * Max peer syncs the catch-up fan-out runs concurrently. Kept small so a
 * high-degree node's subscribe/reconcile round can't flood its own triple
 * store; every selected peer is still synced, just in bounded waves.
 * Env-overridable for operators who need to tune throughput vs. store load.
 */
export const CATCHUP_MAX_CONCURRENT_PEER_SYNCS: number = (() => {
  const raw = Number(process.env.DKG_CATCHUP_MAX_CONCURRENT_PEERS);
  return Number.isInteger(raw) && raw > 0 ? raw : 4;
})();
