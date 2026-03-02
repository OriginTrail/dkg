export interface NodeStatus {
  name: string;
  peerId: string;
  nodeRole: 'core' | 'edge';
  networkId?: string;
  storeBackend?: string;
  uptimeMs: number;
  connectedPeers: number;
  connections: number;
  relayConnected: boolean;
  multiaddrs: string[];
}

export interface DevnetNode {
  id: number;
  name: string;
  apiPort: number;
  listenPort: number;
  nodeRole: 'core' | 'edge';
  online: boolean;
  status: NodeStatus | null;
  walletAddress?: string;
}

export interface DevnetConfig {
  nodes: Array<{
    id: number;
    name: string;
    apiPort: number;
    listenPort: number;
    nodeRole: string;
    wallets?: { wallets: Array<{ privateKey: string; address: string }> };
  }>;
  contracts: Record<string, string>;
  hubAddress: string;
  chainRpc: string;
  network?: 'devnet' | 'testnet';
}

export type OperationType =
  | 'publish'
  | 'workspace'
  | 'query'
  | 'chat'
  | 'access'
  | 'stake'
  | 'fairswap'
  | 'conviction'
  | 'connect';

export interface Activity {
  id: string;
  ts: number;
  type: OperationType;
  sourceNode: number;
  targetNode?: number;
  label: string;
  detail?: string;
  status: 'pending' | 'success' | 'error';
}

export interface GraphAnimation {
  id: string;
  from: number;
  to: number;
  type: OperationType;
  progress: number;
  speed: number;
}

export const OP_COLORS: Record<OperationType, string> = {
  publish: '#10b981',
  workspace: '#f97316',
  query: '#3b82f6',
  chat: '#06b6d4',
  access: '#f59e0b',
  stake: '#8b5cf6',
  fairswap: '#ec4899',
  conviction: '#e2e8f0',
  connect: '#6366f1',
};
