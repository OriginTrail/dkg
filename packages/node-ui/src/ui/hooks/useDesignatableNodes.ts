import { useCallback, useMemo, useRef, useState } from 'react';
import { useFetch } from '../hooks.js';
import { listDesignatableNodes, type DesignatableNode } from '../api.js';

// B-staked-nodes (§9.3) — the sharding table is capped (≤500), read+cached whole, and returned in
// ONE response (R4 — no pagination). The picker does search/filter + sort CLIENT-side. Backend
// returns hash-ring order; we sort by stake DESC.

const byStakeDesc = (a: DesignatableNode, b: DesignatableNode): number => {
  try {
    const x = BigInt(a.stake);
    const y = BigInt(b.stake);
    return x === y ? 0 : x > y ? -1 : 1;
  } catch {
    return 0; // non-numeric stake — leave order unchanged
  }
};

export interface UseDesignatableNodes {
  nodes: DesignatableNode[];
  loading: boolean;
  /** A read failure (SHARDING_TABLE_READ_FAILED / transport) — the picker shows a retry; a
   *  primary node is REQUIRED, so edge can't proceed until the list loads (Q1). */
  error: boolean;
  refresh: () => void;
}

/** The staked-node list for the PrimaryNodePicker — fetched whole (one shot), sorted by stake desc. */
export function useDesignatableNodes(): UseDesignatableNodes {
  // M4 — the initial load uses the cache (fast); `refresh` (picker Retry + the
  // PrimaryNodeNotInShardingTable recovery) busts it via `fresh=1`. The ref is read inside the
  // fetcher closure so useFetch's own load/refresh picks up the current mode.
  const freshRef = useRef(false);
  // L8 — surface "Loading…" during a Retry. useFetch doesn't toggle its `loading` on refresh, so
  // track it here off the refresh promise (settles on success OR error — no stuck-true on a repeat error).
  const [refreshing, setRefreshing] = useState(false);
  const { data, loading, error, refresh: rawRefresh } = useFetch(
    () => listDesignatableNodes({ fresh: freshRef.current }).then((r) => r.nodes), // R4 — single fetch
    [],
    0,
  );
  const refresh = useCallback(() => {
    freshRef.current = true;
    setRefreshing(true);
    void Promise.resolve(rawRefresh()).finally(() => setRefreshing(false));
  }, [rawRefresh]);
  const nodes = useMemo(() => [...(data ?? [])].sort(byStakeDesc), [data]);
  return { nodes, loading: loading || refreshing, error: error != null, refresh };
}
