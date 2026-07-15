import { describe, expect, it } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  DKG_ROOT_ENTITY_LEGACY,
  TypedEventBus,
  createOperationContext,
  generateEd25519Keypair,
} from '@origintrail-official/dkg-core';
import {
  GraphSetIndexStore,
  OxigraphStore,
  UnsupportedTripleStoreCapabilityError,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  DKGPublisher,
  generateOwnershipQuads,
  generateShareMetadata,
} from '../src/index.js';

const CONTEXT_GRAPH = 'cleanup-batching';
const SWM_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory`;
const SWM_META_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory_meta`;
const WORKSPACE_OWNER_PREDICATE = 'http://dkg.io/ontology/workspaceOwner';

function q(
  subject: string,
  predicate = 'http://schema.org/name',
  object = '"value"',
  graph = SWM_GRAPH,
): Quad {
  return { subject, predicate, object, graph };
}

async function makePublisher(store: TripleStore) {
  return new DKGPublisher({
    store,
    chain: new NoChainAdapter(),
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
  });
}

async function populateOneOperation(
  store: TripleStore,
  rootCount: number,
  suffix: string,
  survivor?: string,
) {
  const roots = Array.from(
    { length: rootCount },
    (_, index) => `urn:test:cleanup:${suffix}:${index}`,
  );
  const operationId = `operation-${suffix}`;
  const operation = `urn:dkg:share:${CONTEXT_GRAPH}:${operationId}`;
  const operationRoots = survivor ? [...roots, survivor] : roots;
  await store.insert([
    ...operationRoots.flatMap((root) => [
      q(root, 'http://schema.org/name', `"${root}"`),
      q(`${root}/.well-known/genid/child`, 'http://schema.org/name', '"child"'),
    ]),
    ...generateOwnershipQuads(
      operationRoots.map((rootEntity) => ({ rootEntity, creatorPeerId: 'peer-a' })),
      SWM_META_GRAPH,
    ),
    ...generateShareMetadata({
      shareOperationId: operationId,
      contextGraphId: CONTEXT_GRAPH,
      rootEntities: operationRoots,
      publisherPeerId: 'peer-a',
      timestamp: new Date(0),
    }, SWM_META_GRAPH),
  ]);
  return { roots, operation };
}

