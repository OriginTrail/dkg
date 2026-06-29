import { useEffect, useMemo } from 'react';
import { useFetch } from '../hooks.js';
import {
  fetchWalletsBalances,
  pcaAgentAccount,
  fetchMyPcas,
  type MyPcaEntry,
  type PcaSnapshot,
} from '../api.js';
import { usePcaStore } from '../stores/pca.js';

/** A PCA this node RELATES to but may not have locally tracked (GAP-1). */
export interface DiscoveredPca {
  accountId: string;
  /** owned (NFT owner is a node wallet) / agent (a node op wallet is approved here) / both. */
  relation: 'owned' | 'agent' | 'both';
  /** The node op wallet registered here (set for agent/both — drives the strip copy). */
  agentWallet?: string;
  /** Hydrated snapshot basics from `fetchMyPcas?hydrate=1`, when available. */
  basics?: Partial<PcaSnapshot>;
}

export interface UseDiscoveredPcas {
  /** Every related PCA (owned + agent-on), merged + deduped. */
  discovered: DiscoveredPca[];
  /** `discovered` minus the locally-tracked set — the "discovered, not tracked" strip. */
  untracked: DiscoveredPca[];
  loading: boolean;
  refresh: () => void;
}

function basicsOf(m: MyPcaEntry): Partial<PcaSnapshot> {
  const { accountId: _id, relation: _rel, ...rest } = m;
  return rest;
}

function mergeRelation(a: DiscoveredPca['relation'], b: DiscoveredPca['relation']): DiscoveredPca['relation'] {
  if (a === b) return a;
  // owned + agent (in either order) → both; 'both' absorbs anything.
  return 'both';
}

/**
 * GAP-1 — discover the PCAs this node relates to, from two sources merged by accountId:
 *  - AGENT-ON: each node op wallet → `pcaAgentAccount` reverse lookup (works today, no
 *    new route) → relation 'agent' (+ the wallet, for the strip copy).
 *  - OWNED (+agent/both): `fetchMyPcas({hydrate:true})` (the GAP-1 enumeration route;
 *    degrades to [] until the route lands) → relation + snapshot basics.
 *
 * ★ AUTO-TRACK (#9-safe): a CONFIRMED agent-on discovery auto-adds its id to the tracked
 * set so `usePublishEligibility` resolves and a pure-edge node's publish chip self-heals
 * to GREEN with no manual step. Auto-track only makes the account RESOLVED — the verdict
 * still routes through `classifyCoverage` (registered ⇏ covered), so this never asserts a
 * discount; it only stops the false-fallthrough. (Owned discoveries are NOT auto-tracked —
 * they surface in the strip with a [Track] affordance for the operator to choose.)
 */
export function useDiscoveredPcas(): UseDiscoveredPcas {
  const trackedIds = usePcaStore((s) => s.trackedIds);
  const trackAccount = usePcaStore((s) => s.trackAccount);

  const { data, loading, refresh } = useFetch(
    async () => {
      // Agent-on via the per-wallet reverse lookup (no /api/pca/mine dependency).
      const wb = await fetchWalletsBalances().catch(() => null);
      const wallets = wb?.wallets ?? [];
      const agentPairs = (
        await Promise.all(
          wallets.map(async (w) => {
            const r = await pcaAgentAccount(w).catch(() => null);
            return r?.accountId ? { accountId: r.accountId, wallet: w } : null;
          }),
        )
      ).filter((p): p is { accountId: string; wallet: string } => p != null);
      // Owned (+agent/both) via the enumeration route — degrades to [] until it lands.
      const mine = await fetchMyPcas({ hydrate: true })
        .then((r) => r.accounts)
        .catch(() => [] as MyPcaEntry[]);
      return { agentPairs, mine };
    },
    [],
    0,
  );

  const discovered = useMemo<DiscoveredPca[]>(() => {
    const map = new Map<string, DiscoveredPca>();
    for (const m of data?.mine ?? []) {
      map.set(m.accountId, { accountId: m.accountId, relation: m.relation, basics: basicsOf(m) });
    }
    for (const p of data?.agentPairs ?? []) {
      const existing = map.get(p.accountId);
      if (existing) {
        existing.relation = mergeRelation(existing.relation, 'agent');
        if (!existing.agentWallet) existing.agentWallet = p.wallet;
      } else {
        map.set(p.accountId, { accountId: p.accountId, relation: 'agent', agentWallet: p.wallet });
      }
    }
    return [...map.values()];
  }, [data]);

  // ★ Auto-track confirmed agent-on (the edge self-heal). Idempotent: trackAccount skips
  // ids already present, and a freshly-tracked id is filtered next pass — no loop.
  useEffect(() => {
    for (const d of discovered) {
      if ((d.relation === 'agent' || d.relation === 'both') && !trackedIds.includes(d.accountId)) {
        trackAccount(d.accountId);
      }
    }
  }, [discovered, trackedIds, trackAccount]);

  const untracked = useMemo(
    () => discovered.filter((d) => !trackedIds.includes(d.accountId)),
    [discovered, trackedIds],
  );

  return { discovered, untracked, loading, refresh };
}
