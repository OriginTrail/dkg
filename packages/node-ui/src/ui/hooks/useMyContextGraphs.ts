import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  /** True while the current list request is pending; previous graphs remain visible. */
  cgsLoading: boolean;
  cgsError: string | null;
  identityError: string | null;
  retry: () => Promise<void>;
} {
  const contextGraphs = useProjectsStore((s) => s.contextGraphs);
  const setContextGraphs = useProjectsStore((s) => s.setContextGraphs);
  const { hidden } = useHiddenContextGraphIds();
  const [identity, setIdentity] = useState<AgentSidebarIdentity | null>(null);
  const [identityLoading, setIdentityLoading] = useState(true);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [identityRetry, setIdentityRetry] = useState(0);
  const [cgsError, setCgsError] = useState<string | null>(null);
  const mounted = useRef(false), listRequest = useRef(0);
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
  const loadCGs = useCallback(async (): Promise<boolean> => {
    const request = ++listRequest.current;
    setCgsLoading(true);
    try {
      const { contextGraphs: cgs } = await api.fetchContextGraphs();
      if (!Array.isArray(cgs)) throw new Error('Invalid context graph list response');
      if (!mounted.current || request !== listRequest.current) return false;
      setContextGraphs(cgs);
      setCgsError(null);
      return true;
    } catch (error) {
      if (mounted.current && request === listRequest.current) {
        setCgsError(error instanceof Error ? error.message : String(error));
      }
      return false; // Keep the last successful list, without claiming it is current.
    } finally {
      if (mounted.current && request === listRequest.current) setCgsLoading(false);
    }
  }, [setContextGraphs]);

  useEffect(() => {
    mounted.current = true;
    void loadCGs();
    const iv = setInterval(() => { void loadCGs(); }, 60_000);
    return () => { mounted.current = false; listRequest.current++; clearInterval(iv); };
  }, [loadCGs]);
  const retry = useCallback(async () => {
    await loadCGs();
    // The list cache may return the same array, which does not re-run the
    // identity effect. Retry that endpoint even when the list already succeeded.
    if (mounted.current) setIdentityRetry(value => value + 1);
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
      .then((a) => { if (mounted) { setIdentity(toSidebarIdentity(a)); setIdentityError(null); } })
      .catch((error) => { if (mounted) setIdentityError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (mounted) setIdentityLoading(false); });
    return () => { mounted = false; };
  }, [contextGraphs, identityRetry]);

  const myCgs = useMemo(
    () => contextGraphs
      .filter((cg) => !hidden.has(cg.id))
      .filter((cg) => belongsInMyProjectsSidebar(cg, identity)),
    [contextGraphs, hidden, identity],
  );

  return { myCgs, identity, identityLoading, cgsLoading, cgsError, identityError, retry };
}
