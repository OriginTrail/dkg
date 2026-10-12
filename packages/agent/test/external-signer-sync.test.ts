/**
 * Catch-up sync of a node that holds no local key, against the shared Hardhat
 * node. Its payer and author keys live in an external signer; a core node with
 * local keys creates and registers the graphs and serves them. The keyless
 * edge learns of a graph it did not create, subscribes to it and catches up,
 * and syncs the system graphs. Its authenticated sync requests are signed by
 * its default agent, an author key of the signer, which is given the request
 * fields (`dkg_signSyncRequest`) rather than a bare digest; a signer without
 * that method signs the digest (`eth_sign`). A curator verifies such a
 * signature like any other, and a node with an on-chain identity signs with its
 * payer the same way.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { connectRemoteSigners, type ChainAdapter, type RemoteSigners } from '@origintrail-official/dkg-chain';
import { contextGraphDataGraphUri, SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';
import {
  createEVMAdapter,
  createProvider,
  getSharedContext,
  HARDHAT_KEYS,
  revertSnapshot,
  takeSnapshot,
} from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import {
  startFakeRemoteSigner,
  type FakeSigner,
  type FakeSignerRequest,
} from '../../chain/test/helpers/fake-remote-signer.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import { createPublishProtocolAgent, sleep } from './_helpers/publish-protocol.js';

const PAYER_TOKEN = 'sync-payer-credential-2b3c4d5e6f708192';
const AUTHOR_TOKEN = 'sync-author-credential-9281706f5e4d3c2b';
const PUBLIC_CG = 'keyless-catch-up-public';
const PRIVATE_CG = 'keyless-catch-up-private';
const ENTITY = 'urn:keyless-catch-up:entity';

interface KeylessEdge {
  readonly agent: DKGAgent;
  readonly fake: FakeSigner;
  readonly author: ethers.Wallet;
}

let snapshotId: string;
const signers: FakeSigner[] = [];
const connections: RemoteSigners[] = [];
const agents: DKGAgent[] = [];
let creator: DKGAgent;

/** The chain adapter of `agent`. */
function chainOf(agent: DKGAgent): ChainAdapter {
  return (agent as unknown as { chain: ChainAdapter }).chain;
}

/** The data bytes of an `eth_sign` request (`[address, data]`). */
function signedBytes(request: FakeSignerRequest): Uint8Array {
  return ethers.getBytes(String(request.params[1]));
}

/** EIP-191 message signing requests made with a credential. */
function messageSignatures(fake: FakeSigner, token: string): FakeSignerRequest[] {
  return fake.requests.filter((request) => (
    request.authorization === `Bearer ${token}`
    && ['eth_sign', 'personal_sign', 'dkg_signSyncRequest'].includes(request.method)
  ));
}

/** `eth_sign` requests over a bare 32-byte digest. */
function digestSignatures(fake: FakeSigner): FakeSignerRequest[] {
  return fake.calls('eth_sign').filter((request) => signedBytes(request).length === 32);
}

/** The text of the first length-framed field of an `eth_sign` request's data. */
function firstFramedField(request: FakeSignerRequest): string {
  const signed = signedBytes(request);
  return new TextDecoder().decode(signed.subarray(4, 4 + new DataView(signed.buffer, signed.byteOffset).getUint32(0)));
}

/** A keyless edge whose payer and author keys are served by its own fake signer. */
async function keylessEdge(
  name: string,
  keys: { payer: string; author: string },
  unsupported: string[] = [],
): Promise<KeylessEdge> {
  const { rpcUrl, hubAddress } = getSharedContext();
  const fake = await startFakeRemoteSigner({
    credentials: [
      { token: PAYER_TOKEN, keys: [keys.payer] },
      { token: AUTHOR_TOKEN, keys: [keys.author] },
    ],
    unsupported,
  });
  signers.push(fake);
  const remote = await connectRemoteSigners({ url: fake.url, authToken: PAYER_TOKEN, author: { authToken: AUTHOR_TOKEN } });
  connections.push(remote);
  const agent = await createPublishProtocolAgent({
    name,
    store: new OxigraphStore(),
    listenPort: 0,
    listenHost: '127.0.0.1',
    nodeRole: 'edge',
    kaNumberAllocator: makeTestKaNumberAllocator(),
    chainConfig: { rpcUrl, hubAddress, chainId: 'evm:31337', signers: remote.operational },
    authorSigners: remote.authors,
    syncOnConnectEnabled: false,
  });
  agents.push(agent);
  await agent.start();
  const address = creator.multiaddrs.find((entry) => entry.includes('/tcp/') && !entry.includes('/p2p-circuit'))!;
  await agent.connectTo(address);
  await sleep(500);
  return { agent, fake, author: new ethers.Wallet(keys.author) };
}

