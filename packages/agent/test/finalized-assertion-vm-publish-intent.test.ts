import { describe, expect, it } from 'vitest';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  DKGPublisher,
  generateAssertionPromotedMetadata,
  resolveKnowledgeAssetWorkspaceHead,
  storeKnowledgeAssetOperationPublicQuads,
  storeKnowledgeAssetWorkspaceHead,
} from '@origintrail-official/dkg-publisher';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import type { DKGAgent } from '../src/dkg-agent.js';
import {
  CG,
  CURATOR,
  KA_UAL,
  MEMBER,
  MERKLE,
  NAME,
  PUBLIC_QUAD,
  RESERVED_KA_ID,
  sealFor,
  stubAgent,
} from './_helpers/foreign-author-resolution-fixtures.js';

describe('GH#1778 resolveFinalizedAssertionVmPublishIntent (async) auto-resolves the member author', () => {
  it('accepts an equivalent selected head alias for intent and queued preflight', async () => {
    const store = new OxigraphStore();
    await store.insert(sealFor(MEMBER));
    const graphManager = new GraphManager(store);
    const originalId = 'queued-original';
    const selectedAlias = 'storage-ack-alias';
    for (const [shareOperationId, accessPolicy, timestamp] of [
      [originalId, undefined, new Date('2026-09-10T00:00:00.000Z')],
      [selectedAlias, 'public', new Date('2026-09-10T00:00:01.000Z')],
    ] as const) {
      await storeKnowledgeAssetOperationPublicQuads({
        store,
        graphManager,
        contextGraphId: CG,
        shareOperationId,
        kaUal: KA_UAL,
        assertionVersion: 1,
        quads: [PUBLIC_QUAD],
        privateTripleCount: 0,
        publisherPeerId: 'publisher-peer',
        ...(accessPolicy === undefined ? {} : { accessPolicy }),
        agentAddress: MEMBER,
        timestamp,
      });
    }
    await storeKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId: originalId,
      kaUal: KA_UAL,
      assertionVersion: 1,
    });
    await store.insert([{
      subject: `${KA_UAL.toLowerCase()}#dkg-swm-head`,
      predicate: 'http://dkg.io/ontology/shareOperationId',
      object: JSON.stringify(selectedAlias),
      graph: graphManager.sharedMemoryMetaUri(CG),
    }]);
    await expect(resolveKnowledgeAssetWorkspaceHead({
      store, graphManager, contextGraphId: CG, kaUal: KA_UAL,
    })).resolves.toMatchObject({
      shareOperationId: selectedAlias,
      shareOperationIds: [originalId, selectedAlias],
      access: { kind: 'persisted', accessPolicy: 'public', allowedPeers: [] },
    });

    const sealRoot = `0x${Buffer.from(MERKLE).toString('hex')}`;
    const agent = stubAgent(store, CURATOR);
    agent.publisher = { hasSwmShareComplete: async () => true };
    agent.getCustodialAgentPrivateKey = () => undefined;
    Object.defineProperty(agent, 'assertion', {
      value: {
        history: async () => ({
          events: [],
          currentShareOperationId: originalId,
          wmCurrentAssertion: sealRoot,
          swmCurrentAssertion: sealRoot,
        }),
      },
      configurable: true,
    });

    const intent = await agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME);
    expect(intent.shareOperationId).toBe(originalId);
    await expect(agent.preflightQueuedKnowledgeAssetVmPublishExecution(intent))
      .resolves.toEqual({ action: 'execute' });
  });

  it('rejects a standalone legacy-default head at admission and queued preflight', async () => {
    const store = new OxigraphStore();
    await store.insert(sealFor(MEMBER));
    const graphManager = new GraphManager(store);
    const shareOperationId = 'legacy-default-only';
    await storeKnowledgeAssetOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId,
      kaUal: KA_UAL,
      assertionVersion: 1,
      quads: [PUBLIC_QUAD],
      privateTripleCount: 0,
      publisherPeerId: 'publisher-peer',
      agentAddress: MEMBER,
    });
    await storeKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId,
      kaUal: KA_UAL,
      assertionVersion: 1,
    });
    const sealRoot = `0x${Buffer.from(MERKLE).toString('hex')}`;
    const agent = stubAgent(store, CURATOR);
    agent.publisher = { hasSwmShareComplete: async () => true };
    agent.getCustodialAgentPrivateKey = () => undefined;
    Object.defineProperty(agent, 'assertion', {
      value: {
        history: async () => ({
          events: [],
          currentShareOperationId: shareOperationId,
          wmCurrentAssertion: sealRoot,
          swmCurrentAssertion: sealRoot,
        }),
      },
      configurable: true,
    });

    await expect(agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME))
      .rejects.toMatchObject({ code: 'PUBLISH_INTENT_STALE' });

    const operationSubject = `urn:dkg:share:${CG}:${shareOperationId}`;
    const accessPolicyRow = {
      subject: operationSubject,
      predicate: 'http://dkg.io/ontology/accessPolicy',
      object: '"public"',
      graph: graphManager.sharedMemoryMetaUri(CG),
    };
    await store.insert([accessPolicyRow]);
    const intent = await agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME);
    await store.deleteByPattern(accessPolicyRow);
    await expect(agent.preflightQueuedKnowledgeAssetVmPublishExecution(intent))
      .rejects.toMatchObject({ code: 'PUBLISH_INTENT_STALE' });
  });

  it.each([undefined, CURATOR])('returns a successful intent bound to the member seal (caller hint: %s)', async (callerAgentAddress) => {
    const store = new OxigraphStore();
    try {
      const publisher = new DKGPublisher({
        store, chain: new NoChainAdapter(), eventBus: new TypedEventBus(),
        keypair: await generateEd25519Keypair(),
      });
      const shareOperationId = 'member-authored-share';
      const merkleHex = Buffer.from(MERKLE).toString('hex');
      const promoted = generateAssertionPromotedMetadata({
        contextGraphId: CG, agentAddress: MEMBER, assertionName: NAME,
        kaNumber: 7, shareOperationId, rootEntities: [], merkleHex,
        timestamp: new Date('2026-01-01T00:00:00.000Z'),
      });
      await store.insert([
        ...sealFor(MEMBER),
        ...sealFor(CURATOR, 'unrelated-caller-asset'),
        ...promoted.insert,
      ]);
      await publisher.stageKnowledgeAssetSharedWorkingMemoryV1({
        contextGraphId: CG, kaUal: KA_UAL, assertionVersion: 1,
        shareOperationId, quads: [PUBLIC_QUAD], privateTripleCount: 0,
        accessPolicy: 'allowList', allowedPeers: ['peer-z', 'peer-a'],
      });
      await publisher.markSwmShareComplete(CG, NAME, MEMBER);
      const agent = stubAgent(store, CURATOR);
      agent.publisher = publisher;

      const intent: Awaited<ReturnType<DKGAgent['resolveFinalizedAssertionVmPublishIntent']>> =
        await agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME,
          callerAgentAddress === undefined ? undefined : { callerAgentAddress });
      expect(intent.agentAddress).toBe(MEMBER);
      expect(intent.agentAddress).not.toBe(CURATOR);
      expect(intent.callerAgentAddress).toBe(callerAgentAddress);
      expect(intent).toMatchObject({
        contextGraphId: CG, name: NAME, kaUal: KA_UAL.toLowerCase(),
        assertionVersion: '1', shareOperationId,
        accessPolicy: 'allowList', allowedPeers: ['peer-a', 'peer-z'],
        sealMerkleRoot: `0x${merkleHex}`,
        seal: {
          merkleRoot: `0x${merkleHex}`, authorAddress: MEMBER,
          reservedKaId: RESERVED_KA_ID.toString(), schemeVersion: 1,
          signature: { r: `0x${'01'.repeat(32)}`, vs: `0x${'02'.repeat(32)}` },
        },
      });
    } finally {
      await store.close();
    }
  });

  it('resolves the member author from _meta when the caller (curator) is not the author', async () => {
    const store = new OxigraphStore();
    await store.insert(sealFor(MEMBER));
    const agent = stubAgent(store, CURATOR);
    let historyAgent: string | undefined;
    Object.defineProperty(agent, 'assertion', {
      value: {
        history: async (_cg: string, _n: string, o: { agentAddress: string }) => {
          historyAgent = o.agentAddress;
          return null;
        },
      },
      configurable: true,
    });
    await expect(agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME))
      .rejects.toThrow(/is not finalized or does not exist/);
    expect(historyAgent).toBe(MEMBER);
  });
});
