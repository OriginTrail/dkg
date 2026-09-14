import { resolvePrivateSwmRecoveryBudgetMs } from '../src/sync/requester/private-swm-recovery-budget.js';
import { describe, expect, it, vi } from 'vitest';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  contextGraphWorkspaceMetaGraphUri,
  knowledgeAssetLayerGraphUri,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import {
  OxigraphStore,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  generateKnowledgeAssetShareMetadata,
  workspacePublicQuadsDigest,
} from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../src/index.js';

import {
  SwmTargetExecutorV1,
  SwmTargetExecutorSessionFactoryV1,
  type SwmTargetExecutorPortsV1,
} from '../src/sync/requester/swm-target-executor.js';
import { createSwmRecoveryMutationRuntimeV1 } from
  '../src/sync/requester/swm-recovery-apply.js';
import { MemoryWorkspaceSnapshotStore } from './_helpers/memory-workspace-snapshot-store.js';

describe('SWM target executor session factory', () => {
  it.each([
    { configuredBudgetMs: 0, expectedRounds: 1 },
    { configuredBudgetMs: 100, expectedRounds: 2 },
  ])('wires the $configuredBudgetMs ms environment budget through a real agent', async ({ configuredBudgetMs, expectedRounds }) => {
    vi.stubEnv('DKG_PRIVATE_SWM_RECOVERY_BUDGET_MS', String(configuredBudgetMs));
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const store = new OxigraphStore();
    const agent = await DKGAgent.create({
      name: `PrivateRecoveryBudget${configuredBudgetMs}`,
      listenHost: '127.0.0.1',
      listenPort: 0,
      chainAdapter: new MockChainAdapter(),
      store,
    });
    const fetchSyncPages = vi.spyOn(agent as any, 'fetchSyncPages').mockImplementation(async () => {
      elapsed += 60;
      return {
        quads: [], bytesReceived: 0, resumedFromOffset: 0, nextOffset: 0,
        checkpointKey: 'agent-composition:meta', completed: false, timedOut: true,
      };
    });
    try {
      const executor = (agent as any).createSwmTargetExecutorSessionV1() as SwmTargetExecutorV1;
      await executor.recoverPrivateTarget({
        remotePeerId: '12D3KooWAgentCompositionProvider',
        contextGraphId: 'agent-composition-cg',
      });
      expect(fetchSyncPages).toHaveBeenCalledTimes(expectedRounds);
    } finally {
      await store.close();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });

  it('reuses typed stable ports while isolating each session cache', async () => {
    const store = new OxigraphStore();
    const listSubGraphs = vi.fn(async () => []);
    const ports: SwmTargetExecutorPortsV1 = {
      privateRecoveryBudgetMs: resolvePrivateSwmRecoveryBudgetMs(),
      store,
      writeLocks: new Map(),
      listSubGraphs,
      createContextGraphSyncDeadline: () => Number.MAX_SAFE_INTEGER,
      fetchSyncPages: async (_ctx, _peer, _cg, _swm, phase) => ({
        quads: [],
        bytesReceived: 0,
        resumedFromOffset: 0,
        nextOffset: 0,
        checkpointKey: `factory:${phase}`,
        completed: true,
        timedOut: false,
      }),
      processSharedMemoryBatch: async () => ({
        verifiedData: [],
        verifiedMeta: [],
        totalFetchedDataQuads: 0,
        totalFetchedMetaQuads: 0,
        droppedDataTriples: 0,
        emptyResponses: 0,
        entityCreators: [],
      }),
      recordDrops: () => {},
      invalidateListContextGraphsCache: () => {},
      markMetaProjectionDirty: () => {},
      recoveryMutation: createSwmRecoveryMutationRuntimeV1({
        store,
        recordDrops: () => {},
        invalidateListContextGraphsCache: () => {},
        markMetaProjectionDirty: () => {},
      }),
      setCheckpoint: () => {},
      deleteCheckpoint: () => {},
      deletePublicCheckpoint: () => {},
      ensureOwnedMap: () => new Map(),
      retireFinalizedSwmTwin: async () => {},
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    };
    const factory = new SwmTargetExecutorSessionFactoryV1(ports);

    const first = factory.createSession();
    const second = factory.createSession();

    expect(first).toBeInstanceOf(SwmTargetExecutorV1);
    expect(second).toBeInstanceOf(SwmTargetExecutorV1);
    expect(second).not.toBe(first);
    await first.recoverPrivateTarget({
      remotePeerId: '12D3KooWFactoryProvider',
      contextGraphId: 'factory-cg',
    });
    await second.recoverPrivateTarget({
      remotePeerId: '12D3KooWFactoryProvider',
      contextGraphId: 'factory-cg',
    });
    expect(listSubGraphs).toHaveBeenCalledTimes(2);
    await store.close();
  });

  it('reuses exact materialization validation across sessions until the graph revision changes', async () => {
    vi.stubEnv('DKG_SWM_MATERIALIZATION_VALIDATION_MEMO', '1');
    const inner = new OxigraphStore();
    const contextGraphId = 'factory-validation-cg';
    const metaGraph = contextGraphWorkspaceMetaGraphUri(contextGraphId);
    const kaUal = 'did:dkg:hardhat:31337/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/31';
    const scope = createGraphKnowledgeAssetScope(kaUal, 1);
    const assertionGraph = knowledgeAssetLayerGraphUri(
      contextGraphId,
      MemoryLayer.SharedWorkingMemory,
      scope,
    );
    const payload: Quad[] = [
      { subject: 'urn:factory:one', predicate: 'urn:factory:value', object: '"one"', graph: '' },
      { subject: 'urn:factory:two', predicate: 'urn:factory:value', object: '"two"', graph: '' },
    ];
    const digest = workspacePublicQuadsDigest(payload);
    const operationId = 'factory-validation-operation';
    const operationSubject = `urn:dkg:share:${contextGraphId}:${operationId}`;
    const headSubject = `${kaUal}#dkg-swm-head`;
    const dkg = 'http://dkg.io/ontology/';
    const xsdInteger = 'http://www.w3.org/2001/XMLSchema#integer';
    const metadata: Quad[] = [
      ...generateKnowledgeAssetShareMetadata({
        shareOperationId: operationId,
        contextGraphId,
        kaUal,
        assertionVersion: 1,
        publicTripleCount: payload.length,
        privateTripleCount: 0,
        publisherPeerId: 'factory-provider',
        timestamp: new Date(0),
      }, metaGraph),
      {
        subject: operationSubject,
        predicate: `${dkg}publicQuadsDigest`,
        object: `"${digest}"`,
        graph: metaGraph,
      },
      {
        subject: operationSubject,
        predicate: `${dkg}publicSnapshotRef`,
        object: `"${digest}"`,
        graph: metaGraph,
      },
      {
        subject: headSubject,
        predicate: `${dkg}contentScopeVersion`,
        object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${xsdInteger}>`,
        graph: metaGraph,
      },
      { subject: headSubject, predicate: `${dkg}kaUal`, object: kaUal, graph: metaGraph },
      {
        subject: headSubject,
        predicate: `${dkg}assertionVersion`,
        object: `"1"^^<${xsdInteger}>`,
        graph: metaGraph,
      },
      {
        subject: headSubject,
        predicate: `${dkg}assertionGraph`,
        object: assertionGraph,
        graph: metaGraph,
      },
      {
        subject: headSubject,
        predicate: `${dkg}shareOperationId`,
        object: `"${operationId}"`,
        graph: metaGraph,
      },
    ];
    let counts = 0;
    let constructs = 0;
    const store = new Proxy(inner, {
      get(target, property, receiver) {
        if (property === 'query') {
          return async (...args: Parameters<TripleStore['query']>) => {
            const [sparql, options] = args;
            if (sparql.includes('SELECT (COUNT(*) AS ?n)')) counts += 1;
            if (
              options?.source === 'agent.sharedMemorySync.snapshotMaterializer.readGraph'
            ) {
              constructs += 1;
            }
            return target.query(...args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as TripleStore;
    const snapshotStore = new MemoryWorkspaceSnapshotStore();
    await snapshotStore.putSnapshot({ digest, quads: payload });
    await inner.replaceGraph(
      assertionGraph,
      payload.map((quad) => ({ ...quad, graph: assertionGraph })),
    );
    const ports: SwmTargetExecutorPortsV1 = {
      store,
      writeLocks: new Map(),
      listSubGraphs: async () => [],
      createContextGraphSyncDeadline: () => Number.MAX_SAFE_INTEGER,
      fetchSyncPages: async (_ctx, _peer, _cg, _swm, phase) => {
        const quads = phase === 'meta' ? metadata : [];
        return {
          quads,
          bytesReceived: 0,
          resumedFromOffset: 0,
          nextOffset: quads.length,
          checkpointKey: `factory-validation:${phase}`,
          completed: true,
          timedOut: false,
        };
      },
      processSharedMemoryBatch: async (data, meta) => ({
        verifiedData: data,
        verifiedMeta: meta,
        totalFetchedDataQuads: data.length,
        totalFetchedMetaQuads: meta.length,
        droppedDataTriples: 0,
        emptyResponses: 0,
        entityCreators: [],
      }),
      publicSnapshotStore: snapshotStore,
      recordDrops: () => {},
      invalidateListContextGraphsCache: () => {},
      markMetaProjectionDirty: () => {},
      recoveryMutation: createSwmRecoveryMutationRuntimeV1({
        store,
        recordDrops: () => {},
        invalidateListContextGraphsCache: () => {},
        markMetaProjectionDirty: () => {},
      }),
      setCheckpoint: () => {},
      deleteCheckpoint: () => {},
      deletePublicCheckpoint: () => {},
      ensureOwnedMap: () => new Map(),
      retireFinalizedSwmTwin: async () => {},
      logInfo: () => {},
      logWarn: () => {},
      logDebug: () => {},
    };
    const factory = new SwmTargetExecutorSessionFactoryV1(ports);
    const target = {
      ctx: { operationId: 'factory-validation', operationName: 'sync' } as OperationContext,
      remotePeerId: 'factory-provider',
      contextGraphId,
      remainingContextGraphs: 1,
      mode: { kind: 'ordinary' as const },
    };

    try {
      await factory.createSession().syncPublicTarget(target);
      await factory.createSession().syncPublicTarget(target);
      expect([counts, constructs]).toEqual([1, 1]);

      await inner.replaceGraph(
        assertionGraph,
        payload.map((quad) => ({ ...quad, graph: assertionGraph })),
      );
      await factory.createSession().syncPublicTarget(target);
      expect([counts, constructs]).toEqual([2, 2]);
    } finally {
      await inner.close();
      vi.unstubAllEnvs();
    }
  });
});
