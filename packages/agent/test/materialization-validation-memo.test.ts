/**
 * #1963 — bounded materialization validation against a real OxigraphStore.
 *
 * The memo is valid only while an all-writers revision source proves the
 * graph unchanged. Every weaker or indeterminate capability takes the exact
 * count-and-digest path.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  OxigraphStore,
  type GraphWriteRevision,
  type GraphWriteRevisionSource,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { workspacePublicQuadsDigest } from '@origintrail-official/dkg-publisher';
import {
  MaterializationValidationMemo,
} from '../src/sync/requester/materialization-validation-memo.js';
import type {
  GraphScopedSwmMaterializationDescriptor,
  GraphScopedSwmRecoveryDescriptor,
} from '../src/sync/graph-scoped-swm-recovery.js';
import { createSharedMemorySnapshotMaterializer } from
  '../src/sync/requester/swm-snapshot-materializer.js';

const GRAPH = 'did:dkg:context-graph:validation-cg/ka/1';

const stores: OxigraphStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => {})));
});

function newStore(): OxigraphStore {
  const store = new OxigraphStore();
  stores.push(store);
  return store;
}

function payload(marker: string, count: number): Quad[] {
  return Array.from({ length: count }, (_, index) => ({
    subject: `urn:snap:${marker}:${index}`,
    predicate: 'http://schema.org/status',
    object: `"${marker}"`,
    graph: '',
  }));
}

function materializationDescriptor(
  quads: readonly Quad[],
  assertionGraph = GRAPH,
): GraphScopedSwmRecoveryDescriptor {
  return {
    metaGraph: 'did:dkg:context-graph:validation-cg/_shared_memory_meta',
    headSubject: 'did:dkg:context-graph:validation-cg/ka/1#dkg-swm-head',
    operationSubject: 'did:dkg:context-graph:validation-cg/share/operation-1',
    kaUal: 'did:dkg:validation-cg/1',
    assertionVersion: '1',
    assertionGraph,
    shareOperationId: 'operation-1',
    publicQuadsCount: quads.length,
    publicQuadsDigest: workspacePublicQuadsDigest(quads),
    privateTripleCount: 0,
    publisherPeerId: 'peer-1',
    metadataQuads: [],
  };
}

function memoDescriptor(graph = GRAPH): GraphScopedSwmMaterializationDescriptor {
  return {
    assertionGraph: graph,
    publicQuadsDigest: `sha256:${'a'.repeat(64)}`,
    publicQuadsCount: 1,
  };
}

function revisionSource(
  getWriteRevision: () => GraphWriteRevision,
  coverage: 'all-writers' | 'process-local' = 'all-writers',
): GraphWriteRevisionSource {
  return {
    writeRevisionCoverage: coverage,
    getWriteRevision,
  };
}

function validationMemo(
  source: GraphWriteRevisionSource | null,
  options: { enabled?: boolean; maxEntries?: number } = {},
): MaterializationValidationMemo {
  return new MaterializationValidationMemo(source, {
    enabled: options.enabled ?? true,
    maxEntries: options.maxEntries,
  });
}

function countingStore(inner: TripleStore) {
  let constructs = 0;
  let counts = 0;
  const store = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'query') {
        return async (...args: Parameters<TripleStore['query']>) => {
          const [sparql] = args;
          if (sparql.trimStart().startsWith('CONSTRUCT')) constructs += 1;
          if (sparql.includes('SELECT (COUNT(*) AS ?n)')) counts += 1;
          return target.query(...args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as TripleStore;
  return { store, constructs: () => constructs, counts: () => counts };
}

function materializer(store: TripleStore) {
  return createSharedMemorySnapshotMaterializer({
    store,
    writeLocks: new Map<string, Promise<void>>(),
    invalidateListContextGraphsCache: () => {},
  });
}

describe('#1963 MaterializationValidationMemo', () => {
  it('reuses a successful validation while the all-writers revision is unchanged', async () => {
    const memo = validationMemo(
      revisionSource(() => ({ generation: 7, stable: true })),
    );
    const descriptor = memoDescriptor();
    let exactValidations = 0;
    let exactDescriptor: GraphScopedSwmMaterializationDescriptor | undefined;
    const exactValidation = async (validatedDescriptor: GraphScopedSwmMaterializationDescriptor) => {
      exactValidations += 1;
      exactDescriptor = validatedDescriptor;
      return true;
    };
    await expect(memo.validate(descriptor, exactValidation)).resolves.toBe(true);
    await expect(memo.validate(descriptor, exactValidation)).resolves.toBe(true);
    expect(exactValidations).toBe(1);
    expect(exactDescriptor).toBe(descriptor);
  });

  it('evicts the least recently used entry at its configured bound', async () => {
    const memo = validationMemo(
      revisionSource(() => ({ generation: 1, stable: true })),
      { maxEntries: 1 },
    );
    const descriptorA = memoDescriptor(`${GRAPH}:a`);
    const descriptorB = memoDescriptor(`${GRAPH}:b`);
    let validationsA = 0;
    let validationsB = 0;
    await memo.validate(descriptorA, async () => { validationsA += 1; return true; });
    await memo.validate(descriptorB, async () => { validationsB += 1; return true; });
    await memo.validate(descriptorA, async () => { validationsA += 1; return true; });
    await memo.validate(descriptorB, async () => { validationsB += 1; return true; });
    expect([validationsA, validationsB]).toEqual([2, 2]);
  });

  it.each([
    ['changed', { generation: 2, stable: true } as GraphWriteRevision],
    ['unstable', { generation: 1, stable: false } as GraphWriteRevision],
    ['unreadable', new Error('revision unavailable')],
  ])('does not populate when the final revision is %s', async (_name, finalRevision) => {
    let calls = 0;
    const memo = validationMemo(revisionSource(() => {
      calls += 1;
      if (calls === 1) return { generation: 1, stable: true };
      if (calls === 2) {
        if (finalRevision instanceof Error) throw finalRevision;
        return finalRevision;
      }
      return { generation: 2, stable: true };
    }));
    const descriptor = memoDescriptor();
    let validations = 0;
    const exactValidation = async () => { validations += 1; return true; };
    await expect(memo.validate(descriptor, exactValidation)).resolves.toBe(true);
    await expect(memo.validate(descriptor, exactValidation)).resolves.toBe(true);
    expect(validations).toBe(2);
  });

  it('does not cache a failed or throwing exact validation', async () => {
    const memo = validationMemo(
      revisionSource(() => ({ generation: 1, stable: true })),
    );
    const descriptor = memoDescriptor();
    await expect(memo.validate(descriptor, async () => false)).resolves.toBe(false);
    await expect(memo.validate(descriptor, async () => {
      throw new Error('exact validation failed');
    })).rejects.toThrow('exact validation failed');
    await expect(memo.validate(descriptor, async () => true)).resolves.toBe(true);
  });

  it('never memoizes a zero-count descriptor', async () => {
    const memo = validationMemo(
      revisionSource(() => ({ generation: 1, stable: true })),
    );
    const descriptor = { ...memoDescriptor(), publicQuadsCount: 0 };
    let validations = 0;
    const exactValidation = async () => { validations += 1; return true; };
    await expect(memo.validate(descriptor, exactValidation)).resolves.toBe(true);
    await expect(memo.validate(descriptor, exactValidation)).resolves.toBe(true);
    expect(validations).toBe(2);
  });
});

describe('#1963 isGraphAssetMaterialized validation memo', () => {
  it('avoids 75% of full queries across four unchanged passes', async () => {
    const inner = newStore();
    const quads = payload('v1', 6);
    await inner.replaceGraph(GRAPH, quads.map((quad) => ({ ...quad, graph: GRAPH })));
    const counted = countingStore(inner);
    const mat = materializer(counted.store);
    const descriptor = materializationDescriptor(quads);

    for (let pass = 0; pass < 4; pass += 1) {
      expect(await mat.isGraphAssetMaterialized(descriptor)).toBe(true);
    }

    expect([counted.counts(), counted.constructs()]).toEqual([1, 1]);
  });

  it('forces exact validation for a new materializer runtime', async () => {
    const inner = newStore();
    const quads = payload('v1', 6);
    await inner.replaceGraph(GRAPH, quads.map((quad) => ({ ...quad, graph: GRAPH })));
    const counted = countingStore(inner);
    const descriptor = materializationDescriptor(quads);

    expect(await materializer(counted.store).isGraphAssetMaterialized(descriptor)).toBe(true);
    expect(await materializer(counted.store).isGraphAssetMaterialized(descriptor)).toBe(true);
    expect([counted.counts(), counted.constructs()]).toEqual([2, 2]);
  });

  it('invalidates the same descriptor after an equal-count local graph mutation', async () => {
    const inner = newStore();
    const v1 = payload('v1', 6);
    const v2 = payload('v2', 6);
    await inner.replaceGraph(GRAPH, v1.map((quad) => ({ ...quad, graph: GRAPH })));
    const counted = countingStore(inner);
    const mat = materializer(counted.store);

    const descriptor = materializationDescriptor(v1);
    expect(await mat.isGraphAssetMaterialized(descriptor)).toBe(true);
    await inner.replaceGraph(GRAPH, v2.map((quad) => ({ ...quad, graph: GRAPH })));
    expect(await mat.isGraphAssetMaterialized(descriptor)).toBe(false);
    expect([counted.counts(), counted.constructs()]).toEqual([2, 2]);
  });

  it('does not reuse an entry after its own graph replacement', async () => {
    const inner = newStore();
    const v1 = payload('v1', 6);
    const v2 = payload('v2', 6);
    await inner.replaceGraph(GRAPH, v1.map((quad) => ({ ...quad, graph: GRAPH })));
    const counted = countingStore(inner);
    const mat = materializer(counted.store);

    expect(await mat.isGraphAssetMaterialized(materializationDescriptor(v1))).toBe(true);
    await mat.replaceGraph(GRAPH, v2.map((quad) => ({ ...quad, graph: GRAPH })));
    expect(await mat.isGraphAssetMaterialized(materializationDescriptor(v2))).toBe(true);
    expect([counted.counts(), counted.constructs()]).toEqual([2, 2]);
  });

  it('does not hit for mismatched descriptors or discard the verified entry on failure', async () => {
    const inner = newStore();
    const v1 = payload('v1', 6);
    const v2 = payload('v2', 6);
    await inner.replaceGraph(GRAPH, v1.map((quad) => ({ ...quad, graph: GRAPH })));
    const counted = countingStore(inner);
    const mat = materializer(counted.store);
    const descriptor = materializationDescriptor(v1);

    expect(await mat.isGraphAssetMaterialized(descriptor)).toBe(true);
    expect(await mat.isGraphAssetMaterialized(materializationDescriptor(v2))).toBe(false);
    expect(await mat.isGraphAssetMaterialized({
      ...descriptor,
      publicQuadsCount: descriptor.publicQuadsCount + 1,
    })).toBe(false);
    expect([counted.counts(), counted.constructs()]).toEqual([3, 2]);
    expect(await mat.isGraphAssetMaterialized(descriptor)).toBe(true);
    expect([counted.counts(), counted.constructs()]).toEqual([3, 2]);
  });

  it('never caches a failed digest validation', async () => {
    const inner = newStore();
    const v1 = payload('v1', 6);
    const v2 = payload('v2', 6);
    await inner.replaceGraph(GRAPH, v1.map((quad) => ({ ...quad, graph: GRAPH })));
    const counted = countingStore(inner);
    const mat = materializer(counted.store);
    const mismatched = materializationDescriptor(v2);

    expect(await mat.isGraphAssetMaterialized(mismatched)).toBe(false);
    expect(await mat.isGraphAssetMaterialized(mismatched)).toBe(false);
    expect([counted.counts(), counted.constructs()]).toEqual([2, 2]);
  });

  it('preserves the operator switch for disabling validation memoization', async () => {
    const previous = process.env['DKG_SWM_MATERIALIZATION_WITNESS'];
    process.env['DKG_SWM_MATERIALIZATION_WITNESS'] = '0';
    try {
      const inner = newStore();
      const quads = payload('v1', 6);
      await inner.replaceGraph(GRAPH, quads.map((quad) => ({ ...quad, graph: GRAPH })));
      const counted = countingStore(inner);
      const mat = materializer(counted.store);
      const descriptor = materializationDescriptor(quads);

      expect(await mat.isGraphAssetMaterialized(descriptor)).toBe(true);
      expect(await mat.isGraphAssetMaterialized(descriptor)).toBe(true);
      expect([counted.counts(), counted.constructs()]).toEqual([2, 2]);
    } finally {
      if (previous === undefined) delete process.env['DKG_SWM_MATERIALIZATION_WITNESS'];
      else process.env['DKG_SWM_MATERIALIZATION_WITNESS'] = previous;
    }
  });

  it('validates every time when the store exposes no write revision', async () => {
    const inner = newStore();
    const quads = payload('v1', 6);
    await inner.replaceGraph(GRAPH, quads.map((quad) => ({ ...quad, graph: GRAPH })));
    const withoutRevision = new Proxy(inner, {
      get(target, property, receiver) {
        if (property === 'getWriteRevision' || property === 'writeRevisionCoverage') return undefined;
        return Reflect.get(target, property, receiver);
      },
    }) as TripleStore;
    const counted = countingStore(withoutRevision);
    const mat = materializer(counted.store);
    const descriptor = materializationDescriptor(quads);

    expect(await mat.isGraphAssetMaterialized(descriptor)).toBe(true);
    expect(await mat.isGraphAssetMaterialized(descriptor)).toBe(true);
    expect([counted.counts(), counted.constructs()]).toEqual([2, 2]);
  });

  it('exactly detects a backend mutation behind process-local revision coverage', async () => {
    const inner = newStore();
    const quads = payload('v1', 6);
    await inner.replaceGraph(GRAPH, quads.map((quad) => ({ ...quad, graph: GRAPH })));
    const processLocal = new Proxy(inner, {
      get(target, property, receiver) {
        if (property === 'writeRevisionCoverage') return 'process-local';
        if (property === 'getWriteRevision') {
          return () => ({ generation: 0, stable: true });
        }
        return Reflect.get(target, property, receiver);
      },
    }) as TripleStore;
    const counted = countingStore(processLocal);
    const mat = materializer(counted.store);
    const descriptor = materializationDescriptor(quads);

    expect(await mat.isGraphAssetMaterialized(descriptor)).toBe(true);
    await inner.dropGraph(GRAPH);
    expect(await mat.isGraphAssetMaterialized(descriptor)).toBe(false);
    expect([counted.counts(), counted.constructs()]).toEqual([2, 1]);
  });

  it.each([
    ['changed', { generation: 2, stable: true } as GraphWriteRevision],
    ['unstable', { generation: 1, stable: false } as GraphWriteRevision],
    ['unreadable', new Error('revision unavailable')],
  ])('revalidates after the final revision is %s', async (_name, finalRevision) => {
    const inner = newStore();
    const quads = payload('v1', 6);
    await inner.replaceGraph(GRAPH, quads.map((quad) => ({ ...quad, graph: GRAPH })));
    const sequence: (GraphWriteRevision | Error)[] = [
      { generation: 1, stable: true },
      finalRevision,
      { generation: 2, stable: true },
      { generation: 2, stable: true },
      { generation: 2, stable: true },
    ];
    let last: GraphWriteRevision = { generation: 2, stable: true };
    const revisionFenced = new Proxy(inner, {
      get(target, property, receiver) {
        if (property === 'writeRevisionCoverage') return 'all-writers';
        if (property === 'getWriteRevision') {
          return () => {
            const next = sequence.shift() ?? last;
            if (next instanceof Error) throw next;
            last = next;
            return next;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as TripleStore;
    const counted = countingStore(revisionFenced);
    const mat = materializer(counted.store);
    const descriptor = materializationDescriptor(quads);

    expect(await mat.isGraphAssetMaterialized(descriptor)).toBe(true);
    expect(await mat.isGraphAssetMaterialized(descriptor)).toBe(true);
    expect([counted.counts(), counted.constructs()]).toEqual([2, 2]);
    expect(await mat.isGraphAssetMaterialized(descriptor)).toBe(true);
    expect([counted.counts(), counted.constructs()]).toEqual([2, 2]);
  });
});
