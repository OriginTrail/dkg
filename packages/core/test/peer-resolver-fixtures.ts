import {
  type PeerConnectionNetwork,
  type AgentDirectoryLookup,
  type Address,
  type NodeIdentity,
} from '../src/network/index.js';

export const PEER_A = '12D3KooWA' + 'a'.repeat(43);
export const PEER_B = '12D3KooWB' + 'b'.repeat(43);
export const RELAY_PEER_ID = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
export const RELAY_ADDR =
  `/ip4/178.104.54.178/tcp/9090/p2p/${RELAY_PEER_ID}`;
export const TARGET_PEER_ID = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';

export type FindPeerImpl = (
  peerId: NodeIdentity,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<Address[]>;

export interface MockNetwork extends PeerConnectionNetwork {
  __conns: Map<NodeIdentity, Array<{ remoteAddr: { toString(): string } }>>;
  __addedAddresses: Array<{ peerId: NodeIdentity; addrs: Address[] }>;
  __findPeerImpl: FindPeerImpl | null;
  __connectCalls: Array<{ peerId: NodeIdentity; addrs: readonly Address[] }>;
}

export function makeNetwork(): MockNetwork {
  const conns = new Map<NodeIdentity, Array<{ remoteAddr: { toString(): string } }>>();
  const added: Array<{ peerId: NodeIdentity; addrs: Address[] }> = [];
  const connectCalls: Array<{ peerId: NodeIdentity; addrs: readonly Address[] }> = [];
  let findPeerImpl: FindPeerImpl | null = null;
  const net: Partial<MockNetwork> = {
    localId: PEER_A,
    localAddresses: [],
    isStarted: true,
    async start() {},
    async stop() {},
    async dialProtocol() {
      throw new Error('not used in resolver tests');
    },
    async connectPeer(peerId: NodeIdentity, addrs: readonly Address[]) {
      connectCalls.push({ peerId, addrs });
    },
    async handle() {},
    async unhandle() {},
    getConnections(peerId: NodeIdentity) {
      return (conns.get(peerId) ?? []) as never;
    },
    async addKnownAddresses(peerId: NodeIdentity, addrs: Address[]) {
      added.push({ peerId, addrs });
    },
    async findPeer(peerId: NodeIdentity, opts?: { signal?: AbortSignal; timeoutMs?: number }) {
      if (!findPeerImpl) throw new Error('findPeer not configured');
      return findPeerImpl(peerId, opts);
    },
  };
  Object.defineProperty(net, '__conns', { value: conns, enumerable: false });
  Object.defineProperty(net, '__addedAddresses', { value: added, enumerable: false });
  Object.defineProperty(net, '__connectCalls', { value: connectCalls, enumerable: false });
  Object.defineProperty(net, '__findPeerImpl', {
    get: () => findPeerImpl,
    set: (v) => {
      findPeerImpl = v;
    },
    enumerable: false,
  });
  return net as MockNetwork;
}

export function makeAgentDir(
  fn?: (peerId: NodeIdentity) => Promise<Address | null>,
): AgentDirectoryLookup {
  return { findRelayForPeer: fn ?? (async () => null) };
}
