import { describe, expect, it, vi } from 'vitest';

import {
  TRUST_LEVEL_PREDICATE,
  TypedEventBus,
  WORKSPACE_OWNER_PREDICATE,
  generateEd25519Keypair,
} from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';

import { DKGPublisher } from '../src/dkg-publisher.js';
import type { StageKnowledgeAssetSharedWorkingMemoryInputV1 } from '../src/knowledge-asset-swm-staging.js';
import {
  resolveKnowledgeAssetOperationPublicQuads,
  resolveKnowledgeAssetWorkspaceHead,
} from '../src/workspace-resolution.js';
import type { WorkspacePublicSnapshotStore } from '../src/workspace-snapshot-store.js';

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

  it('rejects an older staged reference when its operation id is restaged with equal-count RDF', async () => {
    const store = new OxigraphStore();
    const publisher = new DKGPublisher({
      store,
      chain: { chainId: 'none' } as never,
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
    });
    const first = await publisher.stageKnowledgeAssetSharedWorkingMemoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      kaUal: UAL,
      assertionVersion: VERSION,
      shareOperationId: 'reused-operation',
      quads: A,
      privateTripleCount: 0,
    });
    await publisher.stageKnowledgeAssetSharedWorkingMemoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      kaUal: UAL,
      assertionVersion: VERSION,
      shareOperationId: 'reused-operation',
      quads: B,
      privateTripleCount: 0,
    });
    publisher.update = (async () => {
      throw new Error('stale reference must fail before publishing');
    }) as never;

    await expect(publisher.updateKnowledgeAssetFromStagedSharedWorkingMemoryV1(7n, {
      contextGraphId: CONTEXT_GRAPH_ID,
      privateQuads: [],
      contentScopeVersion: 2,
      kaUal: UAL,
      assertionVersion: VERSION,
      publicTripleCount: A.length,
      privateTripleCount: 0,
      stagedOperation: first,
    })).rejects.toThrow(/immutable reference/u);
  });

  it.each([
    { policy: 'ownerOnly', externalSnapshots: false },
    { policy: 'ownerOnly', externalSnapshots: true },
    { policy: 'allowList', externalSnapshots: false },
    { policy: 'allowList', externalSnapshots: true },
  ] as const)('reuses $policy intent without writes (external snapshots: $externalSnapshots)', async ({ policy, externalSnapshots }) => {
    const fixture = await createReusableOperation({
      accessPolicy: policy,
      ...(policy === 'allowList' ? { allowedPeers: ['peer-b', 'peer-a'] } : {}),
    }, externalSnapshots);
    const before = await resolveKnowledgeAssetWorkspaceHead(fixture.headInput);
    const assertNoWrites = trackStoreWrites(fixture.store);
    fixture.snapshotStore.putSnapshot.mockClear();

    const reused = await fixture.publisher.stageKnowledgeAssetSharedWorkingMemoryV1({
      ...fixture.input,
      // Peer equality follows queued validation's set-normalization contract.
      allowedPeers: policy === 'allowList' ? [' peer-a ', 'peer-b', 'peer-a', ''] : ['', ' '],
      timestamp: new Date('2026-09-05T12:00:00.000Z'),
      reuseExistingOperation: true,
    });

    expect(reused).toEqual(fixture.staged);
    expect(Object.isFrozen(reused)).toBe(true);
    expect(await resolveKnowledgeAssetWorkspaceHead(fixture.headInput)).toEqual(before);
    assertNoWrites();
    expect(fixture.snapshotStore.putSnapshot).not.toHaveBeenCalled();
    if (externalSnapshots) expect(fixture.snapshotStore.getSnapshot).toHaveBeenCalledOnce();
  });

  it.each([
    { field: 'share identity', changed: { shareOperationId: 'other-operation' } },
    { field: 'assertion version', changed: { assertionVersion: '3' } },
    { field: 'equal-count public content', changed: { quads: B } },
    { field: 'public count', changed: { quads: [...A, ...B] } },
    { field: 'private commitment', changed: { privateMerkleRoot: new Uint8Array(32).fill(9) } },
    { field: 'missing private commitment', changed: { privateMerkleRoot: undefined } },
    { field: 'private count', changed: { privateTripleCount: 2 } },
    { field: 'publisher', changed: { publisherPeerId: 'other-publisher' } },
    { field: 'missing publisher', changed: { publisherPeerId: undefined } },
    { field: 'access policy', changed: { accessPolicy: 'public' } },
    { field: 'missing access policy', changed: { accessPolicy: undefined } },
    { field: 'allowed peers', changed: { allowedPeers: ['peer-a', 'peer-c'] } },
  ] satisfies { field: string; changed: Partial<StageKnowledgeAssetSharedWorkingMemoryInputV1> }[])(
    'rejects changed $field without restoring metadata', async ({ changed }) => {
      const fixture = await createReusableOperation({ accessPolicy: 'allowList', allowedPeers: ['peer-a', 'peer-b'] }, true);
      const before = await resolveKnowledgeAssetWorkspaceHead(fixture.headInput);
      const assertNoWrites = trackStoreWrites(fixture.store);
      fixture.snapshotStore.putSnapshot.mockClear();

      await expect(fixture.publisher.stageKnowledgeAssetSharedWorkingMemoryV1({
        ...fixture.input,
        ...changed,
        reuseExistingOperation: true,
      })).rejects.toMatchObject({ code: 'PUBLISH_INTENT_STALE' });

      expect(await resolveKnowledgeAssetWorkspaceHead(fixture.headInput)).toEqual(before);
      assertNoWrites();
      expect(fixture.snapshotStore.putSnapshot).not.toHaveBeenCalled();
    },
  );

  it('preserves a newer head when the queued operation still exists', async () => {
    const fixture = await createReusableOperation();
    await fixture.publisher.stageKnowledgeAssetSharedWorkingMemoryV1({
      ...fixture.input,
      shareOperationId: 'newer-operation',
      quads: B,
    });
    const newerHead = await resolveKnowledgeAssetWorkspaceHead(fixture.headInput);
    const assertNoWrites = trackStoreWrites(fixture.store);

    await expect(fixture.publisher.stageKnowledgeAssetSharedWorkingMemoryV1({
      ...fixture.input,
      reuseExistingOperation: true,
    })).rejects.toMatchObject({ code: 'PUBLISH_INTENT_STALE' });

    expect(await resolveKnowledgeAssetWorkspaceHead(fixture.headInput)).toEqual(newerHead);
    expect(await readGraphObjects(fixture.store, newerHead!.assertionGraph)).toEqual(['"b"']);
    expect((await resolveKnowledgeAssetOperationPublicQuads({
      ...fixture.headInput,
      assertionVersion: VERSION,
      shareOperationId: fixture.input.shareOperationId,
    })).quads).toMatchObject(A);
    assertNoWrites();
  });

  it('does not recreate a missing head', async () => {
    const fixture = await createReusableOperation();
    await fixture.store.deleteByPattern({
      graph: fixture.graphManager.sharedMemoryMetaUri(CONTEXT_GRAPH_ID),
      subject: `${UAL}#dkg-swm-head`,
    });
    const assertNoWrites = trackStoreWrites(fixture.store);

    await expect(fixture.publisher.stageKnowledgeAssetSharedWorkingMemoryV1({
      ...fixture.input,
      reuseExistingOperation: true,
    })).rejects.toMatchObject({ code: 'PUBLISH_INTENT_STALE' });
    expect(await resolveKnowledgeAssetWorkspaceHead(fixture.headInput)).toBeUndefined();
    assertNoWrites();
  });

  it('rejects corrupted snapshot bytes without repairing them', async () => {
    const fixture = await createReusableOperation({}, true);
    fixture.snapshotStore.getSnapshot.mockResolvedValue([...B]);
    const assertNoWrites = trackStoreWrites(fixture.store);
    fixture.snapshotStore.putSnapshot.mockClear();

    await expect(fixture.publisher.stageKnowledgeAssetSharedWorkingMemoryV1({
      ...fixture.input,
      reuseExistingOperation: true,
    })).rejects.toThrow(/snapshot is missing or corrupt/u);
    assertNoWrites();
    expect(fixture.snapshotStore.putSnapshot).not.toHaveBeenCalled();
  });

  it.each(['head', 'snapshot'] as const)('preserves operational %s read errors', async (read) => {
    const fixture = await createReusableOperation({}, true);
    const error = Object.assign(new Error(`${read} temporarily unavailable`), { code: 'STORE_BUSY' });
    const assertNoWrites = trackStoreWrites(fixture.store);
    fixture.snapshotStore.putSnapshot.mockClear();
    if (read === 'head') vi.spyOn(fixture.store, 'query').mockRejectedValueOnce(error);
    else fixture.snapshotStore.getSnapshot.mockRejectedValueOnce(error);

    await expect(fixture.publisher.stageKnowledgeAssetSharedWorkingMemoryV1({
      ...fixture.input,
      reuseExistingOperation: true,
    })).rejects.toBe(error);
    assertNoWrites();
    expect(fixture.snapshotStore.putSnapshot).not.toHaveBeenCalled();
  });
});

