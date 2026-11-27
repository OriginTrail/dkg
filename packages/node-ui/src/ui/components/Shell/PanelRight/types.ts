export type { LocalAgentAttachmentDraft, LocalAgentAttachmentStatus, LocalAgentMessage } from '../../../conversations/types.js';

export interface AgentInfo {
  agentUri: string;
  name: string;
  peerId: string;
  framework?: string;
  nodeRole?: string;
  connectionStatus?: string;
  connectionTransport?: string;
  connectionDirection?: string;
  lastSeen?: number;
  latencyMs?: number;
}

// One row from `/api/connections.connections` — a single libp2p
// connection. A peer can appear multiple times when reachable via both
// a direct and a relay transport simultaneously; `buildPeers` collapses
// those to one card per peerId.
export interface ConnectionRow {
  peerId: string;
  remoteAddr?: string;
  transport: 'direct' | 'relayed';
  direction?: string;
  openedAt?: number | null;
  durationMs?: number | null;
}

// Peer-axis model for the Network tab. One per libp2p peerId. Agents
// hosted by the peer (0..N) attach as a list and surface inside the
// card as chips. `name` is the peer's (node's) name — same value across
// every agent on this peer — sampled from any one of them since the
// `/api/connections` endpoint doesn't expose it.
export interface PeerInfo {
  peerId: string;
  name?: string;
  transport: 'direct' | 'relayed';
  hasDirect: boolean;
  hasRelay: boolean;
  openedAt: number | null;
  connected: boolean;
  lastSeen?: number;
  agents: AgentInfo[];
}

export interface LocalAgentSessionSummary {
  sessionId: string;
  integrationId: string;
  integrationName: string;
  preview: string;
  messageCount: number;
  lastTs?: string;
}
