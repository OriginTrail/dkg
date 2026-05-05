import { create } from 'zustand';

export interface ContextGraph {
  id: string;
  name: string;
  /** Agent DID (`did:dkg:agent:…`) — from daemon list; drives My vs Context Oracle when set. */
  creator?: string;
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
