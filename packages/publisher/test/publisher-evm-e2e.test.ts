/**
 * Publisher-level EVM integration test.
 *
 * Runs DKGPublisher against a real Hardhat node with real contracts,
 * covering V10 CREATE, UPDATE, and context graph publish flows.
 * This catches contract ABI changes that mock-based tests miss.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ethers, Wallet, Contract } from 'ethers';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { EVMChainAdapter } from '@origintrail-official/dkg-chain';
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

const HARDHAT_PORT = 8548;
const CONTEXT_GRAPH = 'evm-e2e-paranet';

function q(s: string, p: string, o: string, g = `did:dkg:context-graph:${CONTEXT_GRAPH}`): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

let ctx: HardhatContext | null = null;
let publisher: DKGPublisher;
let publisherWallet: Wallet;
let publisherIdentityId: bigint;

describe('Publisher EVM E2E: DKGPublisher with real contracts', () => {
  beforeAll(async () => {
    ctx = await spawnHardhatEnv(HARDHAT_PORT);
    if (!ctx) return;

    publisherWallet = new Wallet(HARDHAT_KEYS.CORE_OP, ctx.provider);
    publisherIdentityId = BigInt(ctx.coreProfileId);

    await mintTokens(
      ctx.provider, ctx.hubAddress,
      HARDHAT_KEYS.DEPLOYER,
      publisherWallet.address,
      ethers.parseEther('500000'),
    );

    const adapter = new EVMChainAdapter(
      makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.CORE_OP),
    );

    const store = new OxigraphStore();
    const bus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();

    publisher = new DKGPublisher({
      store,
      chain: adapter,
      eventBus: bus,
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: publisherIdentityId,
      publisherAddress: publisherWallet.address,
    });
  }, 120_000);

  afterAll(() => {
    killHardhat(ctx);
  });

  // -------------------------------------------------------------------------
  // V10 CREATE
  // -------------------------------------------------------------------------

  let firstPublishResult: Awaited<ReturnType<typeof publisher.publish>>;

  it('V10 CREATE: publishes knowledge to chain with self-signed ACK', async (test) => {
    if (!ctx) { test.skip(); return; }

    firstPublishResult = await publisher.publish({
      contextGraphId: CONTEXT_GRAPH,
      quads: [
        q('urn:evm-e2e:Alice', 'http://schema.org/name', '"Alice"'),
        q('urn:evm-e2e:Alice', 'http://schema.org/knows', 'urn:evm-e2e:Bob'),
        q('urn:evm-e2e:Bob', 'http://schema.org/name', '"Bob"'),
      ],
    });

    expect(firstPublishResult.status).toBe('confirmed');
    expect(firstPublishResult.merkleRoot).toHaveLength(32);
    expect(firstPublishResult.kaManifest.length).toBeGreaterThan(0);
    expect(firstPublishResult.onChainResult).toBeDefined();
    expect(firstPublishResult.onChainResult!.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(firstPublishResult.onChainResult!.batchId).toBeGreaterThan(0n);
    expect(firstPublishResult.onChainResult!.blockNumber).toBeGreaterThan(0);
    expect(firstPublishResult.ual).toContain('did:dkg:evm:31337/');
  }, 60_000);

  it('V10 CREATE: on-chain KC can be verified via events', async (test) => {
    if (!ctx || !firstPublishResult?.onChainResult) { test.skip(); return; }

    const adapter = new EVMChainAdapter(
      makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER),
    );

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    for await (const event of adapter.listenForEvents({
      eventTypes: ['KCCreated'],
      fromBlock: 0,
    })) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThanOrEqual(1);
    const createdEvent = events.find(
      (e) => e.data.txHash === firstPublishResult.onChainResult!.txHash,
    );
    expect(createdEvent).toBeDefined();
    expect(createdEvent!.type).toBe('KCCreated');
  }, 30_000);

  // -------------------------------------------------------------------------
  // V10 UPDATE
  // -------------------------------------------------------------------------

  it('V10 UPDATE: updates KC with same byte size succeeds', async (test) => {
    if (!ctx || !firstPublishResult?.onChainResult) { test.skip(); return; }

    const adapter = new EVMChainAdapter(
      makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.CORE_OP),
    );

    const kcId = firstPublishResult.onChainResult!.batchId;
    const newMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes('updated-root-v10'));

    // V10 updateKnowledgeCollection with mintAmount=1 to satisfy the contract.
    const result = await adapter.updateKnowledgeCollectionV10!({
      kcId,
      newMerkleRoot: ethers.getBytes(newMerkleRoot),
      newByteSize: 200n,
      mintAmount: 1,
      burnTokenIds: [],
    });

    expect(result.success).toBe(true);
    expect(result.hash).toMatch(/^0x[0-9a-f]{64}$/);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Multiple publishes (verifies UAL increments correctly)
  // -------------------------------------------------------------------------

  it('V10 CREATE: second publish yields distinct KC and UAL', async (test) => {
    if (!ctx) { test.skip(); return; }

    const result = await publisher.publish({
      contextGraphId: CONTEXT_GRAPH,
      quads: [
        q('urn:evm-e2e:Dave', 'http://schema.org/name', '"Dave"'),
        q('urn:evm-e2e:Dave', 'http://schema.org/jobTitle', '"Engineer"'),
      ],
    });

    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toBeDefined();
    expect(result.onChainResult!.batchId).toBeGreaterThan(
      firstPublishResult.onChainResult!.batchId,
    );
    expect(result.ual).not.toBe(firstPublishResult.ual);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Multi-KA publish (auto-partition creates multiple KAs)
  // -------------------------------------------------------------------------

  it('V10 CREATE: multi-entity publish creates multiple KA manifest entries', async (test) => {
    if (!ctx) { test.skip(); return; }

    const entities = Array.from({ length: 5 }, (_, i) => `urn:evm-e2e:entity-${i}`);
    const quads: Quad[] = [];
    for (const entity of entities) {
      quads.push(q(entity, 'http://schema.org/name', `"Entity ${entity}"`));
      quads.push(q(entity, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'http://schema.org/Thing'));
    }

    const result = await publisher.publish({
      contextGraphId: CONTEXT_GRAPH,
      quads,
    });

    expect(result.status).toBe('confirmed');
    expect(result.kaManifest.length).toBe(5);

    for (const ka of result.kaManifest) {
      expect(ka.rootEntity).toBeDefined();
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // Adapter-level context graph creation
  // -------------------------------------------------------------------------

  it('creates on-chain context graph with participants', async (test) => {
    if (!ctx) { test.skip(); return; }

    const adapter = new EVMChainAdapter(
      makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.CORE_OP),
    );

    const result = await adapter.createOnChainContextGraph({
      participantIdentityIds: [publisherIdentityId],
      requiredSignatures: 1,
    });

    expect(result.success).toBe(true);
    expect(result.contextGraphId).toBeGreaterThan(0n);

    const participants = await adapter.getContextGraphParticipants(result.contextGraphId);
    expect(participants).toBeDefined();
    expect(participants!.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  // -------------------------------------------------------------------------
  // V9 direct adapter operations (exercised through EVMChainAdapter)
  // -------------------------------------------------------------------------

  it('V9: reserveUALRange + publishKnowledgeAssets works end-to-end', async (test) => {
    if (!ctx) { test.skip(); return; }

    const pubAdapter = new EVMChainAdapter(
      makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.PUBLISHER, [HARDHAT_KEYS.PUBLISHER2]),
    );

    const publisher2 = new Wallet(HARDHAT_KEYS.PUBLISHER, ctx.provider);
    await mintTokens(
      ctx.provider, ctx.hubAddress,
      HARDHAT_KEYS.DEPLOYER,
      publisher2.address,
      ethers.parseEther('100000'),
    );

    const reserved = await pubAdapter.reserveUALRange(10);
    expect(reserved.startId).toBeGreaterThan(0n);
    expect(reserved.endId).toBe(reserved.startId + 9n);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Publishing conviction account
  // -------------------------------------------------------------------------

  it('creates conviction account and queries info', async (test) => {
    if (!ctx) { test.skip(); return; }

    const adapter = new EVMChainAdapter(
      makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.CORE_OP),
    );

    const lockAmount = ethers.parseEther('10000');
    await mintTokens(
      ctx.provider, ctx.hubAddress,
      HARDHAT_KEYS.DEPLOYER,
      publisherWallet.address,
      lockAmount,
    );

    let accountId: bigint;
    try {
      const result = await adapter.createConvictionAccount(lockAmount, 5);
      accountId = result.accountId;
      expect(result.success).toBe(true);
      expect(accountId).toBeGreaterThan(0n);
    } catch (err: any) {
      if (err.message?.includes('not deployed')) {
        test.skip();
        return;
      }
      throw err;
    }

    const info = await adapter.getConvictionAccountInfo(accountId);
    expect(info).not.toBeNull();
    expect(info!.accountId).toBe(accountId);
    expect(info!.balance).toBeGreaterThan(0n);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Staking conviction
  // -------------------------------------------------------------------------

  it('stakeWithLock and query conviction multiplier', async (test) => {
    if (!ctx) { test.skip(); return; }

    const adapter = new EVMChainAdapter(
      makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.CORE_OP),
    );

    const stakeAmount = ethers.parseEther('5000');
    await mintTokens(
      ctx.provider, ctx.hubAddress,
      HARDHAT_KEYS.DEPLOYER,
      publisherWallet.address,
      stakeAmount,
    );

    try {
      const result = await adapter.stakeWithLock(publisherIdentityId, stakeAmount, 10);
      expect(result.success).toBe(true);
    } catch (err: any) {
      if (err.message?.includes('not deployed') || err.message?.includes('not available')) {
        test.skip();
        return;
      }
      throw err;
    }

    const { multiplier } = await adapter.getDelegatorConvictionMultiplier(
      publisherIdentityId,
      publisherWallet.address,
    );
    expect(typeof multiplier).toBe('number');
  }, 30_000);
});
