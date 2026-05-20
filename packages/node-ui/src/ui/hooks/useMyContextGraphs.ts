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
  /** True until the FIRST context-graph list fetch has settled. The
   *  store may already be hydrated by PanelLeft (so contextGraphs.length
   *  > 0 immediately), in which case this flips false right away. */
  cgsLoading: boolean;
} {
  const contextGraphs = useProjectsStore((s) => s.contextGraphs);
  const setContextGraphs = useProjectsStore((s) => s.setContextGraphs);
  const { hidden } = useHiddenContextGraphIds();
  const [identity, setIdentity] = useState<AgentSidebarIdentity | null>(null);
  const [identityLoading, setIdentityLoading] = useState(true);
  // Initial CG-list-loading flag — distinct from identity. On a cold
  // load `fetchCurrentAgent` can settle before `fetchContextGraphs`,
  // which previously made the dashboard briefly render "No context
  // graphs yet" even though graphs exist; consumers can now wait for
  // BOTH before showing the empty state (Codex).
  const [cgsLoading, setCgsLoading] = useState(() => contextGraphs.length === 0);

  // Hydrate the context-graph store ourselves rather than relying on
  // PanelLeft.loadCGs() as a side effect: PanelLeft is unmounted when
  // the left sidebar is collapsed, so a reload with a persisted
  // collapsed sidebar would otherwise leave the dashboard showing 0
  // graphs forever (Codex). Idempotent with PanelLeft's own loader
  // (setContextGraphs just replaces); same 60s + node-event cadence.
  const loadCGs = useCallback(() => {
    api.fetchContextGraphs()
      .then(({ contextGraphs: cgs }: any) => setContextGraphs(cgs ?? []))
      .catch(() => { /* keep last list; PanelLeft/next tick may recover */ })
      // Settle the initial-load flag whether the fetch succeeded or
      // failed — after this we know the list is either populated or
      // really empty, not "still pending".
      .finally(() => setCgsLoading(false));
  }, [setContextGraphs]);

  useEffect(() => {
    loadCGs();
    const iv = setInterval(loadCGs, 60_000);
    return () => clearInterval(iv);
  }, [loadCGs]);
  // Refresh the CG list only on membership-changing events, not on
  // every SSE message — high-volume `memory_graph_changed` traffic
  // would otherwise refetch the list + identity continuously while the
  // dashboard is open (mirrors PanelLeft's filtering) (Codex).
  useNodeEvents(useCallback((event) => {
    if (event.type !== 'join_approved' && event.type !== 'join_rejected' && event.type !== 'project_synced') return;
    loadCGs();
  }, [loadCGs]));

  // Re-fetch identity whenever the context-graph list changes so the
  // dashboard tracks agent/node switches. Keep the previous identity
  // until a replacement fetch SUCCEEDS — do not clear it eagerly or on
  // failure: a transient `/api/agent/identity` blip (or the brief
  // window each reload) must not drop every graph for older daemons
  // that rely on the curator-DID fallback. A real agent/node change
  // resolves successfully and replaces the identity (Codex).
  useEffect(() => {
    let mounted = true;
    // Flip identityLoading TRUE at the start of every refetch so
    // consumers (e.g. the dashboard's curator/joined split) can mark
    // role-dependent UI as in-flight after a node/agent switch instead
    // of asserting the stale value with confidence (Codex). We still
    // do NOT setIdentity(null) here — keeping the previous identity
    // visible during the in-flight window avoids the round-12
    // regression where a transient blip emptied the dashboard.
    setIdentityLoading(true);
    api.fetchCurrentAgent()
      .then((a) => { if (mounted) setIdentity(toSidebarIdentity(a)); })
      .catch(() => { /* keep last good identity (see above) */ })
      .finally(() => { if (mounted) setIdentityLoading(false); });
    return () => { mounted = false; };
  }, [contextGraphs]);

  const myCgs = useMemo(
    () => contextGraphs
      .filter((cg) => !hidden.has(cg.id))
      .filter((cg) => belongsInMyProjectsSidebar(cg, identity)),
    [contextGraphs, hidden, identity],
  );

  return { myCgs, identity, identityLoading, cgsLoading };
}
