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
   * Used to distinguish active subscriptions from catalogue-only graphs learned
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
  inventoryLoaded: boolean;
  inventoryError: string | null;
  activeProjectId: string | null;

  setActiveProject: (id: string | null) => void;
}

export const useProjectsStore = create<ProjectsState>((set) => ({
  contextGraphs: [],
  loading: false,
  inventoryLoaded: false,
  inventoryError: null,
  activeProjectId: null,

  setActiveProject: (id) => set({ activeProjectId: id }),
}));
