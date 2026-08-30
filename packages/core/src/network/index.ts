export type {
  Network,
  PeerConnectionNetwork,
  NodeIdentity,
  Address,
  DialOpts,
  PeerConnectOpts,
  ProtocolHandler,
} from './network.js';
export { PeerConnectionUnresolvedError } from './network.js';

export { LibP2PNetwork } from './libp2p-network.js';
export {
  canonicalPeerIdString,
  tryCanonicalPeerIdString,
  type CanonicalPeerId,
} from './peer-id.js';

export type { NetworkStateRegistry } from './network-state-registry.js';
export { StubNetworkStateRegistry } from './network-state-registry.js';

export type {
  AgentDirectoryLookup,
  AgentDirectoryDialAddresses,
  PeerResolverDeps,
  PeerResolverLogger,
  ResolveOpts,
  ConnectOpts,
  PeerConnectionOutcome,
} from './peer-resolver.js';
export { PeerResolver } from './peer-resolver.js';
export {
  connectLibp2pCandidate,
  parseLibp2pConnectCandidate,
  Libp2pConnectCandidateParseError,
  type Libp2pConnectCandidate,
  type Libp2pConnectHost,
} from './libp2p-peer-connect.js';
export type { ConfiguredRelayTarget } from './relay-target.js';

export type { DkgGossipMsgIdInput } from './gossip-msg-id.js';
export {
  dkgGossipMsgId,
  dkgGossipMsgIdRaw,
  DkgGossipUnsignedMessageError,
  DkgGossipMissingPublisherError,
} from './gossip-msg-id.js';
