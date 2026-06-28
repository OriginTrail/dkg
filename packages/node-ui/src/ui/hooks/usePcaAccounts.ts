import { useMemo } from 'react';
import { useFetch } from '../hooks.js';
import { fetchPca, HttpError, type PcaSnapshot } from '../api.js';
import { usePcaStore } from '../stores/pca.js';

/**
 * The resolution of one tracked PCA id: its snapshot, or the error that
 * resolving it produced. `notFound` flags the daemon's 404 (the tracked id no
 * longer exists on-chain) so the overview can offer "Remove from tracked"
 * rather than a generic retry (S1 partial/per-card error state).
 */
export interface PcaAccountResolution {
  accountId: string;
  snapshot: PcaSnapshot | null;
  error: unknown;
  notFound: boolean;
}

/**
 * Resolve the locally-tracked PCA id set into snapshots — the foundational data
 * hook the Conviction overview (S1) consumes. Mirrors `useFetch`: one fetch on
 * mount, optional visibility-aware polling, and 401 reload handling, all
 * inherited by delegating to it.
 *
 * Each id is fetched in PARALLEL via `Promise.allSettled`, so one failing id
 * never blanks the others (S1 "one failing card never blanks the others") — the
 * aggregate fetcher never rejects, so `error` here is reserved for a
 * catastrophic failure of the whole batch, and per-id failures live on each
 * resolution.
 */
export function usePcaAccounts(intervalMs = 0): {
  accounts: PcaAccountResolution[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const trackedIds = usePcaStore((s) => s.trackedIds);
  // A stable primitive dep so `useFetch` re-runs only when the SET changes,
  // not on every render (the array identity is fresh each store read).
  const idsKey = trackedIds.join(',');

  const { data, loading, error, refresh } = useFetch<PcaAccountResolution[]>(
    async () => {
      if (trackedIds.length === 0) return [];
      const settled = await Promise.allSettled(trackedIds.map((id) => fetchPca(id)));
      return settled.map((res, i): PcaAccountResolution => {
        const accountId = trackedIds[i]!;
        if (res.status === 'fulfilled') {
          return { accountId, snapshot: res.value, error: null, notFound: false };
        }
        const err = res.reason;
        const notFound = err instanceof HttpError && err.status === 404;
        return { accountId, snapshot: null, error: err, notFound };
      });
    },
    [idsKey],
    intervalMs,
  );

  const accounts = useMemo(() => data ?? [], [data]);
  return { accounts, loading, error, refresh };
}
