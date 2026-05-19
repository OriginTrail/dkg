import { useEffect, useMemo, useState } from 'react';
import { useProjectsStore, type ContextGraph } from '../stores/projects.js';
import { api } from '../api-wrapper.js';
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

  // Re-fetch identity whenever the context-graph list changes — the
  // sidebar refreshes identity alongside each CG reload (PanelLeft
  // loadCGs), so a one-shot fetch here would permanently diverge from
  // the sidebar if it failed at startup or the active agent later
  // changed, breaking the parity invariant this hook guarantees
  // (Codex). The store array reference changes on each reload, giving
  // us the same cadence; fetchCurrentAgent is a cheap GET.
  useEffect(() => {
    let mounted = true;
    api.fetchCurrentAgent()
      .then((a) => { if (mounted) setIdentity(toSidebarIdentity(a)); })
      .catch(() => { /* membership falls back to callerInvolved flags */ })
      .finally(() => { if (mounted) setIdentityLoading(false); });
    return () => { mounted = false; };
  }, [contextGraphs]);

  const myCgs = useMemo(
    () => contextGraphs
      .filter((cg) => !hidden.has(cg.id))
      .filter((cg) => belongsInMyProjectsSidebar(cg, identity)),
    [contextGraphs, hidden, identity],
  );

  return { myCgs, identity, identityLoading };
}
