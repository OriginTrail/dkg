import { create } from 'zustand';

export interface ContextGraph {
  id: string;
  name: string;
  /** Peer DID from `DKG_CREATOR` — hosting node identifier. */
  creator?: string;
  /** Wallet curator DID when present (from ontology / `_meta`). */
  curator?: string;
  /** `public` / `private` (from ontology / `_meta`). */
  accessPolicy?: string;
  /** This node maintains an active sync subscription for this graph. */
  subscribed?: boolean;
  /**
   * Daemon-computed: at least one peer-served catchup landed real triples in
   * the local store for this CG. Distinct from `subscribed`: a CG can be
   * subscribed but never synced (no peer holds the data), and conversely a CG
   * can be synced but no longer subscribed (we caught up once and unsubscribed).
   * Used by the Context Oracle sidebar to hide stale entries the daemon learned
   * about via gossip but never actually interacted with.
   */
  synced?: boolean;
  /** Daemon-computed: bearer agent is curator or on the participant / allowlist for this CG. */
  callerInvolved?: boolean;
  description?: string;
  assetCount?: number;
  assets?: number;
  agentCount?: number;
  agents?: number;
}

interface ProjectsState {
  contextGraphs: ContextGraph[];
  loading: boolean;
  activeProjectId: string | null;

  setContextGraphs: (cgs: ContextGraph[]) => void;
  setLoading: (v: boolean) => void;
  setActiveProject: (id: string | null) => void;
}

export const useProjectsStore = create<ProjectsState>((set) => ({
  contextGraphs: [],
  loading: false,
  activeProjectId: null,

  setContextGraphs: (cgs) => set({ contextGraphs: cgs }),
  setLoading: (v) => set({ loading: v }),
  setActiveProject: (id) => set({ activeProjectId: id }),
}));