/** Learn of the public graph from the ontology, subscribe to it and catch it up. */
async function catchUpPublicGraph(edge: KeylessEdge): Promise<number> {
  await edge.agent.syncFromPeer(creator.peerId, [SYSTEM_CONTEXT_GRAPHS.ONTOLOGY]);
  expect(await edge.agent.contextGraphExists(PUBLIC_CG)).toBe(true);
  edge.agent.subscribeToContextGraph(PUBLIC_CG);
  await edge.agent.whenRfc64CatalogResponsibilitiesIdleV1();
  return edge.agent.syncFromPeer(creator.peerId, [PUBLIC_CG]);
}

async function names(agent: DKGAgent): Promise<unknown[]> {
  const result = await agent.query(`SELECT ?name WHERE { <${ENTITY}> <http://schema.org/name> ?name }`, PUBLIC_CG);
  return result.bindings.map((row) => row.name);
}

async function triplesOf(agent: DKGAgent, graph: string): Promise<string[]> {
  const result = await agent.store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  if (result.type !== 'bindings') throw new Error('expected bindings');
  return result.bindings.map((row) => `${row.s} ${row.p} ${row.o}`).sort();
}

describe('catch-up sync of a node that signs through an external signer', () => {
  let edge: KeylessEdge;

  beforeAll(async () => {
    snapshotId = await takeSnapshot();
    const { hubAddress } = getSharedContext();
    await mintTokens(createProvider(), hubAddress, HARDHAT_KEYS.DEPLOYER, new ethers.Wallet(HARDHAT_KEYS.CORE_OP).address, ethers.parseEther('50000000'));
    creator = await createPublishProtocolAgent({
      name: 'CatchUpCreator',
      listenPort: 0,
      listenHost: '127.0.0.1',
      nodeRole: 'core',
      kaNumberAllocator: makeTestKaNumberAllocator(),
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      syncOnConnectEnabled: false,
    });
    agents.push(creator);
    await creator.start();
    // The graph is created, registered and published to before the edge exists.
    await creator.createContextGraph({ id: PUBLIC_CG, name: 'Keyless catch-up', description: '' });
    await creator.registerContextGraph(PUBLIC_CG);
    creator.subscribeToContextGraph(PUBLIC_CG);
    await creator.publish(PUBLIC_CG, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Caught up"', graph: '' },
    ]);
    edge = await keylessEdge('KeylessEdge', { payer: HARDHAT_KEYS.PUBLISHER, author: HARDHAT_KEYS.EXTRA2 });
  }, 180_000);

  afterAll(async () => {
    for (const agent of agents.reverse()) await agent.stop().catch(() => {});
    for (const remote of connections) remote.destroy();
    for (const fake of signers) await fake.close();
    if (snapshotId) await revertSnapshot(snapshotId);
  });

  it('learns of, subscribes to and catches up a public graph another node created', async () => {
    expect(edge.agent.getDefaultAgentAddress()).toBe(edge.author.address);
    expect(await catchUpPublicGraph(edge)).toBeGreaterThan(0);
    expect(await names(edge.agent)).toEqual(['"Caught up"']);
  }, 120_000);

  it('syncs the agents and ontology system graphs', async () => {
    expect(await edge.agent.syncFromPeer(creator.peerId, [SYSTEM_CONTEXT_GRAPHS.AGENTS, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY]))
      .toBeGreaterThan(0);
    for (const systemGraph of [SYSTEM_CONTEXT_GRAPHS.AGENTS, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY]) {
      const graph = contextGraphDataGraphUri(systemGraph);
      const served = await triplesOf(creator, graph);
      expect(served.length).toBeGreaterThan(0);
      expect(await triplesOf(edge.agent, graph)).toEqual(expect.arrayContaining(served));
    }
  }, 120_000);

  it('had the author key sign every request from its fields, and nothing as a bare digest', () => {
    const requests = edge.fake.calls('dkg_signSyncRequest');
    for (const request of requests) {
      expect(request.authorization).toBe(`Bearer ${AUTHOR_TOKEN}`);
      expect(request.params[0]).toBe(edge.author.address.toLowerCase());
      expect(request.params[1]).toMatchObject({
        requesterAgentAddress: edge.author.address.toLowerCase(),
        requesterPeerId: edge.agent.peerId,
        targetPeerId: creator.peerId,
        requestId: expect.stringMatching(/^0x[0-9a-f]{24}$/),
      });
    }
    const contextGraphs = new Set(requests.map((request) => (request.params[1] as { contextGraphId: string }).contextGraphId));
    expect(contextGraphs).toEqual(new Set([SYSTEM_CONTEXT_GRAPHS.AGENTS, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY, PUBLIC_CG]));
    // Besides these, the author key signed one message, the framed proof binding its
    // workspace encryption key: no digest was signed blind, and payers signed no message.
    const others = messageSignatures(edge.fake, AUTHOR_TOKEN).filter((request) => request.method !== 'dkg_signSyncRequest');
    expect(others.map((request) => [request.method, firstFramedField(request)])).toEqual([['eth_sign', 'domain']]);
    expect(digestSignatures(edge.fake)).toEqual([]);
    expect(messageSignatures(edge.fake, PAYER_TOKEN)).toEqual([]);
  });

  it('is authorized by the curator of a private graph that allowlists its agent', async () => {
    await creator.createContextGraph({
      id: PRIVATE_CG,
      name: 'Keyless private catch-up',
      accessPolicy: 1,
      allowedAgents: [creator.getDefaultAgentAddress()!, edge.author.address],
    });
    expect(await creator.isPrivateContextGraph(PRIVATE_CG)).toBe(true);
    const request = await edge.agent.buildSyncRequest(PRIVATE_CG, 0, 10, false, creator.peerId, 'meta');
    const envelope = creator.parseSyncRequest(request);
    expect(envelope).toMatchObject({ requesterIdentityId: '0', requesterAgentAddress: edge.author.address });
    expect(await creator.authorizeSyncRequest(envelope, edge.agent.peerId)).toBe(true);
    // Replayed, or presented by another peer, the same request is refused.
    expect(await creator.authorizeSyncRequest(creator.parseSyncRequest(request), edge.agent.peerId)).toBe(false);
    const other = await edge.agent.buildSyncRequest(PRIVATE_CG, 0, 10, false, creator.peerId, 'meta');
    expect(await creator.authorizeSyncRequest(creator.parseSyncRequest(other), creator.peerId)).toBe(false);
  }, 120_000);

  it('signs the digest with eth_sign when the signer does not implement the method', async () => {
    const plain = await keylessEdge(
      'KeylessEdgePlainSigner',
      { payer: HARDHAT_KEYS.PUBLISHER2, author: HARDHAT_KEYS.EXTRA3 },
      ['dkg_signSyncRequest'],
    );
    expect(await catchUpPublicGraph(plain)).toBeGreaterThan(0);
    expect(await names(plain.agent)).toEqual(['"Caught up"']);
    // One attempt with the method, then each request's 32-byte digest through eth_sign.
    expect(plain.fake.calls('dkg_signSyncRequest')).toHaveLength(1);
    const digests = digestSignatures(plain.fake);
    expect(digests.length).toBeGreaterThan(0);
    for (const request of digests) {
      expect(request.authorization).toBe(`Bearer ${AUTHOR_TOKEN}`);
      expect(request.params[0]).toBe(plain.author.address.toLowerCase());
      expect(signedBytes(request)).toHaveLength(32);
    }
    // This agent is not on the private graph's allowlist: its valid signature does not admit it.
    const request = await plain.agent.buildSyncRequest(PRIVATE_CG, 0, 10, false, creator.peerId, 'meta');
    expect(await creator.authorizeSyncRequest(creator.parseSyncRequest(request), plain.agent.peerId)).toBe(false);
  }, 120_000);

  it('signs as its node identity with a payer that is an operational key of a profile', async () => {
    const operational = await keylessEdge('KeylessEdgeWithIdentity', { payer: HARDHAT_KEYS.REC1_OP, author: HARDHAT_KEYS.EXTRA1 });
    const identityId = await chainOf(operational.agent).getIdentityId();
    expect(identityId).toBeGreaterThan(0n);
    const envelope = creator.parseSyncRequest(
      await operational.agent.buildSyncRequest(PUBLIC_CG, 0, 10, false, creator.peerId, 'meta'),
    );
    expect(envelope.requesterIdentityId).toBe(identityId.toString());
    const [request] = operational.fake.calls('dkg_signSyncRequest');
    expect(request.authorization).toBe(`Bearer ${PAYER_TOKEN}`);
    expect(request.params[0]).toBe(new ethers.Wallet(HARDHAT_KEYS.REC1_OP).address.toLowerCase());
    expect(request.params[1]).toMatchObject({ requestId: envelope.requestId, issuedAtMs: envelope.issuedAtMs });
    const signer = ethers.recoverAddress(
      ethers.hashMessage(creator.computeSyncDigest(
        envelope.contextGraphId, envelope.offset, envelope.limit, envelope.includeSharedMemory,
        envelope.targetPeerId!, envelope.requesterPeerId, envelope.requestId, envelope.issuedAtMs,
        envelope.requesterAgentAddress,
      )),
      { r: envelope.requesterSignatureR!, yParityAndS: envelope.requesterSignatureVS! },
    );
    expect(signer).toBe(new ethers.Wallet(HARDHAT_KEYS.REC1_OP).address);
    expect(await chainOf(creator).verifySyncIdentity!(signer, identityId)).toBe(true);
    expect(digestSignatures(operational.fake)).toEqual([]);
  }, 120_000);
});
