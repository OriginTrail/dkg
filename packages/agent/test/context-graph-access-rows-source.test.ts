import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  encodePublishRequest,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';
import { signAgentDelegation } from '../src/auth/agent-delegation.js';
import { buildAgentProfile } from '../src/profile.js';

/**
 * A context graph's access list comes from the graph's own metadata, on a real
 * agent over a real store. Only the chain is a mock, and a gossip message enters
 * at the handler the topic subscription calls.
 */

const AGENTS_GRAPH = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
const ONTOLOGY_GRAPH = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
const OTHER_PEER = '12D3KooWRdP3mMN9KkQCWKFjFxhgpXp8Q2y8zQZkgRYfGQ4bQh3a';
const REMOTE_PEER = '12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo';

interface Internals {
  peerId: string;
  defaultAgentAddress: string;
  getOrCreateGossipPublishHandler(): {
    handlePublishMessage(data: Uint8Array, contextGraphId: string, onPhase: undefined, fromPeerId: string): Promise<void>;
  };
  computeSyncDigest(...args: unknown[]): Uint8Array;
  authorizeSyncRequest(request: unknown, remotePeerId: string): Promise<boolean>;
  insertSyncedQuadsAndInvalidateListCache(quads: Quad[]): Promise<void>;
  getCgMeta(id: string): Promise<{ allowedAgents: string[]; allowedPeers: string[]; revokedAgents: string[] }>;
  getContextGraphParticipantAgentAddresses(id: string): Promise<string[]>;
  isPrivateContextGraph(id: string): Promise<boolean>;
}

type Row = Pick<Quad, 'subject' | 'predicate' | 'object'>;

function quadLine(quad: Row): string {
  const object = quad.object.startsWith('"') ? quad.object : `<${quad.object}>`;
  return `<${quad.subject}> <${quad.predicate}> ${object} .`;
}

function gossipMessage(contextGraphId: string, rows: readonly Row[]): Uint8Array {
  return encodePublishRequest({
    ual: '',
    nquads: new TextEncoder().encode(rows.map(quadLine).join('\n')),
    contextGraphId,
    kas: [],
    publisherIdentity: new Uint8Array(32),
    publisherAddress: '0x1111111111111111111111111111111111111111',
    startKAId: 0,
    endKAId: 0,
    chainId: 'mock:31337',
    publisherSignatureR: new Uint8Array(0),
    publisherSignatureVs: new Uint8Array(0),
  });
}

async function signedSyncRequest(
  node: Internals,
  signer: ethers.HDNodeWallet,
  contextGraphId: string,
  options: { identityId?: bigint; claimedAgent?: string } = {},
) {
  const request = {
    contextGraphId,
    offset: 0,
    limit: 100,
    includeSharedMemory: false,
    targetPeerId: node.peerId,
    requesterPeerId: REMOTE_PEER,
    requestId: ethers.hexlify(ethers.randomBytes(12)),
    issuedAtMs: Date.now(),
    requesterIdentityId: (options.identityId ?? 0n).toString(),
    requesterAgentAddress: options.claimedAgent ?? signer.address,
  };
  const digest = node.computeSyncDigest(
    request.contextGraphId,
    request.offset,
    request.limit,
    request.includeSharedMemory,
    request.targetPeerId,
    request.requesterPeerId,
    request.requestId,
    request.issuedAtMs,
    request.requesterAgentAddress,
  );
  const signature = ethers.Signature.from(await signer.signMessage(digest));
  return { ...request, requesterSignatureR: signature.r, requesterSignatureVS: signature.yParityAndS };
}

