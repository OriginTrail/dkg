import { useMemo } from 'react';
import { useFetch } from '../hooks.js';
import { listDesignatableNodes, type DesignatableNode } from '../api.js';

// B-staked-nodes (§9.3) — the sharding table is capped (≤500) and the daemon serves it from a
// short TTL cache, so the picker fetches it WHOLE (following the offset cursor) and does
// search/filter + sort CLIENT-side. Backend returns hash-ring order; we sort by stake DESC.

async function fetchAllDesignatableNodes(): Promise<DesignatableNode[]> {
  const all: DesignatableNode[] = [];
  let start = 0; // 0-based offset cursor (Backend serves offset pages over the cached table)
  // The table is ≤500; cap the page loop defensively so a misbehaving cursor (a nextStart that
  // never goes null) can't spin forever.
  for (let page = 0; page < 25; page++) {
    const r = await listDesignatableNodes({ start, limit: 200 });
    all.push(...r.nodes);
    if (r.nextStart == null || r.nodes.length === 0) break;
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
  const { data, loading, error, refresh } = useFetch(fetchAllDesignatableNodes, [], 0);
  const nodes = useMemo(() => [...(data ?? [])].sort(byStakeDesc), [data]);
  return { nodes, loading, error: error != null, refresh };
}