describe('confirmed shared-memory cleanup batching', () => {
  it.each([51, 200, 1_000])(
    'clears a populated one-operation %i-root fixture in two store updates',
    async (rootCount) => {
      const store = new OxigraphStore();
      const publisher = await makePublisher(store);
      const { roots, operation } = await populateOneOperation(
        store,
        rootCount,
        String(rootCount),
      );
      const updates: Array<{ sparql: string; source?: string }> = [];
      const originalUpdate = store.update.bind(store);
      store.update = async (sparql, options) => {
        updates.push({ sparql, source: options?.source });
        await originalUpdate(sparql, options);
      };

      await publisher.clearPublishedSwmRoots(
        CONTEXT_GRAPH,
        roots,
        undefined,
        createOperationContext('test'),
      );

      expect(updates.map((entry) => entry.source)).toEqual([
        'publisher.clearPublishedSwmRoots.data',
        'publisher.clearPublishedSwmRoots.metadata',
      ]);
      const metadataUpdate = updates[1].sparql;
      const candidateSubquery = metadataUpdate.indexOf(
        'COUNT(DISTINCT ?selectedRoot) AS ?selectedRootCount',
      );
      const operationTripleJoin = metadataUpdate.indexOf(
        `GRAPH <${SWM_META_GRAPH}> { ?operation ?predicate ?object }`,
        candidateSubquery,
      );
      expect(candidateSubquery).toBeGreaterThanOrEqual(0);
      expect(metadataUpdate).toContain('GROUP BY ?operation ?selectedRootCount');
      expect(operationTripleJoin).toBeGreaterThan(candidateSubquery);
      await expect(store.countQuads(SWM_GRAPH)).resolves.toBe(0);
      await expect(store.countQuads(SWM_META_GRAPH)).resolves.toBe(0);
      await expect(store.query(
        `ASK { GRAPH <${SWM_META_GRAPH}> { <${operation}> ?p ?o } }`,
      )).resolves.toEqual({ type: 'boolean', value: false });
    },
    60_000,
  );

  it('preserves one-operation headers and the member edge for an unconsumed root', async () => {
    const store = new OxigraphStore();
    const publisher = await makePublisher(store);
    const survivor = 'urn:test:cleanup:survivor';
    const { roots, operation } = await populateOneOperation(store, 51, 'subset', survivor);

    await publisher.clearPublishedSwmRoots(
      CONTEXT_GRAPH,
      roots,
      undefined,
      createOperationContext('test'),
    );

    await expect(store.query(
      `ASK { GRAPH <${SWM_META_GRAPH}> { <${operation}> <${DKG_ROOT_ENTITY_LEGACY}> <${survivor}> } }`,
    )).resolves.toEqual({ type: 'boolean', value: true });
    await expect(store.query(
      `ASK { GRAPH <${SWM_META_GRAPH}> { <${operation}> <http://dkg.io/ontology/shareOperationId> ?id } }`,
    )).resolves.toEqual({ type: 'boolean', value: true });
    await expect(store.query(
      `ASK { GRAPH <${SWM_META_GRAPH}> { <${survivor}> <${WORKSPACE_OWNER_PREDICATE}> ?owner } }`,
    )).resolves.toEqual({ type: 'boolean', value: true });
    await expect(store.query(
      `ASK { GRAPH <${SWM_GRAPH}> { <${survivor}> ?p ?o } }`,
    )).resolves.toEqual({ type: 'boolean', value: true });
  });

  it('falls back through GraphSetIndexStore typed unsupported-update signals', async () => {
    const base = new OxigraphStore();
    const { roots } = await populateOneOperation(base, 2, 'decorated-fallback');
    const serialCalls = {
      delete: 0,
      deleteByPattern: 0,
      deleteBySubjectPrefix: 0,
      typedUnsupported: 0,
    };
    const innerWithoutUpdate = new Proxy(base as unknown as TripleStore, {
      get(target, property, receiver) {
        if (property === 'update') return undefined;
        if (property === 'delete') {
          return async (...args: Parameters<TripleStore['delete']>) => {
            serialCalls.delete += 1;
            return target.delete(...args);
          };
        }
        if (property === 'deleteByPattern') {
          return async (...args: Parameters<TripleStore['deleteByPattern']>) => {
            serialCalls.deleteByPattern += 1;
            return target.deleteByPattern(...args);
          };
        }
        if (property === 'deleteBySubjectPrefix') {
          return async (...args: Parameters<TripleStore['deleteBySubjectPrefix']>) => {
            serialCalls.deleteBySubjectPrefix += 1;
            return target.deleteBySubjectPrefix(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const decoratedStore = new GraphSetIndexStore(innerWithoutUpdate);
    const originalDecoratedUpdate = decoratedStore.update.bind(decoratedStore);
    decoratedStore.update = async (...args) => {
      try {
        await originalDecoratedUpdate(...args);
      } catch (error) {
        expect(error).toBeInstanceOf(UnsupportedTripleStoreCapabilityError);
        serialCalls.typedUnsupported += 1;
        throw error;
      }
    };
    const publisher = await makePublisher(decoratedStore);

    await publisher.clearPublishedSwmRoots(
      CONTEXT_GRAPH,
      roots,
      undefined,
      createOperationContext('test'),
    );

    expect(serialCalls.typedUnsupported).toBe(2);
    expect(serialCalls.delete).toBeGreaterThan(0);
    expect(serialCalls.deleteByPattern).toBeGreaterThan(0);
    expect(serialCalls.deleteBySubjectPrefix).toBeGreaterThan(0);
    await expect(base.countQuads(SWM_GRAPH)).resolves.toBe(0);
    await expect(base.countQuads(SWM_META_GRAPH)).resolves.toBe(0);
  });

  it('propagates genuine decorated-store update failures without serial fallback', async () => {
    const base = new OxigraphStore();
    const { roots } = await populateOneOperation(base, 1, 'genuine-error');
    const updateFailure = new Error('update backend unavailable');
    let serialDeleteCalls = 0;
    const failingInner = new Proxy(base as unknown as TripleStore, {
      get(target, property, receiver) {
        if (property === 'update') return async () => { throw updateFailure; };
        if (property === 'deleteByPattern' || property === 'deleteBySubjectPrefix') {
          return async () => {
            serialDeleteCalls += 1;
            throw new Error('serial fallback must not run');
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const publisher = await makePublisher(new GraphSetIndexStore(failingInner));

    await expect(publisher.clearPublishedSwmRoots(
      CONTEXT_GRAPH,
      roots,
      undefined,
      createOperationContext('test'),
    )).rejects.toBe(updateFailure);

    expect(serialDeleteCalls).toBe(0);
    await expect(base.countQuads(SWM_GRAPH)).resolves.toBeGreaterThan(0);
  });

  it('rejects an unsafe cleanup IRI before dispatching a destructive update', async () => {
    const store = new OxigraphStore();
    const publisher = await makePublisher(store);
    const root = 'urn:test:cleanup:safe-root';
    await store.insert([q(root)]);
    let updateCalls = 0;
    store.update = async () => { updateCalls += 1; };

    await expect(publisher.clearPublishedSwmRoots(
      CONTEXT_GRAPH,
      [root, 'urn:test:unsafe>root'],
      undefined,
      createOperationContext('test'),
    )).rejects.toThrow(/Unsafe or empty IRI/);

    expect(updateCalls).toBe(0);
    await expect(store.countQuads(SWM_GRAPH)).resolves.toBe(1);
  });
});
