export type {
  Network,
  NodeIdentity,
  Address,
  DialOpts,
  ProtocolHandler,
} from './network.js';

export { LibP2PNetwork } from './libp2p-network.js';

export type { NetworkStateRegistry } from './network-state-registry.js';
export { StubNetworkStateRegistry } from './network-state-registry.js';

export type {
  AgentDirectoryLookup,
  PeerResolverDeps,
  PeerResolverLogger,
  ResolveOpts,
} from './peer-resolver.js';
export { PeerResolver } from './peer-resolver.js';

export type { DkgGossipMsgIdInput } from './gossip-msg-id.js';
export {
  dkgGossipMsgId,
  dkgGossipMsgIdRaw,
  DkgGossipUnsignedMessageError,
  DkgGossipMissingPublisherError,
} from './gossip-msg-id.js';
