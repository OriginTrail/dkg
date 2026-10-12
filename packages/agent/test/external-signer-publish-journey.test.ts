/**
 * The publish journey of a node that holds no local key, against the shared
 * Hardhat node: its payers and author key live in an external signer, and a
 * core node with local keys hosts the graph and acknowledges storage. The node
 * registers a PCA-backed public graph with a curated publish policy under its
 * default agent (the author key), then writes, finalizes, shares and publishes
 * a knowledge asset into it. Every signature the node needs is requested from
 * the external signer. Its shares into an open graph, which has no signing
 * roster, are signed by its default agent's author key in the same way, so a
 * hosting core admits and replays them.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { EVMChainAdapter, connectRemoteSigners, type RemoteSigners } from '@origintrail-official/dkg-chain';
import { GOSSIP_TYPE_WORKSPACE_PUBLISH, computeGossipSigningPayload, decodeGossipEnvelope } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';
import { SwmHostModeStore } from '../src/swm/host-mode-store.js';
import {
  createEVMAdapter,
  createProvider,
  getSharedContext,
  HARDHAT_KEYS,
  revertSnapshot,
  takeSnapshot,
} from '../../chain/test/evm-test-context.js';
import { makeAdapterConfig, mintTokens } from '../../chain/test/hardhat-harness.js';
import { startFakeRemoteSigner, type FakeSigner } from '../../chain/test/helpers/fake-remote-signer.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import {
  bindAndSubscribePublicContextGraph,
  bindPublicContextGraph,
  createPublishProtocolAgent,
  pollUntil,
  sleep,
  stageRootlessAssertion,
} from './_helpers/publish-protocol.js';

const PAYER_TOKEN = 'journey-payer-credential-1f2e3d4c5b6a';
const AUTHOR_TOKEN = 'journey-author-credential-6a5b4c3d2e1f';
const payers = [new ethers.Wallet(HARDHAT_KEYS.PUBLISHER), new ethers.Wallet(HARDHAT_KEYS.PUBLISHER2)];
const author = new ethers.Wallet(HARDHAT_KEYS.EXTRA2);
const CG = 'external-signer-journey';
const NAME = 'journey-asset';
const ENTITY = 'urn:external-signer-journey:entity';
const OPEN_CG = 'external-signer-open-journey';
const OPEN_ENTITY = 'urn:external-signer-journey:open-entity';
const COMMITTED = ethers.parseEther('100000');

let snapshotId: string;
let fake: FakeSigner;
let remote: RemoteSigners;
let pcaOwner: ReturnType<typeof createEVMAdapter>;
let accountId: bigint;
let edge: DKGAgent;
let core: DKGAgent;
let hostModeDir: string | undefined;

describe('publish journey of a node that signs through an external signer', () => {
  beforeAll(async () => {
    snapshotId = await takeSnapshot();
    const provider = createProvider();
    const { rpcUrl, hubAddress } = getSharedContext();
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, new ethers.Wallet(HARDHAT_KEYS.CORE_OP).address, ethers.parseEther('50000000'));

    pcaOwner = createEVMAdapter(HARDHAT_KEYS.EXTRA1);
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, pcaOwner.getSignerAddress(), COMMITTED);
    ({ accountId } = await pcaOwner.createPublishingConvictionAccount(COMMITTED));
    for (const payer of payers) await pcaOwner.registerPublishingConvictionAgent(accountId, payer.address);

    fake = await startFakeRemoteSigner({
      credentials: [
        { token: PAYER_TOKEN, keys: payers.map((payer) => payer.privateKey) },
        { token: AUTHOR_TOKEN, keys: [author.privateKey] },
      ],
    });
    remote = await connectRemoteSigners({ url: fake.url, authToken: PAYER_TOKEN, author: { authToken: AUTHOR_TOKEN } });
    edge = await createPublishProtocolAgent({
      name: 'ExternalSignerEdge',
      store: new OxigraphStore(),
      listenHost: '127.0.0.1',
      listenPort: 0,
      nodeRole: 'edge',
      kaNumberAllocator: makeTestKaNumberAllocator(),
      chainConfig: { rpcUrl, hubAddress, chainId: 'evm:31337', signers: remote.operational, authors: remote.authors },
    });
    core = await createPublishProtocolAgent({
      name: 'JourneyCore',
      listenPort: 0,
      nodeRole: 'core',
      kaNumberAllocator: makeTestKaNumberAllocator(),
      chainAdapter: new EVMChainAdapter(makeAdapterConfig(getSharedContext().rpcUrl, getSharedContext().hubAddress, HARDHAT_KEYS.CORE_OP)),
      syncOnConnectEnabled: false,
    });
    await core.start();
    await edge.start();
    const coreAddress = core.multiaddrs.find((address) => address.includes('/tcp/') && !address.includes('/p2p-circuit'))!;
    await edge.connectTo(coreAddress);
    await sleep(1_000);
  }, 180_000);

  afterAll(async () => {
    await edge?.stop().catch(() => {});
    await core?.stop().catch(() => {});
    pcaOwner?.destroy();
    await fake?.close();
    if (hostModeDir) await rm(hostModeDir, { recursive: true, force: true });
    if (snapshotId) await revertSnapshot(snapshotId);
  });

  it('registers, writes, finalizes, shares and publishes with no local key', async () => {
    expect(edge.getDefaultAgentAddress()).toBe(author.address);
    await edge.createContextGraph({ id: CG, name: 'External signer journey' });
    const { onChainId } = await edge.registerContextGraph(CG, { publishPolicy: 0, publishAuthorityAccountId: accountId });
    await bindAndSubscribePublicContextGraph(core, CG, onChainId);
    await sleep(1_500);

    await edge.assertion.create(CG, NAME);
    await edge.assertion.write(CG, NAME, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Journey entity"' },
    ]);
    await edge.assertion.finalize(CG, NAME);
    await edge.assertion.promote(CG, NAME);

    const shared = await pollUntil(
      () => core.query(`SELECT ?name WHERE { <${ENTITY}> <http://schema.org/name> ?name }`, {
        contextGraphId: CG,
        graphSuffix: '_shared_memory',
      }),
      (bindings) => bindings.length > 0,
      20_000,
    );
    expect(shared).toHaveLength(1);

    const published = await edge.publishFromFinalizedAssertion(CG, NAME);
    expect(published.status).toBe('confirmed');

    // The shared-memory envelope was signed by the author key through the
    // signer, over the four length-framed fields; payers signed transactions.
    const messages = fake.calls('eth_sign');
    expect(messages).toHaveLength(1);
    expect(messages[0].authorization).toBe(`Bearer ${AUTHOR_TOKEN}`);
    expect(ethers.getAddress(String(messages[0].params[0]))).toBe(author.address);
    const signed = ethers.getBytes(String(messages[0].params[1]));
    const type = new TextDecoder().decode(signed.subarray(4, 4 + new DataView(signed.buffer, signed.byteOffset).getUint32(0)));
    expect(type).toBe('share-write');
    expect(fake.requests.filter((request) => request.authorization === `Bearer ${PAYER_TOKEN}` && request.method.includes('sign'))
      .every((request) => request.method === 'eth_signTransaction')).toBe(true);
  }, 180_000);

  it('signs a share into an open graph with the author key, so a hosting core admits and replays it', async () => {
    await edge.createContextGraph({ id: OPEN_CG, name: 'External signer open graph' });
    const { onChainId } = await edge.registerContextGraph(OPEN_CG, { publishPolicy: 1 });
    // The hosting core knows the graph (and so its open policy) but is no member of it.
    await bindPublicContextGraph(core, OPEN_CG, onChainId);

    const envelopes: Uint8Array[] = [];
    const encode = edge.encodeWorkspaceGossipMessage.bind(edge);
    const spy = vi.spyOn(edge, 'encodeWorkspaceGossipMessage').mockImplementation(async (contextGraphId, message, signer) => {
      const wire = await encode(contextGraphId, message, signer);
      if (contextGraphId === OPEN_CG) envelopes.push(wire);
      return wire;
    });
    const before = fake.calls('eth_sign').length;
    try {
      await stageRootlessAssertion(edge, OPEN_CG, 'open-asset', [
        { subject: OPEN_ENTITY, predicate: 'http://schema.org/name', object: '"Open entity"' },
      ]);
    } finally {
      spy.mockRestore();
    }

    // The share's envelope is signed by the author key through the signer.
    expect(envelopes).toHaveLength(1);
    const envelope = decodeGossipEnvelope(envelopes[0]);
    expect(envelope.type).toBe(GOSSIP_TYPE_WORKSPACE_PUBLISH);
    expect(envelope.agentAddress).toBe(author.address);
    const signed = computeGossipSigningPayload(envelope.type, envelope.contextGraphId, envelope.timestamp, envelope.payload);
    expect(ethers.verifyMessage(signed, ethers.hexlify(envelope.signature))).toBe(author.address);
    const messages = fake.calls('eth_sign').slice(before);
    expect(messages).toHaveLength(1);
    expect(messages[0].authorization).toBe(`Bearer ${AUTHOR_TOKEN}`);
    expect(messages[0].params).toEqual([author.address.toLowerCase(), ethers.hexlify(signed)]);

    // A hosting core admits it and keeps it for catch-up, and its replay
    // applies the share to the core's shared memory.
    hostModeDir = await mkdtemp(join(tmpdir(), 'external-signer-host-mode-'));
    const hostStore = new SwmHostModeStore({ dataDir: hostModeDir, ...SwmHostModeStore.defaultLimits() });
    await hostStore.init();
    (core as unknown as { swmHostModeStore?: SwmHostModeStore }).swmHostModeStore = hostStore;
    await core.ingestSwmHostModeEnvelope(OPEN_CG, envelopes[0], edge.peerId);
    expect((await hostStore.iterate(OPEN_CG, 0)).map((entry) => ethers.hexlify(entry.envelopeBytes))).toEqual([ethers.hexlify(envelopes[0])]);
    const replayed = await core.query(`SELECT ?name WHERE { <${OPEN_ENTITY}> <http://schema.org/name> ?name }`, {
      contextGraphId: OPEN_CG,
      graphSuffix: '_shared_memory',
    });
    expect(replayed.bindings).toHaveLength(1);
  }, 180_000);
});