describe('a context graph access list comes from its own metadata', () => {
  const agents: DKGAgent[] = [];

  afterEach(async () => {
    await Promise.all(agents.splice(0).map((agent) => agent.stop().catch(() => {})));
  });

  // `store` is the agent's own, whose writes reach its metadata projection as a node's do.
  async function startNode(): Promise<{ agent: DKGAgent; node: Internals; store: TripleStore; chainAdapter: MockChainAdapter }> {
    const owner = ethers.Wallet.createRandom();
    const chainAdapter = new MockChainAdapter('mock:31337', owner.address);
    const agent = await DKGAgent.create({
      name: 'AccessRowsNode',
      listenPort: 0,
      listenHost: '127.0.0.1',
      store: new OxigraphStore(),
      chainAdapter,
      chainConfig: { operationalKeys: [owner.privateKey] } as never,
      nodeRole: 'core',
      skills: [],
    });
    agents.push(agent);
    await agent.start();
    return { agent, node: agent as unknown as Internals, store: (agent as unknown as { store: TripleStore }).store, chainAdapter };
  }

  const authorized = async (
    node: Internals,
    signer: ethers.HDNodeWallet,
    id: string,
    options?: Parameters<typeof signedSyncRequest>[3],
  ): Promise<boolean> => node.authorizeSyncRequest(await signedSyncRequest(node, signer, id, options), REMOTE_PEER);

  const accessRow = (id: string, predicate: string, value: string, graph: string): Quad => (
    { subject: contextGraphDataGraphUri(id), predicate, object: `"${value}"`, graph }
  );

  /** Every row that could admit `wallet` and this test's remote peer, in `graph`. */
  const admittingRows = (id: string, wallet: string, graph: string): Quad[] => [
    accessRow(id, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, wallet, graph),
    accessRow(id, DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT, wallet, graph),
    accessRow(id, DKG_ONTOLOGY.DKG_ALLOWED_PEER, REMOTE_PEER, graph),
  ];

  async function gossipAccessRows(node: Internals, id: string, wallet: string, opts: { peerRow?: boolean } = {}): Promise<void> {
    const subject = contextGraphDataGraphUri(id);
    await node.getOrCreateGossipPublishHandler().handlePublishMessage(gossipMessage(SYSTEM_CONTEXT_GRAPHS.AGENTS, [
      { subject, predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, object: `"${wallet}"` },
      ...(opts.peerRow ? [{ subject, predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER, object: `"${REMOTE_PEER}"` }] : []),
    ]), SYSTEM_CONTEXT_GRAPHS.AGENTS, undefined, REMOTE_PEER);
  }

  async function storedAgentsRows(store: TripleStore, id: string): Promise<number> {
    const result = await store.query(`SELECT ?p ?o WHERE { GRAPH <${AGENTS_GRAPH}> { <${contextGraphDataGraphUri(id)}> ?p ?o } }`);
    return result.type === 'bindings' ? result.bindings.length : -1;
  }

  describe('agents topic rows', () => {
    it('do not admit a wallet to an unregistered private graph', async () => {
      const { agent, node, store } = await startNode();
      const id = 'access-rows-unregistered';
      const wallet = ethers.Wallet.createRandom();
      await agent.createContextGraph({ id, name: 'Unregistered', private: true });

      expect(await authorized(node, wallet, id)).toBe(false);

      await gossipAccessRows(node, id, wallet.address);

      expect(await storedAgentsRows(store, id)).toBe(0);
      expect((await node.getCgMeta(id)).allowedAgents).not.toContain(wallet.address);
      expect(await authorized(node, wallet, id)).toBe(false);
    }, 60_000);

    it('do not admit a wallet to a registered private graph without peer rows', async () => {
      const { agent, node, store } = await startNode();
      const id = 'access-rows-registered-agents-only';
      const wallet = ethers.Wallet.createRandom();
      await agent.createContextGraph({ id, name: 'Registered', private: true });
      await agent.registerContextGraph(id);

      expect(await authorized(node, wallet, id)).toBe(false);

      await gossipAccessRows(node, id, wallet.address);

      expect(await storedAgentsRows(store, id)).toBe(0);
      expect(await authorized(node, wallet, id)).toBe(false);
    }, 60_000);

    it('do not admit a wallet to a registered private graph with peer rows', async () => {
      const { agent, node, store } = await startNode();
      const id = 'access-rows-registered-peer-rows';
      const wallet = ethers.Wallet.createRandom();
      await agent.createContextGraph({ id, name: 'Registered peers', private: true, allowedPeers: [OTHER_PEER] });
      await agent.registerContextGraph(id);

      expect(await authorized(node, wallet, id)).toBe(false);

      await gossipAccessRows(node, id, wallet.address, { peerRow: true });

      expect(await storedAgentsRows(store, id)).toBe(0);
      expect(await authorized(node, wallet, id)).toBe(false);
    }, 60_000);

    it('do not admit a wallet to an unregistered private graph with peer rows', async () => {
      const { agent, node, store } = await startNode();
      const id = 'access-rows-unregistered-peer-rows';
      const wallet = ethers.Wallet.createRandom();
      await agent.createContextGraph({ id, name: 'Unregistered peers', private: true, allowedPeers: [OTHER_PEER] });

      expect(await authorized(node, wallet, id)).toBe(false);

      await gossipAccessRows(node, id, wallet.address, { peerRow: true });

      expect(await storedAgentsRows(store, id)).toBe(0);
      expect(await authorized(node, wallet, id)).toBe(false);
    }, 60_000);

    it('leave an agent profile in the same message to be stored', async () => {
      const { node, store } = await startNode();
      const id = 'access-rows-beside-a-profile';
      const profileWallet = ethers.Wallet.createRandom().address.toLowerCase();
      const profile = buildAgentProfile({ peerId: REMOTE_PEER, name: 'Profile', skills: [], agentAddress: profileWallet });
      await node.getOrCreateGossipPublishHandler().handlePublishMessage(gossipMessage(SYSTEM_CONTEXT_GRAPHS.AGENTS, [
        ...profile.quads,
        ...admittingRows(id, profileWallet, AGENTS_GRAPH),
      ]), SYSTEM_CONTEXT_GRAPHS.AGENTS, undefined, REMOTE_PEER);

      expect(await storedAgentsRows(store, id)).toBe(0);
      const stored = await store.query(`ASK { GRAPH <${AGENTS_GRAPH}> { <${profile.rootEntity}> <${DKG_ONTOLOGY.DKG_PEER_ID}> "${REMOTE_PEER}" } }`);
      expect(stored).toMatchObject({ value: true });
    }, 60_000);
  });

  it('a page of an agents graph sync stores agent profiles and no rows about a context graph', async () => {
    const { agent, node, store } = await startNode();
    const id = 'access-rows-synced';
    const wallet = ethers.Wallet.createRandom();
    await agent.createContextGraph({ id, name: 'Synced', private: true });
    const profile = buildAgentProfile({ peerId: REMOTE_PEER, name: 'Profile', skills: [], agentAddress: wallet.address });

    await node.insertSyncedQuadsAndInvalidateListCache([...profile.quads, ...admittingRows(id, wallet.address, AGENTS_GRAPH)]);

    expect(await storedAgentsRows(store, id)).toBe(0);
    const stored = await store.query(`ASK { GRAPH <${AGENTS_GRAPH}> { <${profile.rootEntity}> <${DKG_ONTOLOGY.DKG_PEER_ID}> "${REMOTE_PEER}" } }`);
    expect(stored).toMatchObject({ value: true });
    expect(await authorized(node, wallet, id)).toBe(false);
  }, 60_000);

  describe.each([
    ['agents', AGENTS_GRAPH],
    ['ontology', ONTOLOGY_GRAPH],
  ])('rows already stored in the %s graph', (_name, sharedGraph) => {
    it('do not admit a wallet to an unregistered private graph', async () => {
      const { agent, node, store } = await startNode();
      const id = 'stored-rows-unregistered';
      const wallet = ethers.Wallet.createRandom();
      await agent.createContextGraph({ id, name: 'Unregistered', private: true });

      await store.insert(admittingRows(id, wallet.address, sharedGraph));

      const meta = await node.getCgMeta(id);
      expect(meta.allowedAgents).not.toContain(wallet.address);
      expect(meta.allowedPeers).toEqual([]);
      expect(await authorized(node, wallet, id)).toBe(false);
    }, 60_000);

    it('do not admit a wallet to a registered private graph', async () => {
      const { agent, node, store } = await startNode();
      const id = 'stored-rows-registered';
      const wallet = ethers.Wallet.createRandom();
      await agent.createContextGraph({ id, name: 'Registered', private: true });
      await agent.registerContextGraph(id);

      await store.insert(admittingRows(id, wallet.address, sharedGraph));

      expect(await authorized(node, wallet, id)).toBe(false);
    }, 60_000);

    it('do not revoke a member of an unregistered private graph', async () => {
      const { agent, node, store } = await startNode();
      const id = 'stored-rows-revoked';
      const member = ethers.Wallet.createRandom();
      await agent.createContextGraph({ id, name: 'Member', private: true, allowedAgents: [member.address] });

      await store.insert([accessRow(id, DKG_ONTOLOGY.DKG_REVOKED_AGENT, member.address, sharedGraph)]);

      expect((await node.getCgMeta(id)).revokedAgents).toEqual([]);
      expect(await authorized(node, member, id)).toBe(true);
    }, 60_000);

    it('do not reach the roster a graph registers on chain', async () => {
      const { agent, node, store, chainAdapter } = await startNode();
      const id = 'stored-rows-registration';
      const member = ethers.Wallet.createRandom();
      const wallet = ethers.Wallet.createRandom();
      await agent.createContextGraph({ id, name: 'Member', private: true, allowedAgents: [member.address] });

      await store.insert(admittingRows(id, wallet.address, sharedGraph));
      const { onChainId } = await agent.registerContextGraph(id);

      expect(await node.getContextGraphParticipantAgentAddresses(id)).not.toContain(wallet.address);
      const roster = await chainAdapter.getContextGraphParticipantAgents(BigInt(onChainId));
      expect(roster).toContain(member.address);
      expect(roster).not.toContain(wallet.address);
    }, 60_000);
  });

  it('a public row in the agents graph does not open a graph whose own metadata gates it', async () => {
    const { node, store } = await startNode();
    const id = 'gated-without-a-policy';
    const member = ethers.Wallet.createRandom();
    const wallet = ethers.Wallet.createRandom();
    await store.insert([
      accessRow(id, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, member.address, contextGraphMetaGraphUri(id)),
      accessRow(id, DKG_ONTOLOGY.DKG_ACCESS_POLICY, 'public', AGENTS_GRAPH),
    ]);

    expect(await node.isPrivateContextGraph(id)).toBe(true);
    expect(await authorized(node, wallet, id)).toBe(false);
    expect(await authorized(node, member, id)).toBe(true);
  }, 60_000);

  it('a public graph stays open whatever the shared graphs list', async () => {
    const { agent, node, store } = await startNode();
    const id = 'public-graph';
    const wallet = ethers.Wallet.createRandom();
    await agent.createContextGraph({ id, name: 'Public' });

    await store.insert([
      ...admittingRows(id, ethers.Wallet.createRandom().address, AGENTS_GRAPH),
      ...admittingRows(id, ethers.Wallet.createRandom().address, ONTOLOGY_GRAPH),
    ]);

    expect(await node.isPrivateContextGraph(id)).toBe(false);
    expect(await authorized(node, wallet, id)).toBe(true);
  }, 60_000);

  describe('write preflight', () => {
    const id = 'preflight-access-list';
    const subject = contextGraphDataGraphUri(id);
    const metaGraph = contextGraphMetaGraphUri(id);
    const declared = (graph: string): Quad => (
      { subject, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph }
    );
    const gateRows = (graph: string): Quad[] => [
      ...admittingRows(id, ethers.Wallet.createRandom().address, graph),
      accessRow(id, DKG_ONTOLOGY.DKG_PARTICIPANT_IDENTITY_ID, '7', graph),
    ];
    const probeOf = async (rows: Quad[], callerAgentAddress?: string) => {
      const { agent, store } = await startNode();
      await store.insert(rows);
      return agent.probeContextGraphWritePreflight(id, { callerAgentAddress });
    };

    it('treats a graph its own metadata gates as private, without a policy', async () => {
      const probe = await probeOf([declared(metaGraph), ...gateRows(metaGraph)]);
      expect(probe.accessPolicy).toBe('private');
    }, 60_000);

    it.each([
      ['allowed agent', DKG_ONTOLOGY.DKG_ALLOWED_AGENT],
      ['participant agent', DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT],
      ['allowed peer', DKG_ONTOLOGY.DKG_ALLOWED_PEER],
      ['identity-id participant', DKG_ONTOLOGY.DKG_PARTICIPANT_IDENTITY_ID],
    ])('takes one %s row in its own metadata as a gate', async (_name, predicate) => {
      const probe = await probeOf([declared(metaGraph), accessRow(id, predicate, '7', metaGraph)]);
      expect(probe.accessPolicy).toBe('private');
    }, 60_000);

    it.each([
      ['agents', AGENTS_GRAPH],
      ['ontology', ONTOLOGY_GRAPH],
    ])('takes no gate from the %s graph', async (_name, graph) => {
      const probe = await probeOf([declared(graph), ...gateRows(graph)]);
      expect(probe.declarationFound).toBe(true);
      expect(probe.accessPolicy).toBeUndefined();
    }, 60_000);

    it('takes a private policy and no public one from the agents graph', async () => {
      const declaredPublic = await probeOf([declared(AGENTS_GRAPH), accessRow(id, DKG_ONTOLOGY.DKG_ACCESS_POLICY, 'public', AGENTS_GRAPH)]);
      expect(declaredPublic.accessPolicy).toBeUndefined();
      const declaredPrivate = await probeOf([declared(AGENTS_GRAPH), accessRow(id, DKG_ONTOLOGY.DKG_ACCESS_POLICY, 'private', AGENTS_GRAPH)]);
      expect(declaredPrivate.accessPolicy).toBe('private');
    }, 60_000);

    it('takes a spaced or capitalised private policy from the agents graph over a public one', async () => {
      const { agent, node, store } = await startNode();
      const caller = ethers.Wallet.createRandom().address;
      await store.insert([
        declared(ONTOLOGY_GRAPH),
        accessRow(id, DKG_ONTOLOGY.DKG_ACCESS_POLICY, 'public', ONTOLOGY_GRAPH),
        accessRow(id, DKG_ONTOLOGY.DKG_ACCESS_POLICY, ' Private ', AGENTS_GRAPH),
      ]);

      expect(await node.isPrivateContextGraph(id)).toBe(true);
      expect(await agent.probeContextGraphWritePreflight(id, { callerAgentAddress: caller }))
        .toMatchObject({ declarationFound: true, accessPolicy: 'private', callerAuthorized: false });
    }, 60_000);

    it('takes no spaced or capitalised public policy from the agents graph', async () => {
      const { agent, node, store } = await startNode();
      const caller = ethers.Wallet.createRandom().address;
      await store.insert([
        declared(metaGraph),
        accessRow(id, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, ethers.Wallet.createRandom().address, metaGraph),
        accessRow(id, DKG_ONTOLOGY.DKG_ACCESS_POLICY, ' Public ', AGENTS_GRAPH),
      ]);

      expect(await node.isPrivateContextGraph(id)).toBe(true);
      expect(await agent.probeContextGraphWritePreflight(id, { callerAgentAddress: caller }))
        .toMatchObject({ declarationFound: true, accessPolicy: 'private', callerAuthorized: false });
    }, 60_000);

    it('takes no curator from the agents graph, and authorizes the one its own metadata names', async () => {
      const caller = ethers.Wallet.createRandom().address;
      const curator = { subject, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: `did:dkg:agent:${caller.toLowerCase()}` };
      const rows = [declared(metaGraph), accessRow(id, DKG_ONTOLOGY.DKG_ACCESS_POLICY, 'private', metaGraph)];

      const fromAgents = await probeOf([...rows, { ...curator, graph: AGENTS_GRAPH }], caller);
      expect(fromAgents).toMatchObject({ accessPolicy: 'private', callerAuthorized: false });
      expect(fromAgents.curator).toBeUndefined();

      const fromMeta = await probeOf([...rows, { ...curator, graph: metaGraph }], caller);
      expect(fromMeta).toMatchObject({ callerAuthorized: true, curator: curator.object });
    }, 60_000);

    it('takes a public policy and a curator from the ontology graph', async () => {
      const curator = `did:dkg:agent:${ethers.Wallet.createRandom().address}`;
      const probe = await probeOf([
        declared(ONTOLOGY_GRAPH),
        accessRow(id, DKG_ONTOLOGY.DKG_ACCESS_POLICY, 'public', ONTOLOGY_GRAPH),
        { subject, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: curator, graph: ONTOLOGY_GRAPH },
      ]);
      expect(probe).toMatchObject({ accessPolicy: 'public', curator });
    }, 60_000);
  });

  describe('an unregistered private graph', () => {
    it('admits the wallets its own metadata lists', async () => {
      const { agent, node } = await startNode();
      const id = 'own-metadata-unregistered';
      const member = ethers.Wallet.createRandom();
      await agent.createContextGraph({ id, name: 'Members', private: true, allowedAgents: [member.address] });

      expect(await authorized(node, member, id)).toBe(true);
      expect(await authorized(node, ethers.Wallet.createRandom(), id)).toBe(false);
    }, 60_000);

    it('admits a wallet on its agent gate over a peer on its peer list, and no other wallet', async () => {
      const { agent, node } = await startNode();
      const id = 'own-metadata-peers';
      await agent.createContextGraph({ id, name: 'Peers', private: true, allowedPeers: [REMOTE_PEER] });

      expect(await authorized(node, ethers.Wallet.createRandom(), id)).toBe(false);
      const member = ethers.Wallet.createRandom();
      await agent.inviteAgentToContextGraph(id, member.address);
      expect(await authorized(node, member, id)).toBe(true);
    }, 60_000);

    it('admits a peer its own metadata lists when it has no agent gate, and not one a shared graph lists', async () => {
      const { node, store } = await startNode();
      const id = 'own-metadata-peers-only';
      const metaGraph = contextGraphMetaGraphUri(id);

      await store.insert([accessRow(id, DKG_ONTOLOGY.DKG_ALLOWED_PEER, OTHER_PEER, metaGraph)]);
      await store.insert([
        accessRow(id, DKG_ONTOLOGY.DKG_ALLOWED_PEER, REMOTE_PEER, AGENTS_GRAPH),
        accessRow(id, DKG_ONTOLOGY.DKG_ALLOWED_PEER, REMOTE_PEER, ONTOLOGY_GRAPH),
      ]);
      expect(await node.isPrivateContextGraph(id)).toBe(true);
      expect(await authorized(node, ethers.Wallet.createRandom(), id)).toBe(false);

      await store.insert([accessRow(id, DKG_ONTOLOGY.DKG_ALLOWED_PEER, REMOTE_PEER, metaGraph)]);
      expect(await authorized(node, ethers.Wallet.createRandom(), id)).toBe(true);
    }, 60_000);

    it('denies everyone when it declares itself private and lists nobody', async () => {
      const { node, store } = await startNode();
      const id = 'own-metadata-empty';
      await store.insert([accessRow(id, DKG_ONTOLOGY.DKG_ACCESS_POLICY, 'private', AGENTS_GRAPH)]);

      expect(await node.isPrivateContextGraph(id)).toBe(true);
      expect(await authorized(node, ethers.Wallet.createRandom(), id)).toBe(false);
    }, 60_000);

    it('stops admitting a member its own metadata revokes', async () => {
      const { agent, node } = await startNode();
      const id = 'own-metadata-revoked';
      const member = ethers.Wallet.createRandom();
      await agent.createContextGraph({ id, name: 'Members', private: true, allowedAgents: [member.address] });
      expect(await authorized(node, member, id)).toBe(true);

      await agent.removeAgentFromContextGraph(id, member.address);

      expect(await authorized(node, member, id)).toBe(false);
    }, 60_000);
  });

  describe('an unregistered private graph with an accepted owner-signed roster', () => {
    async function acceptedRosterGraph(id: string, allowedAgents: string[], roster: string[]) {
      const started = await startNode();
      await started.agent.createContextGraph({ id, name: 'Accepted', private: true, allowedAgents });
      (started.agent as unknown as { resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1(graph: string): readonly string[] | undefined })
        .resolveActiveAcceptedRfc64PrivateUnregisteredRosterV1 = (graph) => (graph === id ? roster : undefined);
      return started;
    }

    it('admits a wallet on the roster, with no peer rows', async () => {
      const member = ethers.Wallet.createRandom();
      const { node } = await acceptedRosterGraph('accepted-roster-member', [], [member.address]);

      expect(await authorized(node, member, 'accepted-roster-member')).toBe(true);
    }, 60_000);

    it('does not admit a wallet only its own metadata lists', async () => {
      const listed = ethers.Wallet.createRandom();
      const { node } = await acceptedRosterGraph('accepted-roster-decides', [listed.address], [ethers.Wallet.createRandom().address]);

      expect(await authorized(node, listed, 'accepted-roster-decides')).toBe(false);
    }, 60_000);

    it('stops admitting a removed member before the roster rotates', async () => {
      const id = 'accepted-roster-removal';
      const member = ethers.Wallet.createRandom();
      const { agent, node } = await acceptedRosterGraph(id, [member.address], [member.address]);
      expect(await authorized(node, member, id)).toBe(true);

      await agent.removeAgentFromContextGraph(id, member.address);

      expect(await authorized(node, member, id)).toBe(false);
    }, 60_000);
  });

  describe('a registered private graph', () => {
    async function registeredGraph(id: string, allowedAgents: string[] = []) {
      const started = await startNode();
      await started.agent.createContextGraph({ id, name: 'Registered', private: true, allowedAgents });
      const { onChainId } = await started.agent.registerContextGraph(id);
      return { ...started, onChainId: BigInt(onChainId) };
    }

    it('admits the members of its chain roster, with no peer rows', async () => {
      const member = ethers.Wallet.createRandom();
      const { node } = await registeredGraph('roster-member', [member.address]);

      expect(await authorized(node, member, 'roster-member')).toBe(true);
    }, 60_000);

    it('admits a member invited after registration', async () => {
      const id = 'roster-late-member';
      const { agent, node, chainAdapter, onChainId } = await registeredGraph(id);
      const member = ethers.Wallet.createRandom();
      expect(await authorized(node, member, id)).toBe(false);

      await agent.inviteAgentToContextGraph(id, member.address);

      expect(await chainAdapter.getContextGraphParticipantAgents(onChainId)).toContain(member.address);
      expect(await authorized(node, member, id)).toBe(true);
    }, 60_000);

    it('stops admitting a member removed from its chain roster', async () => {
      const id = 'roster-removed-member';
      const member = ethers.Wallet.createRandom();
      const { agent, node } = await registeredGraph(id, [member.address]);
      expect(await authorized(node, member, id)).toBe(true);

      await agent.removeAgentFromContextGraph(id, member.address);

      expect(await authorized(node, member, id)).toBe(false);
    }, 60_000);

    it('does not admit a wallet its own metadata lists and its chain roster does not', async () => {
      const id = 'roster-decides';
      const { node, store } = await registeredGraph(id);
      const wallet = ethers.Wallet.createRandom();

      await store.insert([accessRow(id, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, wallet.address, contextGraphMetaGraphUri(id))]);

      expect((await node.getCgMeta(id)).allowedAgents).toContain(wallet.address);
      expect(await authorized(node, wallet, id)).toBe(false);
    }, 60_000);

    it('does not admit a wallet on its chain roster that its own metadata revokes', async () => {
      const id = 'roster-local-revocation';
      const member = ethers.Wallet.createRandom();
      const { node, store } = await registeredGraph(id, [member.address]);
      expect(await authorized(node, member, id)).toBe(true);

      await store.insert([accessRow(id, DKG_ONTOLOGY.DKG_REVOKED_AGENT, member.address, contextGraphMetaGraphUri(id))]);

      expect(await authorized(node, member, id)).toBe(false);
    }, 60_000);

    it('takes a delegation of a member on its roster', async () => {
      const id = 'roster-delegation';
      const { agent, node } = await registeredGraph(id);
      const member = ethers.Wallet.createRandom();
      const opKey = ethers.Wallet.createRandom();
      (agent as unknown as { chain: MockChainAdapter }).chain.seedIdentity(opKey.address, 41n);
      const delegation = await signAgentDelegation({
        agentAddress: member.address,
        agentPrivateKey: member.privateKey,
        scope: `context-graph-join:${id}`,
        issuedAtMs: Date.now(),
        delegateeOpKey: opKey.address,
      });

      await agent.inviteAgentToContextGraph(id, member.address, undefined, delegation);

      expect(await authorized(node, opKey, id, { identityId: 41n, claimedAgent: member.address })).toBe(true);
    }, 60_000);

    it('does not take a delegation of an agent off its roster', async () => {
      const id = 'roster-foreign-delegation';
      const { agent, node, store } = await registeredGraph(id);
      const claimed = ethers.Wallet.createRandom().address;
      const opKey = ethers.Wallet.createRandom();
      (agent as unknown as { chain: MockChainAdapter }).chain.seedIdentity(opKey.address, 42n);
      const metaGraph = contextGraphMetaGraphUri(id);
      const subject = `did:dkg:agent-delegation:${id}:${claimed.toLowerCase()}`;

      await store.insert([
        accessRow(id, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, claimed, metaGraph),
        { subject, predicate: DKG_ONTOLOGY.DKG_DELEGATION_AGENT, object: `"${claimed.toLowerCase()}"`, graph: metaGraph },
        { subject, predicate: DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_KEY, object: `"${opKey.address.toLowerCase()}"`, graph: metaGraph },
      ]);

      expect(await authorized(node, opKey, id, { identityId: 42n, claimedAgent: claimed })).toBe(false);
    }, 60_000);

    it('admits an identity-id participant its own metadata lists', async () => {
      const id = 'roster-identity-participant';
      const { agent, node, store } = await registeredGraph(id);
      const opKey = ethers.Wallet.createRandom();
      const chain = (agent as unknown as { chain: MockChainAdapter }).chain;
      chain.seedIdentity(opKey.address, 77n);
      expect(await authorized(node, opKey, id, { identityId: 77n, claimedAgent: opKey.address })).toBe(false);

      await store.insert([accessRow(id, DKG_ONTOLOGY.DKG_PARTICIPANT_IDENTITY_ID, '77', contextGraphMetaGraphUri(id))]);

      expect(await authorized(node, opKey, id, { identityId: 77n, claimedAgent: opKey.address })).toBe(true);
    }, 60_000);

    it.each([
      ['agents', AGENTS_GRAPH],
      ['ontology', ONTOLOGY_GRAPH],
    ])('does not admit an identity-id participant the %s graph lists', async (_name, sharedGraph) => {
      const id = 'roster-identity-shared-row';
      const { agent, node, store } = await registeredGraph(id);
      const opKey = ethers.Wallet.createRandom();
      (agent as unknown as { chain: MockChainAdapter }).chain.seedIdentity(opKey.address, 78n);

      await store.insert([accessRow(id, DKG_ONTOLOGY.DKG_PARTICIPANT_IDENTITY_ID, '78', sharedGraph)]);

      expect(await authorized(node, opKey, id, { identityId: 78n, claimedAgent: opKey.address })).toBe(false);
    }, 60_000);
  });
});
