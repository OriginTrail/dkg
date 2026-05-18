import { useEffect, useMemo, useState } from 'react';
import { useProjectsStore, type ContextGraph } from '../stores/projects.js';
import { fetchCurrentAgent } from '../api.js';
import {
  belongsInMyProjectsSidebar,
  toSidebarIdentity,
  type AgentSidebarIdentity,
} from '../lib/contextGraphSidebar.js';
import { useHiddenContextGraphIds } from './useHiddenContextGraphIds.js';

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
} {
  const contextGraphs = useProjectsStore((s) => s.contextGraphs);
  const { hidden } = useHiddenContextGraphIds();
  const [identity, setIdentity] = useState<AgentSidebarIdentity | null>(null);
  const [identityLoading, setIdentityLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    fetchCurrentAgent()
      .then((a) => { if (mounted) setIdentity(toSidebarIdentity(a)); })
      .catch(() => { /* membership falls back to callerInvolved flags */ })
      .finally(() => { if (mounted) setIdentityLoading(false); });
    return () => { mounted = false; };
  }, []);

  const myCgs = useMemo(
    () => contextGraphs
      .filter((cg) => !hidden.has(cg.id))
      .filter((cg) => belongsInMyProjectsSidebar(cg, identity)),
    [contextGraphs, hidden, identity],
  );

  return { myCgs, identity, identityLoading };
}
