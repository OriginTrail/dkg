// SPDX-License-Identifier: Apache-2.0

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { DKGAgent as RealDKGAgent, type DKGAgentConfig } from '../src/index.js';
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
  PUBLISH_PRICING_POLICY_UPDATE_UNSUPPORTED_CODE,
  measureCanonicalPublicationPayload,
  resolveKnowledgeAssetOperationPublicQuads,
  resolvePublicationPricing,
  TripleStoreAsyncLiftPublisher,
  type V10ACKProviderParams,
} from '@origintrail-official/dkg-publisher';
import { GraphManager, PrivateContentStore } from '@origintrail-official/dkg-storage';
import {
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import { installHardhatACKProvider } from './_helpers/v10-acks.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import {
  createKnowledgeAssetVmPublishIntentKey,
  type KnowledgeAssetVmPublishRequestWithoutIntentKey,
} from '../src/dkg-agent-publish.js';

type DKGAgent = RealDKGAgent;
const DKGAgent = {
  create(config: Parameters<typeof RealDKGAgent.create>[0]) {
    return RealDKGAgent.create({
      rfc64CatalogActivation: { enabled: false },
      ...config,
    });
  },
};

const agents: DKGAgent[] = [];
let chainSnapshot: string;

beforeAll(async () => {
  chainSnapshot = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOperator = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(
    provider,
    hubAddress,
    HARDHAT_KEYS.DEPLOYER,
    coreOperator.address,
    ethers.parseEther('50000000'),
  );
});

afterAll(async () => {
  await revertSnapshot(chainSnapshot);
});

afterEach(async () => {
  for (const agent of agents) {
    try {
      await agent.stop();
    } catch {
      // Best-effort fixture teardown.
    }
  }
  agents.length = 0;
});

async function createAgent(name: string, overrides: Partial<DKGAgentConfig> = {}) {
  const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
  const agent = await DKGAgent.create({
    ...overrides,
    kaNumberAllocator: makeTestKaNumberAllocator(),
    name,
    listenPort: 0,
    chainAdapter: chain,
    nodeRole: 'core',
  });
  agents.push(agent);
  await agent.start();
  await installHardhatACKProvider(agent, chain);
  return agent;
}

