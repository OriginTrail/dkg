# @origintrail-official/dkg-agent

Agent runtime for DKG V10. Provides the `DKGAgent` class — the primary entry point for building agents that participate in the decentralized knowledge network.

## Features

- **DKGAgent** — unified agent class that wires together a DKG node, storage, publishing, querying, and chain interaction
- **Wallet management** — `DKGAgentWallet` for Ed25519 (P2P identity) and ECDSA (on-chain signing) key pairs, with persistent key storage and operational wallet support
- **Agent profiles** — `ProfileManager` for publishing and updating agent skill profiles to the agent registry contextGraph
- **Discovery** — `DiscoveryClient` for finding other agents by name, skill keywords, or semantic search over published profiles
- **Signed shared memory gossip** — SWM writes are wrapped in a signed gossip envelope when a local agent key is available, and agent-gated context graphs require a local `DKG_ALLOWED_AGENT` or `DKG_PARTICIPANT_AGENT` signing key before broadcasting; signatures authenticate writers, but do not encrypt GossipSub payload bytes
- **Encrypted messaging** — Ed25519-to-X25519 key conversion, ECDH shared secrets, and encrypted P2P message channels
- **Skill invocation** — `MessageHandler` for receiving and responding to skill requests; `SkillHandler` and `ChatHandler` for registering custom capabilities

## Usage

```typescript
import { DKGAgent } from '@origintrail-official/dkg-agent';

const agent = await DKGAgent.create({
  name: 'my-agent',
  dataDir: './data',
  relayPeers: ['/dns4/relay.origintrail.io/tcp/9000/...'],
  chainConfig: {
    rpcUrl: 'https://sepolia.base.org',
    hubAddress: '0x...',
    adminPrivateKey: '0xadminPrivateKey',
    operationalKeys: ['0xprivateKey1'],
  },
});

await agent.start();

// Publish Knowledge Assets (positional args)
const result = await agent.publish('urn:contextGraph:example', quads, privateQuads);

// Query the knowledge graph
const { bindings } = await agent.query(
  'SELECT ?s ?name WHERE { ?s <urn:name> ?name }',
  { contextGraphId: 'urn:contextGraph:example' },
);

// Discover agents and skills
const agents = await agent.findAgents();
const skills = await agent.findSkills({ skillType: 'sentiment-analysis' });
```

## Publishing a finalized assertion

The SDK methods `publishFromFinalizedAssertion`, `resolveFinalizedAssertionVmPublishIntent`,
and `resolveFinalizedAssertionPublishAuthor` share `PublishAuthorSelection`. Put identity
options inside `authorSelection`; migrate `{ agentAddress: author }` to
`{ authorSelection: { mode: 'author', agentAddress: author } }`.

```typescript
await agent.publishFromFinalizedAssertion(contextGraphId, name, {
  authorSelection: { mode: 'author', agentAddress: author },
});

const intent = await agent.resolveFinalizedAssertionVmPublishIntent(contextGraphId, name, {
  authorSelection: {
    mode: 'residentAuthor',
    selectedAuthorAgentAddress: member,
    callerAgentAddress: curator,
  },
});
```

`author` uses the named author directly. `callerHint` accepts a `callerAgentAddress`
and resolves the author from stored metadata. `residentAuthor` requires the chosen
author to exist at that coordinate and preserves the optional caller hint for curator
stamping. Omit `authorSelection` to resolve with the node identity as the hint.
The released flat `agentAddress`, `callerAgentAddress`, and `selectedAuthorAgentAddress`
options remain supported and are deprecated in favor of the nested form. Flat options
normalize to the corresponding mode, including resident selection with an optional
caller hint. Contradictory selections and mixing populated flat fields with
`authorSelection` are rejected before author lookup. HTTP clients continue to send
`selectedAuthorAgentAddress`; the daemon constructs the SDK selection.

## Bounded peer discovery

`DiscoveryClient.findAgentPeerPageByAddress(wallet, { limit, afterPeerId?, signal? })`
requires an integer limit from 1 to `MAX_AGENT_PEER_PAGE_SIZE` (1,024). It returns
`{ peerIds, nextAfterPeerId }`: peer IDs are unique and ordered, the cursor is
exclusive, and a null continuation means the query found no further row. The
query retains at most `limit + 1` rows and does not select optional profile fields.
The existing `findAgentPeerIdsByAddress(wallet, options?)` remains available as a
deprecated array-returning facade. It walks bounded pages internally, retaining
the full result only for callers explicitly using that legacy API.

Bounded recovery providers must implement the exported `AgentPeerDiscovery`
contract. Providers that cannot paginate must reject the lookup; bounded recovery
reports `lookupFailed` and never substitutes `findAgents()`. This also applies to
registry discovery during its metadata-refresh fallback. Legacy single-curator
metadata resolution and callers explicitly using the rich profile API retain
their existing behavior.

A page walk is not a snapshot of a changing registry. Recovery treats tail pages
as incomplete roster evidence even when a tail page has no continuation. Only a
fresh first-page query covering the entire bounded roster can support its existing
absence-proof checks. These local peer IDs do not themselves establish curator
authority.

## Internal Dependencies

- `@origintrail-official/dkg-core` — P2P node, crypto, event bus
- `@origintrail-official/dkg-chain` — blockchain interaction
- `@origintrail-official/dkg-publisher` — publishing Knowledge Assets
- `@origintrail-official/dkg-query` — querying the knowledge graph
- `@origintrail-official/dkg-storage` — local triple store
