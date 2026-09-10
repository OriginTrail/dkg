import { DiscoveryClient, type AgentPeerDiscovery, type AgentPeerPageRequest } from '../src/index.js';

declare const discovery: DiscoveryClient;
const required: AgentPeerDiscovery = discovery;
const provider: AgentPeerDiscovery = {
  findAgentPeerIdsByAddress: async (_wallet, request) => ({
    peerIds: request.afterPeerId ? [] : ['peer-001'], nextAfterPeerId: null,
  }),
};
void required; void provider;
// @ts-expect-error Bounded discovery always requires a page size.
void discovery.findAgentPeerIdsByAddress('wallet');
// @ts-expect-error An optional limit does not satisfy the required page contract.
const unbounded: AgentPeerPageRequest = { afterPeerId: 'peer-001' };
// @ts-expect-error A rich-profile lookup alone cannot satisfy bounded peer discovery.
const legacy: AgentPeerDiscovery = { findAgents: async () => [] };
// @ts-expect-error Pages carry an explicit end/continuation signal, not only peer IDs.
const ambiguous: AgentPeerDiscovery = { findAgentPeerIdsByAddress: async () => ['peer-001'] };
void unbounded; void legacy; void ambiguous;