describe('agent publication pricing integration', () => {
  it('preserves the pre-pricing queued intent hash for a fixed legacy request', () => {
    const legacyRequest = {
      contextGraphId: 'legacy-context-graph',
      name: 'legacy-knowledge-asset',
      agentAddress: '0x1111111111111111111111111111111111111111',
      callerAgentAddress: '0x2222222222222222222222222222222222222222',
      subGraphName: 'legacy-subgraph',
      shareOperationId: 'legacy-share-operation',
      roots: ['urn:legacy:root:a', 'urn:legacy:root:b'],
      contentScopeVersion: 2,
      kaUal: 'did:dkg:hardhat:31337/0x3333333333333333333333333333333333333333/42',
      assertionVersion: '7',
      publicTripleCount: 11,
      privateMerkleRoot: `0x${'AB'.repeat(32)}`,
      privateTripleCount: 5,
      accessPolicy: 'allowList',
      allowedPeers: ['12D3KooWLegacyPeerA', '12D3KooWLegacyPeerB'],
      entityProofs: true,
      seal: {
        merkleRoot: `0x${'cd'.repeat(32)}`,
        authorAddress: '0x4444444444444444444444444444444444444444',
        signature: {
          r: `0x${'55'.repeat(32)}`,
          vs: `0x${'66'.repeat(32)}`,
        },
        schemeVersion: 1,
        reservedKaId: '123456789',
      },
      sealChainId: '31337',
      sealKav10Address: '0x7777777777777777777777777777777777777777',
      sealFinalizedAtIso: '2026-01-02T03:04:05.678Z',
      sealMerkleRoot: `0x${'EF'.repeat(32)}`,
      wmCurrentAssertion: 'wm-legacy-assertion',
      swmCurrentAssertion: 'swm-legacy-assertion',
      vmCurrentAssertion: '0xlegacy-vm-assertion',
      kaNumber: '42',
      reservedUal: 'did:dkg:hardhat:31337/0x3333333333333333333333333333333333333333/42',
      publishEpochs: 12,
      clearSharedMemoryAfter: true,
      publisherNodeIdentityIdOverride: '9',
    } satisfies KnowledgeAssetVmPublishRequestWithoutIntentKey;

    // Golden value produced by the exact pre-pricing canonical projection.
    // callerAgentAddress was already deliberately excluded from that projection.
    expect(createKnowledgeAssetVmPublishIntentKey(legacyRequest)).toBe(
      'sha256:6539905940eff8e5a181f014902f367d08ac56516d4eef8ca035cfafcc9844a1',
    );
  });

  it('forwards full-content pricing through public publish and publishAsync entry points', async () => {
    const contextGraphId = 'publication-pricing-public-api';
    const agent = await createAgent('FullContentPricingPublicApiBot');
    await agent.createContextGraph({ id: contextGraphId, name: 'Full-content public API' });
    await agent.registerContextGraph(contextGraphId);

    const chain = (agent as any).chain;
    const planSpy = vi.spyOn(chain, 'resolvePublisherPublishPlan');
    const createSpy = vi.spyOn(chain, 'createKnowledgeAssets');
    const ackInputs: V10ACKProviderParams[] = [];
    const baseAckProvider = (agent as any).createV10ACKProvider(contextGraphId);
    Object.defineProperty(agent, 'createV10ACKProvider', {
      configurable: true,
      value: () => async (params: V10ACKProviderParams) => {
        ackInputs.push(params);
        return baseAckProvider(params);
      },
    });

    const content = (suffix: string) => {
      const subject = `urn:test:publication-pricing:public-api:${suffix}`;
      return {
        publicQuads: [{
          subject,
          predicate: 'http://schema.org/name',
          object: `"${suffix}"`,
          graph: '',
        }],
        privateQuads: [{
          subject,
          predicate: 'http://schema.org/description',
          object: `"${`private-${suffix}-`.repeat(128)}"`,
          graph: '',
        }],
      };
    };
    const assertLatestPublicBoundary = async () => {
      expect(planSpy).toHaveBeenCalledTimes(1);
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(ackInputs).toHaveLength(1);
      const plan = planSpy.mock.calls[0]![0];
      const transaction = createSpy.mock.calls[0]![0];
      const ack = ackInputs[0]!;
      expect(plan.effectiveByteSize).toBe(plan.billableByteSize);
      expect(plan.billableByteSize).toBeGreaterThan(ack.publicByteSize);
      const expectedTokenAmount = await chain.getRequiredPublishTokenAmount(
        plan.billableByteSize,
        ack.epochs,
      );
      expect(ack.tokenAmount).toBe(expectedTokenAmount);
      expect(transaction.byteSize).toBe(ack.publicByteSize);
      expect(transaction.tokenAmount).toBe(expectedTokenAmount);
    };

    try {
      const directContent = content('sync');
      const direct = await agent.publish(
        contextGraphId,
        directContent.publicQuads,
        directContent.privateQuads,
        { pricingPolicy: 'full-content' },
      );
      expect(direct.status).toBe('confirmed');
      await assertLatestPublicBoundary();

      planSpy.mockClear();
      createSpy.mockClear();
      ackInputs.length = 0;

      const queuedContent = content('async');
      const accepted = await agent.publishAsync(
        contextGraphId,
        queuedContent,
        { pricingPolicy: 'full-content' },
      );
      const queue = new TripleStoreAsyncLiftPublisher(agent.store, {
        publicSnapshotStore: (agent as any).publicSnapshotStore,
        knowledgeAssetVmPublishHandler: {
          preflight: ({ request }) =>
            agent.preflightQueuedKnowledgeAssetVmPublishExecution(request),
          execute: ({ request, publishOptions }) =>
            agent.publishQueuedKnowledgeAssetVmPublish(request, publishOptions),
        },
      });
      const persisted = await queue.list();
      const acceptedJob = persisted.find((job) => job.jobId === accepted.captureID);
      expect(acceptedJob?.status).toBe('accepted');
      const persistedVmRequest = (acceptedJob?.request as any)?.knowledgeAssetVmPublish;
      expect(persistedVmRequest?.pricingPolicy).toBe('full-content');
      expect(persistedVmRequest?.privateTripleCount).toBe(1);

      const processed = await queue.processNext('publication-pricing-public-api-worker');
      expect(processed?.jobId).toBe(accepted.captureID);
      expect(processed?.status).toBe('finalized');
      await assertLatestPublicBoundary();
    } finally {
      planSpy.mockRestore();
      createSpy.mockRestore();
    }
  }, 180_000);

  it('threads billable full-content bytes through real sync and queued publication', async () => {
    const contextGraphId = 'publication-pricing-boundary';
    const entityBase = 'urn:test:publication-pricing';
    const agent = await createAgent('FullContentPricingBoundaryBot');
    await agent.createContextGraph({ id: contextGraphId, name: 'Full-content pricing boundary' });
    await agent.registerContextGraph(contextGraphId);

    const chain = (agent as any).chain;
    const planSpy = vi.spyOn(chain, 'resolvePublisherPublishPlan');
    const createSpy = vi.spyOn(chain, 'createKnowledgeAssets');
    const ackInputs: V10ACKProviderParams[] = [];
    const baseAckProvider = (agent as any).createV10ACKProvider(contextGraphId);
    Object.defineProperty(agent, 'createV10ACKProvider', {
      configurable: true,
      value: () => async (params: V10ACKProviderParams) => {
        ackInputs.push(params);
        return baseAckProvider(params);
      },
    });

    const stage = async (name: string, suffix: string) => {
      const publicQuad = {
        subject: `${entityBase}:${suffix}`,
        predicate: 'http://schema.org/name',
        object: `"${suffix}"`,
        graph: '',
      };
      const privateQuad = {
        subject: publicQuad.subject,
        predicate: 'http://schema.org/description',
        object: `"${`private-${suffix}-`.repeat(128)}"`,
        graph: '',
      };
      await agent.assertion.create(contextGraphId, name);
      await agent.assertion.write(contextGraphId, name, [publicQuad]);
      await agent.publisher.assertionWritePrivate(
        contextGraphId,
        name,
        agent.defaultAgentAddress ?? agent.peerId,
        [privateQuad],
      );
      const promoted = await agent.assertion.promote(contextGraphId, name);
      expect(promoted.publishReady).toBe(true);
      const intent = await agent.resolveFinalizedAssertionVmPublishIntent(contextGraphId, name, {
        pricingPolicy: 'full-content',
      });
      const graph = knowledgeAssetLayerGraphUri(
        contextGraphId,
        MemoryLayer.VerifiableMemory,
        createGraphKnowledgeAssetScope(intent.kaUal!, Number(intent.assertionVersion!)),
      );
      const expectedPricing = resolvePublicationPricing({
        policy: 'full-content',
        networkVisibleByteSize: 0n,
        fullContentByteSize: measureCanonicalPublicationPayload({
          publicQuads: [publicQuad],
          privateQuads: [privateQuad],
          fallbackGraph: graph,
        }).fullContentByteSize,
      });
      return { intent, expectedBillableByteSize: expectedPricing.billableByteSize };
    };

    const assertCapturedPricing = async (expectedBillableByteSize: bigint) => {
      expect(planSpy).toHaveBeenCalledTimes(1);
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(ackInputs).toHaveLength(1);
      const plan = planSpy.mock.calls[0]![0];
      const transaction = createSpy.mock.calls[0]![0];
      const ack = ackInputs[0]!;
      const expectedTokenAmount = await chain.getRequiredPublishTokenAmount(
        expectedBillableByteSize,
        ack.epochs,
      );
      expect(plan.billableByteSize).toBe(expectedBillableByteSize);
      expect(ack.publicByteSize).toBeLessThan(expectedBillableByteSize);
      expect(ack.tokenAmount).toBe(expectedTokenAmount);
      expect(transaction.byteSize).toBe(ack.publicByteSize);
      expect(transaction.tokenAmount).toBe(expectedTokenAmount);
    };

    try {
      const synchronous = await stage('full-content-sync', 'sync');
      const syncResult = await agent.publishFromFinalizedAssertion(
        contextGraphId,
        'full-content-sync',
        { pricingPolicy: 'full-content' },
      );
      expect(syncResult.status).toBe('confirmed');
      await assertCapturedPricing(synchronous.expectedBillableByteSize);

      planSpy.mockClear();
      createSpy.mockClear();
      ackInputs.length = 0;

      const queued = await stage('full-content-queued', 'queued');
      const publicSnapshot = await resolveKnowledgeAssetOperationPublicQuads({
        store: agent.store,
        graphManager: new GraphManager(agent.store),
        contextGraphId,
        shareOperationId: queued.intent.shareOperationId,
        kaUal: queued.intent.kaUal!,
        assertionVersion: queued.intent.assertionVersion!,
      });
      const queuedScope = createGraphKnowledgeAssetScope(
        queued.intent.kaUal!,
        Number(queued.intent.assertionVersion!),
      );
      const privateSnapshot = await new PrivateContentStore(
        agent.store,
        new GraphManager(agent.store),
      ).getKnowledgeAssetPrivateTriples(contextGraphId, queuedScope);

      const callerA = ethers.Wallet.createRandom().address;
      const callerB = ethers.Wallet.createRandom().address;
      const defaultIntentA = await agent.resolveFinalizedAssertionVmPublishIntent(
        contextGraphId,
        'full-content-queued',
        {
          callerAgentAddress: callerA,
          selectedAuthorAgentAddress: queued.intent.agentAddress!,
        },
      );
      const defaultIntentB = await agent.resolveFinalizedAssertionVmPublishIntent(
        contextGraphId,
        'full-content-queued',
        {
          callerAgentAddress: callerB,
          selectedAuthorAgentAddress: queued.intent.agentAddress!,
        },
      );
      expect(defaultIntentA.pricingPolicy).toBeUndefined();
      expect(defaultIntentA.callerAgentAddress).toBe(callerA);
      expect(defaultIntentB.callerAgentAddress).toBe(callerB);
      expect(defaultIntentA.intentKey).toBe(defaultIntentB.intentKey);
      expect(queued.intent.intentKey).not.toBe(defaultIntentA.intentKey);

      await expect(agent.publishQueuedKnowledgeAssetVmPublish(
        defaultIntentA,
        {
          quads: publicSnapshot.quads,
          privateQuads: privateSnapshot,
          publisherPeerId: publicSnapshot.publisherPeerId,
          pricingPolicy: 'full-content',
        },
      )).rejects.toMatchObject({
        code: 'PUBLISH_INTENT_STALE',
        message: expect.stringMatching(/immutable request captured pricingPolicy=network-visible/),
      });
      expect(planSpy).not.toHaveBeenCalled();
      expect(createSpy).not.toHaveBeenCalled();

      const queuedResult = await agent.publishQueuedKnowledgeAssetVmPublish(
        queued.intent,
        {
          quads: publicSnapshot.quads,
          privateQuads: privateSnapshot,
          publisherPeerId: publicSnapshot.publisherPeerId,
        },
      );
      expect(queuedResult.status).toBe('confirmed');
      await assertCapturedPricing(queued.expectedBillableByteSize);
    } finally {
      planSpy.mockRestore();
      createSpy.mockRestore();
    }
  }, 180_000);

  it('rejects full-content pricing on every real update boundary before side effects', async () => {
    const contextGraphId = 'publication-pricing-update';
    const agent = await createAgent('FullContentPricingUpdateGuardBot');
    await agent.createContextGraph({ id: contextGraphId, name: 'Full-content update guard' });
    await agent.registerContextGraph(contextGraphId);

    const name = 'full-content-update-rejected';
    const root = 'urn:test:publication-pricing:update';
    await agent.assertion.create(contextGraphId, name);
    await agent.assertion.write(contextGraphId, name, [{
      subject: root,
      predicate: 'http://schema.org/name',
      object: '"v1"',
    }]);
    await agent.assertion.promote(contextGraphId, name);
    expect((await agent.publishFromFinalizedAssertion(contextGraphId, name)).status)
      .toBe('confirmed');

    await agent.assertion.pullFrom(contextGraphId, name, 'vm', { onConflict: 'replace' });
    await agent.assertion.write(contextGraphId, name, [{
      subject: root,
      predicate: 'http://schema.org/description',
      object: '"v2"',
    }]);
    await agent.assertion.finalize(contextGraphId, name);
    const promoted = await agent.assertion.promote(contextGraphId, name);
    expect(promoted.publishReady).toBe(true);

    const chain = (agent as any).chain;
    const planSpy = vi.spyOn(chain, 'resolvePublisherPublishPlan');
    const updateSpy = vi.spyOn(chain, 'updateKnowledgeCollectionV10');
    const vmBefore = (await agent.assertion.history(contextGraphId, name))?.vmCurrentAssertion;
    const expectedError = {
      code: PUBLISH_PRICING_POLICY_UPDATE_UNSUPPORTED_CODE,
      message: expect.stringMatching(/initial VM publications/),
    };

    try {
      await expect(agent.resolveFinalizedAssertionVmPublishIntent(contextGraphId, name, {
        pricingPolicy: 'full-content',
      })).rejects.toMatchObject(expectedError);

      await expect(agent.publishFromFinalizedAssertion(contextGraphId, name, {
        pricingPolicy: 'full-content',
      })).rejects.toMatchObject(expectedError);

      const validIntent = await agent.resolveFinalizedAssertionVmPublishIntent(
        contextGraphId,
        name,
      );
      const publicSnapshot = await resolveKnowledgeAssetOperationPublicQuads({
        store: agent.store,
        graphManager: new GraphManager(agent.store),
        contextGraphId,
        shareOperationId: validIntent.shareOperationId,
        kaUal: validIntent.kaUal!,
        assertionVersion: validIntent.assertionVersion!,
      });
      await expect(agent.publishQueuedKnowledgeAssetVmPublish(
        { ...validIntent, pricingPolicy: 'full-content' },
        {
          quads: publicSnapshot.quads,
          publisherPeerId: publicSnapshot.publisherPeerId,
        },
      )).rejects.toMatchObject(expectedError);

      expect(planSpy).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
      expect((await agent.assertion.history(contextGraphId, name))?.vmCurrentAssertion)
        .toBe(vmBefore);
    } finally {
      planSpy.mockRestore();
      updateSpy.mockRestore();
    }
  }, 180_000);
});
