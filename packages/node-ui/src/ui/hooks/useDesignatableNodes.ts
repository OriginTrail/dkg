import { useCallback, useEffect, useRef, useState } from 'react';
import { listDesignatableNodes, type DesignatableNode } from '../api.js';

// B-staked-nodes (§9.3) — the sharding table is capped (≤500), read+cached whole, and returned in
// ONE response (no pagination). The picker does search/filter + sort CLIENT-side; we sort by stake
// DESC. This hook owns its own fetch lifecycle (one-shot load + an explicit cache-busting refresh)
// rather than the shared useFetch, so `loading` covers the refresh too and nothing depends on a
// hidden promise return — the picker's Retry + the create recovery both get honest loading feedback.

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
   *  primary node is REQUIRED, so edge can't proceed until the list loads. */
  error: boolean;
  refresh: () => void;
}

/** The staked-node list for the PrimaryNodePicker — fetched whole (one shot), sorted by stake desc. */
export function useDesignatableNodes(): UseDesignatableNodes {
  const [nodes, setNodes] = useState<DesignatableNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const mountedRef = useRef(true);

  const load = useCallback(async (fresh: boolean) => {
    setLoading(true);
    setError(false);
    try {
      // The initial load uses the daemon's cache (fast); a refresh sends `?fresh=1` to bypass +
      // repopulate it (the picker Retry + the PrimaryNodeNotInShardingTable recovery).
      const r = await listDesignatableNodes(fresh ? { fresh: true } : undefined);
      if (mountedRef.current) setNodes([...r.nodes].sort(byStakeDesc));
    } catch {
      if (mountedRef.current) {
        setNodes([]);
        setError(true);
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load(false);
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  const refresh = useCallback(() => {
    void load(true);
  }, [load]);

  return { nodes, loading, error, refresh };
}
