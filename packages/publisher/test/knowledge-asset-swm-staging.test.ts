import { describe, expect, it } from 'vitest';

import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';

import {
  resolveKnowledgeAssetOperationPublicQuads,
  resolveKnowledgeAssetWorkspaceHead,
} from '../src/workspace-resolution.js';
import { stageKnowledgeAssetSharedWorkingMemoryV1 } from '../src/knowledge-asset-swm-staging.js';

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
  it('serializes overlapping stages through the complete consumer lifecycle', async () => {
    const store = new OxigraphStore();
    const graphManager = new GraphManager(store);
    const writeLocks = new Map<string, Promise<void>>();
    const firstConsumerEntered = Promise.withResolvers<void>();
    const releaseFirstConsumer = Promise.withResolvers<void>();
    let secondConsumerEntered = false;

    const first = stageKnowledgeAssetSharedWorkingMemoryV1({
      store,
      writeLocks,
      graphManager,
      contextGraphId: CONTEXT_GRAPH_ID,
      kaUal: UAL,
      assertionVersion: VERSION,
      shareOperationId: 'operation-a',
      quads: A,
      privateTripleCount: 0,
      timestamp: new Date('2026-07-19T12:00:00.000Z'),
    }, async (staged) => {
      firstConsumerEntered.resolve();
      await releaseFirstConsumer.promise;
      return staged;
    });
    await firstConsumerEntered.promise;

    const second = stageKnowledgeAssetSharedWorkingMemoryV1({
      store,
      writeLocks,
      graphManager,
      contextGraphId: CONTEXT_GRAPH_ID,
      kaUal: UAL,
      assertionVersion: VERSION,
      shareOperationId: 'operation-b',
      quads: B,
      privateTripleCount: 0,
      timestamp: new Date('2026-07-19T12:00:01.000Z'),
    }, async (staged) => {
      secondConsumerEntered = true;
      return staged;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(secondConsumerEntered).toBe(false);
    const headWhileFirstConsumes = await resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH_ID,
      kaUal: UAL,
    });
    expect(headWhileFirstConsumes?.shareOperationId).toBe('operation-a');
    expect(await readGraphObjects(store, headWhileFirstConsumes!.assertionGraph)).toEqual(['"a"']);

    releaseFirstConsumer.resolve();
    await Promise.all([first, second]);

    const finalHead = await resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH_ID,
      kaUal: UAL,
    });
    expect(finalHead?.shareOperationId).toBe('operation-b');
    expect(await readGraphObjects(store, finalHead!.assertionGraph)).toEqual(['"b"']);
    const finalSnapshot = await resolveKnowledgeAssetOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH_ID,
      shareOperationId: 'operation-b',
      kaUal: UAL,
      assertionVersion: VERSION,
    });
    expect(finalSnapshot.quads).toMatchObject(B);
    expect(writeLocks.size).toBe(0);
  });
});

async function readGraphObjects(store: OxigraphStore, graph: string): Promise<string[]> {
  const result = await store.query(
    `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`,
  );
  if (result.type !== 'quads') throw new Error(`unexpected ${result.type} result`);
  return result.quads.map((quad) => quad.object).sort();
}
