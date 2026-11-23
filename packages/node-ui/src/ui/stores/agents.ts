import { create } from 'zustand';
import type { NodeStatus } from '../api.js';

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
  nodeStatus: NodeStatus | null;
  /** Failed status checks in a row; a good status clears it. */
  nodeStatusFailures: number;

  setAgents: (a: AgentInfo[]) => void;
  setActiveAgent: (name: string) => void;
  setNodeStatus: (s: NodeStatus) => void;
  recordNodeStatusFailure: () => void;
  clearNodeStatusFailures: () => void;
}

export const useAgentsStore = create<AgentsState>((set) => ({
  agents: [],
  activeAgentName: null,
  nodeStatus: null,
  nodeStatusFailures: 0,

  setAgents: (a) => set({ agents: a }),
  setActiveAgent: (name) => set({ activeAgentName: name }),
  setNodeStatus: (s) => set({ nodeStatus: s, nodeStatusFailures: 0 }),
  recordNodeStatusFailure: () => set((state) => ({ nodeStatusFailures: state.nodeStatusFailures + 1 })),
  clearNodeStatusFailures: () => set({ nodeStatusFailures: 0 }),
}));