async function createReusableOperation(
  overrides: Partial<StageKnowledgeAssetSharedWorkingMemoryInputV1> = {},
  externalSnapshots = false,
) {
  const store = new OxigraphStore();
  const graphManager = new GraphManager(store);
  const snapshots = new Map<string, Quad[]>();
  const snapshotStore = {
    putSnapshot: vi.fn<WorkspacePublicSnapshotStore['putSnapshot']>(async ({ digest, quads }) => {
      snapshots.set(digest, quads.map((quad) => ({ ...quad })));
      return { ref: digest, byteLength: 0 };
    }),
    getSnapshot: vi.fn<WorkspacePublicSnapshotStore['getSnapshot']>(async (digest) => snapshots.get(digest) ?? null),
  };
  const publisher = new DKGPublisher({
    store,
    chain: { chainId: 'none' } as never,
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
    ...(externalSnapshots ? { publicSnapshotStore: snapshotStore } : {}),
  });
  const input: StageKnowledgeAssetSharedWorkingMemoryInputV1 = {
    contextGraphId: CONTEXT_GRAPH_ID,
    kaUal: UAL,
    assertionVersion: VERSION,
    shareOperationId: 'queued-operation',
    quads: A,
    privateMerkleRoot: new Uint8Array(32).fill(7),
    privateTripleCount: 1,
    publisherPeerId: 'original-publisher',
    accessPolicy: 'ownerOnly',
    timestamp: new Date('2026-07-19T12:00:00.000Z'),
    ...overrides,
  };
  const staged = await publisher.stageKnowledgeAssetSharedWorkingMemoryV1(input);
  return {
    store,
    graphManager,
    publisher,
    snapshotStore,
    input,
    staged,
    headInput: { store, graphManager, contextGraphId: CONTEXT_GRAPH_ID, kaUal: UAL },
  };
}

function trackStoreWrites(store: OxigraphStore): () => void {
  const writes = ([
    'insert', 'delete', 'deleteByPattern', 'deleteByPatternWithoutCount',
    'createGraph', 'dropGraph', 'replaceGraph', 'replaceGraphAndSubject',
    'replaceSubject', 'deleteBySubjectPrefix', 'update',
  ] as const).map((method) => vi.spyOn(store, method));
  return () => {
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  };
}

async function readGraphObjects(store: OxigraphStore, graph: string): Promise<string[]> {
  const result = await store.query(
    `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`,
  );
  if (result.type !== 'quads') throw new Error(`unexpected ${result.type} result`);
  return result.quads.map((quad) => quad.object).sort();
}
