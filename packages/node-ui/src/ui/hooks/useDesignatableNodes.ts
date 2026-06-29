import { useCallback, useMemo, useRef } from 'react';
import { useFetch } from '../hooks.js';
import { listDesignatableNodes, type DesignatableNode } from '../api.js';

// B-staked-nodes (§9.3) — the sharding table is capped (≤500) and the daemon serves it from a
// short TTL cache, so the picker fetches it WHOLE (following the offset cursor) and does
// search/filter + sort CLIENT-side. Backend returns hash-ring order; we sort by stake DESC.

async function fetchAllDesignatableNodes(fresh = false): Promise<DesignatableNode[]> {
  const all: DesignatableNode[] = [];
  let start = 0; // 0-based offset cursor (Backend serves offset pages over the cached table)
  // L11 — drive off the route's `total` (the sharding-table size is governance-mutable, so no magic
  // page cap that could silently truncate). Stop when collected >= total or the cursor ends; the
  // `guard` is only a defensive backstop against a pathological never-null cursor.
  for (let guard = 0; guard < 100; guard++) {
    // M4 — bust the cache on the FIRST page only: `fresh=1` re-reads the chain AND repopulates the
    // daemon cache, so subsequent pages read the just-refreshed list.
    const r = await listDesignatableNodes({ start, limit: 200, fresh: fresh && start === 0 });
    all.push(...r.nodes);
    if (r.nextStart == null || r.nodes.length === 0 || all.length >= r.total) break;
    start = r.nextStart;
  }
  return all;
}

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

/** The staked-node list for the PrimaryNodePicker — fetched whole, sorted by stake desc. */
export function useDesignatableNodes(): UseDesignatableNodes {
  // M4 — the initial load uses the cache (fast); `refresh` (picker Retry + the
  // PrimaryNodeNotInShardingTable recovery) busts it via `fresh=1`. The ref is read inside the
  // fetcher closure so useFetch's own load/refresh picks up the current mode.
  const freshRef = useRef(false);
  const { data, loading, error, refresh: rawRefresh } = useFetch(
    () => fetchAllDesignatableNodes(freshRef.current),
    [],
    0,
  );
  const refresh = useCallback(() => {
    freshRef.current = true;
    rawRefresh();
  }, [rawRefresh]);
  const nodes = useMemo(() => [...(data ?? [])].sort(byStakeDesc), [data]);
  return { nodes, loading, error: error != null, refresh };
}
