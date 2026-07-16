/**
 * Greenfield KA update E2E — publish → off-band owner seal → publisher.update.
 *
 * Unlike `publisher-evm-e2e.test.ts` (which uses `wrapPublisherForTest` to
 * auto-inject seals), this file models the hosted/agent path:
 *
 *   1. Author signs `AuthorAttestation` once; publisher publishes with
 *      `precomputedAttestation` + ACK quorum.
 *   2. Author signs `UpdateAuthorAttestation(kaId, newMerkleRoot, …)` once.
 *   3. Publisher receives `precomputedUpdateAttestation` on the first
 *      `update()` call, collects ACKs, pays TRAC, broadcasts.
 *   4. Peers verify via `verifyKAUpdate`; UAL stays stable across updates.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ethers, Wallet } from 'ethers';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { EVMChainAdapter, buildKnowledgeAssetUal } from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { DKGPublisher } from '../src/dkg-publisher.js';
import {
  spawnHardhatEnv,
  killHardhat,
  makeAdapterConfig,
  mintTokens,
  HARDHAT_KEYS,
  type HardhatContext,
} from '../../chain/test/hardhat-harness.js';
import { buildSeal, buildUpdateSeal } from './_helpers/seal.js';
import { makeHardhatReceiverACKProvider, makeHardhatUpdateACKProvider } from './_helpers/acks.js';
import { makeTestKaAllocator } from './_helpers/ka-allocator.js';

const HARDHAT_PORT = 8549;
const ENTITY = 'urn:greenfield-e2e:asset';

function q(s: string, p: string, o: string, graph: string): Quad {
  return { subject: s, predicate: p, object: o, graph };
}

let ctx: HardhatContext;
let publisher: DKGPublisher;
let chain: EVMChainAdapter;
let author: Wallet;
let contextGraphId: string;
let dataGraph: string;
let kav10Address: string;
let ackProvider: ReturnType<typeof makeHardhatReceiverACKProvider>;
let updateAckProvider: ReturnType<typeof makeHardhatUpdateACKProvider>;

describe('Greenfield KA update E2E (explicit owner seal)', () => {
  beforeAll(async () => {
    ctx = await spawnHardhatEnv(HARDHAT_PORT);

    author = new Wallet(HARDHAT_KEYS.CORE_OP, ctx.provider);
    await mintTokens(
      ctx.provider,
      ctx.hubAddress,
      HARDHAT_KEYS.DEPLOYER,
      author.address,
      ethers.parseEther('500000'),
    );

    chain = new EVMChainAdapter(
      makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.CORE_OP),
    );

    const cgResult = await chain.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
    });
    if (!cgResult.success || cgResult.contextGraphId <= 0n) {
      throw new Error(`Failed to create on-chain context graph: ${JSON.stringify(cgResult)}`);
    }
    contextGraphId = String(cgResult.contextGraphId);
    dataGraph = `did:dkg:context-graph:${contextGraphId}`;

    kav10Address = await chain.getKnowledgeAssetsLifecycleAddress();
    ackProvider = makeHardhatReceiverACKProvider(
      ctx,
      kav10Address,
      [HARDHAT_KEYS.REC1_OP, HARDHAT_KEYS.REC2_OP, HARDHAT_KEYS.REC3_OP],
    );
    updateAckProvider = makeHardhatUpdateACKProvider(
      ctx,
      chain,
      [HARDHAT_KEYS.REC1_OP, HARDHAT_KEYS.REC2_OP, HARDHAT_KEYS.REC3_OP],
    );

    const store = new OxigraphStore();
    const bus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();

    publisher = new DKGPublisher({
      store,
      chain,
      eventBus: bus,
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(ctx.coreProfileId),
      publisherAddress: author.address,
      // OT-RFC-43 Option-1: real EVM adapter requires a packed reservedKaId per mint.
      kaAllocator: makeTestKaAllocator(),
    });
  }, 120_000);

  afterAll(() => {
    killHardhat(ctx);
  });

  it('publish → off-band update seal → update → verifyKAUpdate with stable UAL', async () => {
    const publishQuads = [
      q(ENTITY, 'http://schema.org/name', '"v1"', dataGraph),
    ];

    const publishSeal = await buildSeal({
      quads: publishQuads,
      author,
      contextGraphId,
      ctx: { provider: ctx.provider, kav10Address },
    });

    const published = await publisher.publish({
      contextGraphId,
      quads: publishQuads,
      precomputedAttestation: publishSeal,
      v10ACKProvider: ackProvider,
    });

    expect(published.status).toBe('confirmed');
    expect(published.kaManifest).toHaveLength(1);
    expect(published.onChainResult).toBeDefined();

    const kaId = published.onChainResult!.batchId;
    const storageAddr = await chain.getDKGKnowledgeAssetsAddress();
    const expectedUal = buildKnowledgeAssetUal(chain.chainId, storageAddr, kaId);
    expect(published.ual).toBe(expectedUal);

    const updateQuads = [
      q(ENTITY, 'http://schema.org/name', '"v2"', dataGraph),
      q(ENTITY, 'http://schema.org/version', '"2"', dataGraph),
    ];

    const updateSeal = await buildUpdateSeal({
      kaId,
      quads: updateQuads,
      author,
      ctx: { provider: ctx.provider, kav10Address },
    });

    const updated = await publisher.update(kaId, {
      contextGraphId,
      quads: updateQuads,
      precomputedUpdateAttestation: updateSeal,
      v10UpdateACKProvider: updateAckProvider,
    });

    expect(updated.status).toBe('confirmed');
    expect(updated.onChainResult).toBeDefined();
    expect(updated.onChainResult!.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(updated.onChainResult!.batchId).toBe(kaId);
    expect(updated.ual).toBe(expectedUal);
    expect(Buffer.from(updated.merkleRoot).toString('hex')).toBe(
      Buffer.from(updateSeal.expectedNewMerkleRoot).toString('hex'),
    );
    expect(Buffer.from(updated.merkleRoot).toString('hex')).not.toBe(
      Buffer.from(published.merkleRoot).toString('hex'),
    );

    const onChainRoot = await chain.getLatestMerkleRoot(kaId);
    expect(Buffer.from(onChainRoot).toString('hex')).toBe(
      Buffer.from(updateSeal.expectedNewMerkleRoot).toString('hex'),
    );

    const verified = await chain.verifyKAUpdate(
      updated.onChainResult!.txHash,
      kaId,
      author.address,
    );
    expect(verified.verified).toBe(true);
    expect(verified.onChainMerkleRoot).toBeDefined();
    expect(Buffer.from(verified.onChainMerkleRoot!).toString('hex')).toBe(
      Buffer.from(updateSeal.expectedNewMerkleRoot).toString('hex'),
    );
    expect(verified.blockNumber).toBeGreaterThan(0);
  }, 90_000);

  it('rejects update when precomputedUpdateAttestation is omitted', async () => {
    const publishQuads = [q(ENTITY + ':noseal', 'http://schema.org/name', '"only"', dataGraph)];
    const publishSeal = await buildSeal({
      quads: publishQuads,
      author,
      contextGraphId,
      ctx: { provider: ctx.provider, kav10Address },
    });

    const published = await publisher.publish({
      contextGraphId,
      quads: publishQuads,
      precomputedAttestation: publishSeal,
      v10ACKProvider: ackProvider,
    });
    expect(published.status).toBe('confirmed');

    const kaId = published.onChainResult!.batchId;
    const updateQuads = [
      q(ENTITY + ':noseal', 'http://schema.org/name', '"nope"', dataGraph),
    ];

    await expect(
      publisher.update(kaId, { contextGraphId, quads: updateQuads }),
    ).rejects.toThrow(/precomputedUpdateAttestation/i);
  }, 60_000);

  it('rejects update when the seal merkle root does not match recomputed quads', async () => {
    const publishQuads = [
      q(ENTITY + ':mismatch', 'http://schema.org/name', '"seed"', dataGraph),
    ];
    const publishSeal = await buildSeal({
      quads: publishQuads,
      author,
      contextGraphId,
      ctx: { provider: ctx.provider, kav10Address },
    });

    const published = await publisher.publish({
      contextGraphId,
      quads: publishQuads,
      precomputedAttestation: publishSeal,
      v10ACKProvider: ackProvider,
    });
    expect(published.status).toBe('confirmed');

    const kaId = published.onChainResult!.batchId;
    const honestQuads = [
      q(ENTITY + ':mismatch', 'http://schema.org/name', '"honest"', dataGraph),
    ];
    const staleSeal = await buildUpdateSeal({
      kaId,
      quads: [q(ENTITY + ':mismatch', 'http://schema.org/name', '"stale"', dataGraph)],
      author,
      ctx: { provider: ctx.provider, kav10Address },
    });

    await expect(
      publisher.update(kaId, {
        contextGraphId,
        quads: honestQuads,
        precomputedUpdateAttestation: staleSeal,
      }),
    ).rejects.toThrow(/expectedNewMerkleRoot mismatch/i);
  }, 60_000);
});
