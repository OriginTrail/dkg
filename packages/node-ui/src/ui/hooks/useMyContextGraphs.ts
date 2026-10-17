import { useCallback, useMemo } from 'react';
import type { ContextGraph } from '../stores/projects.js';
import { belongsInMyProjectsSidebar, toSidebarIdentity, type AgentSidebarIdentity } from '../lib/contextGraphSidebar.js';
import { useHiddenContextGraphIds } from './useHiddenContextGraphIds.js';
import { useCurrentAgent } from './useCurrentAgent.js';
import { useContextGraphInventory, refreshContextGraphInventory, type InventoryResult } from './useContextGraphInventory.js';

/**
 * The user's "My Context Graphs" set — the EXACT same membership the
 * left sidebar shows: store list, minus hidden, filtered by
 * `belongsInMyProjectsSidebar`. The dashboard count must equal the
 * sidebar count, so this reuses the identical predicate + the shared
 * hidden-ids hook rather than re-deriving the set.
 */
export function useMyContextGraphs(): {
  myCgs: ContextGraph[];
  identity: AgentSidebarIdentity | null;
  /** True until the agent identity request has resolved (or failed). */
  identityLoading: boolean;
  /** True while the current list request is pending; previous graphs remain visible. */
  cgsLoading: boolean;
  cgsError: string | null;
  identityError: string | null;
  retry: () => Promise<InventoryResult>;
} {
  const { contextGraphs, loading: cgsLoading, error: cgsError } = useContextGraphInventory();
  const { hidden } = useHiddenContextGraphIds();
  const currentAgent = useCurrentAgent();
  const identity = useMemo(() => currentAgent.data ? toSidebarIdentity(currentAgent.data) : null, [currentAgent.data]);
  const retry = useCallback(() => refreshContextGraphInventory(true), []);

  const myCgs = useMemo(
    () => contextGraphs
      .filter((cg) => !hidden.has(cg.id))
      .filter((cg) => belongsInMyProjectsSidebar(cg, identity)),
    [contextGraphs, hidden, identity],
  );

  return { myCgs, identity, identityLoading: currentAgent.loading, cgsLoading, cgsError, identityError: currentAgent.error, retry };
}
