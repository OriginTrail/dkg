import { create } from 'zustand';

export interface AgentInfo {
  name: string;
  peerId?: string;
  agentAddress?: string;
  agentDid?: string;
  framework?: string;
  status?: 'active' | 'idle' | 'offline';
}

interface AgentsState {
  agents: AgentInfo[];
  activeAgentName: string | null;
  nodeStatus: any | null;

  setAgents: (a: AgentInfo[]) => void;
  setActiveAgent: (name: string) => void;
  setNodeStatus: (s: any) => void;
}

export const useAgentsStore = create<AgentsState>((set) => ({
  agents: [],
  activeAgentName: null,
  nodeStatus: null,

  setAgents: (a) => set({ agents: a }),
  setActiveAgent: (name) => set({ activeAgentName: name }),
  setNodeStatus: (s) => set({ nodeStatus: s }),
}));
