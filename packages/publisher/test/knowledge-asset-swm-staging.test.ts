import { describe, expect, it } from 'vitest';

import {
  TRUST_LEVEL_PREDICATE,
  TypedEventBus,
  WORKSPACE_OWNER_PREDICATE,
  generateEd25519Keypair,
} from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';

import { DKGPublisher } from '../src/dkg-publisher.js';
import {
  resolveKnowledgeAssetOperationPublicQuads,
  resolveKnowledgeAssetWorkspaceHead,
} from '../src/workspace-resolution.js';

const CONTEXT_GRAPH_ID = 'staging-lock-cg';
const UAL = 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/7';
const VERSION = '2';
const A: readonly Quad[] = Object.freeze([
  Object.freeze({ subject: 'urn:asset', predicate: 'urn:value', object: '"a"', graph: '' }),
]);
const B: readonly Quad[] = Object.freeze([
  Object.freeze({ subject: 'urn:asset', predicate: 'urn:value', object: '"b"', graph: '' }),
]);

describe('knowledge-asset SWM staging', () => {
  it('shares one store-scoped lock domain and preserves an older immutable operation', async () => {
    const store = new OxigraphStore();
    const graphManager = new GraphManager(store);
    const keypair = await generateEd25519Keypair();
    const publisherA = new DKGPublisher({
      store,
      chain: { chainId: 'none' } as never,
      eventBus: new TypedEventBus(),
      keypair,
    });
    const publisherB = new DKGPublisher({
      store,
      chain: { chainId: 'none' } as never,
      eventBus: new TypedEventBus(),
      keypair,
    });
    const firstReplaceEntered = Promise.withResolvers<void>();
    const releaseFirstReplace = Promise.withResolvers<void>();
    const replaceGraph = store.replaceGraph.bind(store);
    let replaceCalls = 0;
    store.replaceGraph = async (...args) => {
      replaceCalls += 1;
      if (replaceCalls === 1) {
        firstReplaceEntered.resolve();
        await releaseFirstReplace.promise;
      }
      return replaceGraph(...args);
    };

    const first = publisherA.stageKnowledgeAssetSharedWorkingMemoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      kaUal: UAL,
      assertionVersion: VERSION,
      shareOperationId: 'operation-a',
      quads: A,
      privateTripleCount: 0,
      timestamp: new Date('2026-07-19T12:00:00.000Z'),
    });
    await firstReplaceEntered.promise;

    const second = publisherB.stageKnowledgeAssetSharedWorkingMemoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      kaUal: UAL,
      assertionVersion: VERSION,
      shareOperationId: 'operation-b',
      quads: B,
      privateTripleCount: 0,
      timestamp: new Date('2026-07-19T12:00:01.000Z'),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(replaceCalls).toBe(1);
    releaseFirstReplace.resolve();
    const [firstRef] = await Promise.all([first, second]);

    const finalHead = await resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH_ID,
      kaUal: UAL,
    });
    expect(finalHead?.shareOperationId).toBe('operation-b');
    expect(await readGraphObjects(store, finalHead!.assertionGraph)).toEqual(['"b"']);
    const firstSnapshotAfterNewerStage = await resolveKnowledgeAssetOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH_ID,
      kaUal: UAL,
      assertionVersion: VERSION,
      shareOperationId: firstRef.shareOperationId,
    });
    expect(firstSnapshotAfterNewerStage.quads).toMatchObject(A);
    let consumedPublicQuads: readonly Quad[] = [];
    publisherA.update = (async (_kaId: bigint, options: { quads: readonly Quad[] }) => {
      consumedPublicQuads = options.quads;
      return { status: 'tentative' };
    }) as never;
    await publisherA.updateKnowledgeAssetFromStagedSharedWorkingMemoryV1(7n, {
      contextGraphId: CONTEXT_GRAPH_ID,
      privateQuads: [],
      contentScopeVersion: 2,
      kaUal: UAL,
      assertionVersion: VERSION,
      publicTripleCount: A.length,
      privateTripleCount: 0,
      stagedOperation: firstRef,
    });
    expect(consumedPublicQuads).toMatchObject(A);
    expect(replaceCalls).toBe(2);
  });

  it('keeps staged and live updates on the same filtered SWM Merkle input', async () => {
    const store = new OxigraphStore();
    const publisher = new DKGPublisher({
      store,
      chain: { chainId: 'none' } as never,
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
    });
    const content = A[0]!;
    const staged = await publisher.stageKnowledgeAssetSharedWorkingMemoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      kaUal: UAL,
      assertionVersion: VERSION,
      shareOperationId: 'filtered-operation',
      quads: [
        content,
        { subject: 'urn:asset', predicate: TRUST_LEVEL_PREDICATE, object: '"2"', graph: '' },
        { subject: 'urn:asset', predicate: WORKSPACE_OWNER_PREDICATE, object: 'urn:agent', graph: '' },
      ],
      privateTripleCount: 0,
    });
    expect(staged.tripleCount).toBe(1);

    const consumed: readonly Quad[][] = [];
    publisher.update = (async (_kaId: bigint, options: { quads: readonly Quad[] }) => {
      consumed.push(options.quads);
      return { status: 'tentative' };
    }) as never;
    const updateOptions = {
      contextGraphId: CONTEXT_GRAPH_ID,
      privateQuads: [],
      contentScopeVersion: 2,
      kaUal: UAL,
      assertionVersion: VERSION,
      publicTripleCount: 1,
      privateTripleCount: 0,
    } as const;
    await publisher.updateKnowledgeAssetFromStagedSharedWorkingMemoryV1(7n, {
      ...updateOptions,
      stagedOperation: staged,
    });
    await publisher.updateKnowledgeAssetFromSharedMemory(7n, updateOptions);

    expect(consumed).toHaveLength(2);
    expect(consumed[0]).toEqual(consumed[1]);
    expect(consumed[0]).toEqual([{ ...content, graph: '' }]);
  });
});

async function readGraphObjects(store: OxigraphStore, graph: string): Promise<string[]> {
  const result = await store.query(
    `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`,
  );
  if (result.type !== 'quads') throw new Error(`unexpected ${result.type} result`);
  return result.quads.map((quad) => quad.object).sort();
}
