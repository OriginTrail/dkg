import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ethers, Wallet } from 'ethers';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import { DKGAgent } from '../src/index.js';
import { EVMChainAdapter } from '@origintrail-official/dkg-chain';
import {
  assertionLifecycleUri,
  contextGraphMetaUri,
  parseDeterministicKnowledgeAssetUal,
} from '@origintrail-official/dkg-core';
import type { KaNumberAllocator } from '../src/allocator.js';
import {
  spawnHardhatEnv,
  killHardhat,
  mintTokens,
  createNodeProfile,
  stakeAndSetAsk,
  makeAdapterConfig,
  HARDHAT_KEYS,
  type HardhatContext,
} from '../../chain/test/hardhat-harness.js';
import { seedContextGraphRegistration } from '../../chain/test/evm-test-context.js';

/**
 * OT-RFC-43 A2 + B3 — focused on-chain integration tests.
 *
 *  (a) finalize stamps dkg:kaId / dkg:reservedUal / dkg:wmCurrentAssertion on
 *      the LIFECYCLE URN, and publish mints EXACTLY that id (no double-alloc).
 *  (b) per-layer pointers + divergence: a second finalize (new content) makes
 *      wmCurrentAssertion != vmCurrentAssertion.
 *  (c) create-vs-update routing: publishing the SAME name twice does an UPDATE
 *      (vmCurrentAssertion already set) — the kaId is REUSED, not re-minted.
 *  (d) B3: resolve a KA by (agent, number) and by did:dkg UAL → same descriptor.
 *
 * These reuse the spawned-hardhat harness from e2e-chain.test.ts.
 */

const DKG = 'http://dkg.io/ontology/';
const WM_PRED = `${DKG}wmCurrentAssertion`;
const SWM_PRED = `${DKG}swmCurrentAssertion`;
const VM_PRED = `${DKG}vmCurrentAssertion`;
const KA_ID_PRED = `${DKG}kaId`;
const RESERVED_UAL_PRED = `${DKG}reservedUal`;

let ctx: HardhatContext;
const agents: DKGAgent[] = [];

function makeChainConfig(operationalKey: string, adminPrivateKey: string) {
  return {
    rpcUrl: ctx!.rpcUrl,
    adminPrivateKey,
    operationalKeys: [operationalKey],
    hubAddress: ctx!.hubAddress,
    chainId: 'evm:31337',
  };
}

const strip = (v?: string) => v?.replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '');

async function readPointer(agent: DKGAgent, lifecycleUri: string, metaGraph: string, pred: string): Promise<string | undefined> {
  const res = await (agent as any).store.query(
    `SELECT ?o WHERE { GRAPH <${metaGraph}> { <${lifecycleUri}> <${pred}> ?o } } LIMIT 1`,
  );
  if (res.type !== 'bindings' || res.bindings.length === 0) return undefined;
  return strip(res.bindings[0]['o']);
}

