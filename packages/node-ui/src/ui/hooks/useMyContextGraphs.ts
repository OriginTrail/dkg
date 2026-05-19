import { useCallback, useEffect, useMemo, useState } from 'react';
import { useProjectsStore, type ContextGraph } from '../stores/projects.js';
import { api } from '../api-wrapper.js';
import {
  belongsInMyProjectsSidebar,
  toSidebarIdentity,
  type AgentSidebarIdentity,
} from '../lib/contextGraphSidebar.js';
import { useHiddenContextGraphIds } from './useHiddenContextGraphIds.js';
import { useNodeEvents } from './useNodeEvents.js';

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
  const setContextGraphs = useProjectsStore((s) => s.setContextGraphs);
  const { hidden } = useHiddenContextGraphIds();
  const [identity, setIdentity] = useState<AgentSidebarIdentity | null>(null);
  const [identityLoading, setIdentityLoading] = useState(true);

  // Hydrate the context-graph store ourselves rather than relying on
  // PanelLeft.loadCGs() as a side effect: PanelLeft is unmounted when
  // the left sidebar is collapsed, so a reload with a persisted
  // collapsed sidebar would otherwise leave the dashboard showing 0
  // graphs forever (Codex). Idempotent with PanelLeft's own loader
  // (setContextGraphs just replaces); same 60s + node-event cadence.
  const loadCGs = useCallback(() => {
    api.fetchContextGraphs()
      .then(({ contextGraphs: cgs }: any) => setContextGraphs(cgs ?? []))
      .catch(() => { /* keep last list; PanelLeft/next tick may recover */ });
  }, [setContextGraphs]);

  useEffect(() => {
    loadCGs();
    const iv = setInterval(loadCGs, 60_000);
    return () => clearInterval(iv);
  }, [loadCGs]);
  useNodeEvents(loadCGs);

  // Re-fetch identity whenever the context-graph list changes — the
  // sidebar refreshes identity alongside each CG reload, so a one-shot
  // fetch here would permanently diverge if it failed at startup or the
  // active agent later changed, breaking the parity invariant. Reset
  // identity + loading BEFORE the request and clear it on failure, so a
  // stale DID from a prior agent/node can't be used to compute
  // membership after a switch — membership then falls back to
  // `callerInvolved` instead of stale identity (Codex).
  useEffect(() => {
    let mounted = true;
    setIdentity(null);
    setIdentityLoading(true);
    api.fetchCurrentAgent()
      .then((a) => { if (mounted) setIdentity(toSidebarIdentity(a)); })
      .catch(() => { if (mounted) setIdentity(null); })
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