describe('OT-RFC-43 A2/B3 — finalize-stamp, divergence, create-vs-update, B3 (on-chain)', () => {
  let CG_ID: string;
  let agentAddress: string;
  let sharedAllocator: KaNumberAllocator;
  let chainAdapter: EVMChainAdapter | undefined;

  beforeAll(async () => {
    ctx = await spawnHardhatEnv(8551);
    // Two connected agent cores (mirrors e2e-chain.test.ts) so the V10 ACK
    // quorum is met and publishes reach `confirmed`. agentA is the publisher;
    // agentB just supplies ACKs.
    const idA = await createNodeProfile(ctx.provider, ctx.hubAddress, HARDHAT_KEYS.EXTRA1, HARDHAT_KEYS.EXTRA3, 'A2NodeA');
    const idB = await createNodeProfile(ctx.provider, ctx.hubAddress, HARDHAT_KEYS.EXTRA2, HARDHAT_KEYS.PUBLISHER2, 'A2NodeB');
    await stakeAndSetAsk(ctx.provider, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER, HARDHAT_KEYS.EXTRA1, idA);
    await stakeAndSetAsk(ctx.provider, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER, HARDHAT_KEYS.EXTRA2, idB);
    const nodeA = new Wallet(HARDHAT_KEYS.EXTRA1, ctx.provider);
    const nodeB = new Wallet(HARDHAT_KEYS.EXTRA2, ctx.provider);
    await mintTokens(ctx.provider, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER, nodeA.address, ethers.parseEther('500000'));
    await mintTokens(ctx.provider, ctx.hubAddress, HARDHAT_KEYS.DEPLOYER, nodeB.address, ethers.parseEther('500000'));

    sharedAllocator = makeTestKaNumberAllocator();
    const agent = await DKGAgent.create({
      kaNumberAllocator: sharedAllocator,
      name: 'A2NodeA',
      nodeRole: 'core',
      listenPort: 0,
      skills: [],
      chainConfig: makeChainConfig(HARDHAT_KEYS.EXTRA1, HARDHAT_KEYS.EXTRA3),
    });
    agents.push(agent);
    const agentB = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'A2NodeB',
      nodeRole: 'core',
      listenPort: 0,
      skills: [],
      chainConfig: makeChainConfig(HARDHAT_KEYS.EXTRA2, HARDHAT_KEYS.PUBLISHER2),
    });
    agents.push(agentB);
    await agent.start();
    await agentB.start();
    await agentB.connectTo(agent.multiaddrs[0]);
    await new Promise((r) => setTimeout(r, 2000));
    agentAddress = agent.defaultAgentAddress ?? agent.peerId;

    chainAdapter = new EVMChainAdapter(makeAdapterConfig(ctx.rpcUrl, ctx.hubAddress, HARDHAT_KEYS.EXTRA1));
    const cgResult = await chainAdapter.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1 });
    CG_ID = String(cgResult.contextGraphId);
    for (const a of agents) {
      await a.createContextGraph({ id: CG_ID, name: 'A2 ContextGraph' });
      const sub = (a as any).subscribedContextGraphs.get(CG_ID);
      if (sub) sub.onChainId = CG_ID;
      a.subscribeToContextGraph(CG_ID);
      // Mark the CG registered locally so the publisher's VM-publish guard
      // (registrationStatus check in publishFromSharedMemory) passes.
      await seedContextGraphRegistration((a as any).store, CG_ID);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }, 180_000);

  afterAll(async () => {
    for (const a of agents) {
      try { await a.stop(); } catch { /* best-effort */ }
    }
    try { await chainAdapter?.destroy(); } finally { killHardhat(ctx); }
  });

  it('preserves identity and addressing through finalize, publish, reopen and on-chain update', async () => {
    // (a) finalize stamps kaId/reservedUal/wmCurrentAssertion; publish mints EXACTLY that id (no double-allocation)
    {
      const agent = agents[0];
      const NAME = 'paper-1';
      const lifecycleUri = assertionLifecycleUri(CG_ID, agentAddress, NAME);
      const metaGraph = contextGraphMetaUri(CG_ID);

      await agent.assertion.create(CG_ID, NAME);
      await agent.assertion.write(CG_ID, NAME, [
        { subject: 'urn:a2:alice', predicate: 'http://schema.org/name', object: '"Alice"' },
      ]);
      const seal = await agent.assertion.finalize(CG_ID, NAME);

      // Finalize stamped the three values on the lifecycle URN.
      const stampedNumber = await readPointer(agent, lifecycleUri, metaGraph, KA_ID_PRED);
      const reservedUal = await readPointer(agent, lifecycleUri, metaGraph, RESERVED_UAL_PRED);
      const wmPointer = await readPointer(agent, lifecycleUri, metaGraph, WM_PRED);
      expect(stampedNumber).toBeDefined();
      expect(reservedUal).toContain(`/${agentAddress.toLowerCase()}/${stampedNumber}`);
      expect(wmPointer).toBe(ethers.hexlify(seal.merkleRoot).slice(2));

      // The expected FULL packed id the publish must mint.
      const expectedPacked = (BigInt(ethers.getAddress(agentAddress)) << 96n) | BigInt(stampedNumber!);

      await agent.assertion.promote(CG_ID, NAME);
      const pub = await agent.publishFromFinalizedAssertion(CG_ID, NAME);
      expect(pub.status).toBe('confirmed');
      // Minted exactly the finalize-stamped id (re-pack), no second allocation.
      expect(pub.kaId).toBe(expectedPacked);
      expect(pub.onChainResult!.batchId).toBe(expectedPacked);

      // VM pointer stamped == WM pointer (same version, converged).
      const vmPointer = await readPointer(agent, lifecycleUri, metaGraph, VM_PRED);
      expect(vmPointer).toBe(wmPointer);
    }

    // (b) divergence: a NEW finalize advances WM ahead of VM (wmCurrentAssertion != vmCurrentAssertion)
    {
      const agent = agents[0];
      const NAME = 'paper-1';
      const lifecycleUri = assertionLifecycleUri(CG_ID, agentAddress, NAME);
      const metaGraph = contextGraphMetaUri(CG_ID);

      // Reopen the published VM revision through the current public lifecycle API.
      // The existing identity and VM pointer must survive the new WM revision.
      const reopened = await agent.assertion.pullFrom(CG_ID, NAME, 'vm', { onConflict: 'replace' });
      expect(reopened.seeded).toBe(1);
      await agent.assertion.write(CG_ID, NAME, [
        { subject: 'urn:a2:alice', predicate: 'http://schema.org/name', object: '"Alice v2"' },
      ]);
      const seal2 = await agent.assertion.finalize(CG_ID, NAME);

      const wmPointer = await readPointer(agent, lifecycleUri, metaGraph, WM_PRED);
      const vmPointer = await readPointer(agent, lifecycleUri, metaGraph, VM_PRED);
      expect(wmPointer).toBe(ethers.hexlify(seal2.merkleRoot).slice(2));
      // VM is still on v1 — divergence is observable.
      expect(wmPointer).not.toBe(vmPointer);

      // The history facade surfaces both pointers + a per-layer status.
      const hist = await agent.assertion.history(CG_ID, NAME);
      expect(hist!.wmCurrentAssertion).toBe(wmPointer);
      expect(hist!.vmCurrentAssertion).toBe(vmPointer);
    }

    // (c) create-vs-update: publishing the SAME name twice does an UPDATE (kaId reused, not re-minted)
    {
      const agent = agents[0];
      const NAME = 'paper-1';
      const lifecycleUri = assertionLifecycleUri(CG_ID, agentAddress, NAME);
      const metaGraph = contextGraphMetaUri(CG_ID);

      const stampedNumber = await readPointer(agent, lifecycleUri, metaGraph, KA_ID_PRED);
      const vmBefore = await readPointer(agent, lifecycleUri, metaGraph, VM_PRED);
      // The minted kaId + confirmed-VM pointer survive the reopen of
      // the divergence step (assertionCreate preserves A2 identity), so the next
      // publish routes to UPDATE (vmCurrentAssertion set) reusing the SAME id.
      expect(stampedNumber).toBeDefined();
      expect(vmBefore).toBeDefined();
      const expectedPacked = (BigInt(ethers.getAddress(agentAddress)) << 96n) | BigInt(stampedNumber!);

      const sealedRoot = await readPointer(agent, lifecycleUri, metaGraph, WM_PRED);
      expect(sealedRoot).toBeDefined();
      await agent.assertion.promote(CG_ID, NAME);
      const pub2 = await agent.publishFromFinalizedAssertion(CG_ID, NAME);
      expect(pub2.status).toBe('confirmed');
      // UPDATE reuses the SAME kaId (no fresh mint).
      expect(pub2.kaId).toBe(expectedPacked);
      expect(await chainAdapter!.getMerkleRootCount(expectedPacked)).toBe(2n);
      expect(ethers.hexlify(await chainAdapter!.getLatestMerkleRoot(expectedPacked)).slice(2))
        .toBe(sealedRoot);

      // VM now points at the new merkle; the consumed WM draft is no longer active.
      const wmPointer = await readPointer(agent, lifecycleUri, metaGraph, WM_PRED);
      const vmPointer = await readPointer(agent, lifecycleUri, metaGraph, VM_PRED);
      expect(vmPointer).toBe(sealedRoot);
      expect(wmPointer).toBeUndefined();

      // prov:wasRevisionOf records the version chain.
      const revRes = await (agent as any).store.query(
        `SELECT ?prior WHERE { GRAPH <${metaGraph}> { <${lifecycleUri}> <http://www.w3.org/ns/prov#wasRevisionOf> ?prior } }`,
      );
      expect(revRes.type).toBe('bindings');
      expect(revRes.bindings.length).toBeGreaterThan(0);
    }

    // (d) B3: resolve by (agent, number) and by did:dkg UAL — same descriptor as by name
    {
      const agent = agents[0];
      const NAME = 'paper-1';
      const lifecycleUri = assertionLifecycleUri(CG_ID, agentAddress, NAME);
      const metaGraph = contextGraphMetaUri(CG_ID);
      const stampedNumber = await readPointer(agent, lifecycleUri, metaGraph, KA_ID_PRED);
      const packed = (BigInt(ethers.getAddress(agentAddress)) << 96n) | BigInt(stampedNumber!);

      const byName = await agent.assertion.history(CG_ID, NAME);
      const byKaId = await agent.assertion.resolveByKaId(CG_ID, packed);
      // (agent, number) → kaId resolves to the SAME lifecycle descriptor.
      expect(byKaId).toBeTruthy();
      expect(byKaId.name).toBe(byName!.name);
      expect(byKaId.vmCurrentAssertion).toBe(byName!.vmCurrentAssertion);
      expect(byKaId.kaNumber).toBe(byName!.kaNumber);

      // A did:dkg UAL carrying the same packed id resolves identically (the
      // public UAL parser recovers the author and number before resolution).
      const ual = await readPointer(agent, lifecycleUri, metaGraph, RESERVED_UAL_PRED);
      const parsed = parseDeterministicKnowledgeAssetUal(ual!);
      const fromUal = (BigInt(parsed.agentAddress) << 96n) | BigInt(parsed.kaNumber);
      expect(fromUal).toBe(packed);
      const byUal = await agent.assertion.resolveByKaId(CG_ID, fromUal);
      expect(byUal.name).toBe(byName!.name);
    }
  }, 240_000);
});
