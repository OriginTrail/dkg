import { describe, expect, it } from 'vitest';
import { contextGraphWorkspaceGraphUri, createOperationContext } from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  workspaceOperationPublicSliceSubject,
  workspacePublicQuadsDigest,
} from '@origintrail-official/dkg-publisher';
import {
  resolveWorkspaceOperation,
  storeWorkspaceOperationPublicQuads,
} from '@origintrail-official/dkg-publisher/dist/workspace-resolution.js';

import { type SwmSnapshotCoverage } from '../src/dkg-agent-types.js';
import { parseGraphScopedSwmRecoveryDescriptors } from '../src/sync/graph-scoped-swm-recovery.js';
import { createSharedMemorySnapshotMaterializer } from '../src/sync/requester/swm-snapshot-materializer.js';
import { createSelectedSwmMetaFetcher } from '../src/sync/selected-swm-meta-fetcher.js';
import { createSelectedSwmMetaRetentionBudget } from '../src/sync/selected-swm-meta-budget.js';
import { type SyncPageResult } from '../src/sync/requester/page-fetch.js';
import {
  runSharedMemorySync,
  type SharedMemorySnapshotWalkContinuation,
  type SharedMemorySyncMode,
} from '../src/sync/requester/shared-memory-sync.js';
import { swmFixtures } from './swm-descriptor-fixtures.js';

const COVERAGE_CG = 'coverage-swm';
const ctx = createOperationContext('sync');
const noop = () => {};

function pageResult(
  contextGraphId: string,
  phase: string,
  overrides: Partial<SyncPageResult> = {},
): SyncPageResult {
  return {
    quads: [],
    bytesReceived: 0,
    resumedFromOffset: 0,
    responderSessionStartedFresh: true,
    nextOffset: 0,
    checkpointKey: `${contextGraphId}:${phase}`,
    completed: true,
    timedOut: false,
    ...overrides,
  };
}

function sharedMemoryProcessResult() {
  return {
    verifiedData: [] as Quad[],
    verifiedMeta: [] as Quad[],
    totalFetchedDataQuads: 0,
    totalFetchedMetaQuads: 0,
    droppedDataTriples: 0,
    emptyResponses: 1,
    entityCreators: [],
  };
}

describe('entity-share recovery beside malformed KA heads', () => {
  async function entityShareFixture() {
    const { metaGraph } = swmFixtures(COVERAGE_CG);
    const shareOperationId = 'op-entity-share-1';
    const root = 'https://example.org/thing/1';
    const siblingRoot = 'https://example.org/thing/2';
    const payload: Quad[] = [
      { subject: root, predicate: 'https://schema.org/name', object: '"Thing One"', graph: '' },
      { subject: root, predicate: 'https://schema.org/color', object: '"blue"', graph: '' },
    ];
    const siblingPayload: Quad[] = [{ subject: siblingRoot, predicate: 'https://schema.org/name', object: '"Sibling"', graph: '' }];
    const digest = workspacePublicQuadsDigest(payload);
    const siblingDigest = workspacePublicQuadsDigest(siblingPayload);
    const cached = new Map<string, Quad[]>();
    const source = new OxigraphStore();
    const graphManager = new GraphManager(source);
    const createMetadata = async (roots: string[], data: Quad[], subGraphName?: string) => {
      const targetMetaGraph = graphManager.sharedMemoryMetaUri(COVERAGE_CG, subGraphName);
      // The real publisher owns both subject identity and the complete metadata model.
      await storeWorkspaceOperationPublicQuads({
        store: source, graphManager, contextGraphId: COVERAGE_CG,
        shareOperationId, rootEntities: roots, quads: data,
        publisherPeerId: 'peer-source', timestamp: new Date(0), subGraphName,
        publicSnapshotStore: {
          getSnapshot: async ref => cached.get(ref) ?? null,
          putSnapshot: async ({ digest: ref, quads }) => {
            cached.set(ref, quads.map(quad => ({ ...quad, graph: '' })));
            return { ref, byteLength: 0 };
          },
        },
      });
      const result = await source.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${targetMetaGraph}> { ?s ?p ?o } }`);
      if (result.type !== 'quads') throw new Error('Fixture metadata query did not return quads');
      // The manifest visits refs in transport order. Keep the ready root before
      // the missing sibling, independently of the store's CONSTRUCT ordering.
      const slices = roots.map(root => workspaceOperationPublicSliceSubject(COVERAGE_CG, shareOperationId, root, subGraphName));
      return result.quads.map(quad => ({ ...quad, graph: targetMetaGraph }))
        .sort((a, b) => slices.indexOf(a.subject) - slices.indexOf(b.subject));
    };
    let entityMeta: Quad[];
    let twoRootMeta: Quad[];
    let namedMeta: Quad[];
    const namedMetaGraph = graphManager.sharedMemoryMetaUri(COVERAGE_CG, 'research');
    try {
      entityMeta = await createMetadata([root], payload);
      twoRootMeta = await createMetadata([root, siblingRoot], [...payload, ...siblingPayload]);
      namedMeta = await createMetadata([root], payload, 'research');
    } finally {
      await source.close();
    }
    const sliceSubject = workspaceOperationPublicSliceSubject(COVERAGE_CG, shareOperationId, root);
    const siblingSubject = workspaceOperationPublicSliceSubject(COVERAGE_CG, shareOperationId, siblingRoot);
    const ka = swmFixtures(COVERAGE_CG).manifest(1)[0]!;
    cached.set(ka.digest, ka.payload);
    const duplicateHead: Quad[] = [...ka.meta, {
      subject: ka.headSubject, predicate: 'http://dkg.io/ontology/assertionVersion',
      object: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>', graph: metaGraph,
    }];
    const futureHead = ka.meta.map(quad => quad.subject === ka.headSubject && quad.predicate.endsWith('/contentScopeVersion')
      ? { ...quad, object: '"999"^^<http://www.w3.org/2001/XMLSchema#integer>' } : quad);
    const sharedHead = duplicateHead.map(quad => {
      if (quad.predicate.endsWith('/publicSnapshotRef') || quad.predicate.endsWith('/publicQuadsDigest')) return { ...quad, object: `"${digest}"` };
      if (quad.predicate.endsWith('/publicQuadsCount')) return { ...quad, object: `"${payload.length}"^^<http://www.w3.org/2001/XMLSchema#integer>` };
      return quad;
    });
    const aliasHead = duplicateHead.map(quad => quad.subject === ka.headSubject && quad.predicate.endsWith('/shareOperationId')
      ? { ...quad, object: `"${shareOperationId}"` } : quad);
    const malformedNonManifestHead = duplicateHead.filter(quad =>
      !quad.predicate.endsWith('/publicSnapshotRef')
      && !quad.predicate.endsWith('/publicQuadsDigest')
      && !quad.predicate.endsWith('/publicQuadsCount'));
    return {
      metaGraph, namedMetaGraph, namedMeta, shareOperationId, root, payload, digest, siblingDigest, cached, ka, entityMeta, twoRootMeta, sliceSubject, siblingSubject,
      duplicateHead, futureHead, sharedHead, aliasHead, malformedNonManifestHead,
      sliceMeta: entityMeta.filter(quad => quad.subject === sliceSubject),
      siblingMeta: twoRootMeta.filter(quad => quad.subject === siblingSubject),
      data: payload.map(quad => ({ ...quad, graph: contextGraphWorkspaceGraphUri(COVERAGE_CG) })),
    };
  }

  type EntityFixture = Awaited<ReturnType<typeof entityShareFixture>>;
  interface EntityRecoveryScenario {
    name: string;
    arrange(f: EntityFixture): {
      meta: Quad[];
      data: Quad[];
      missingRef?: string;
      mode?: SharedMemorySyncMode;
      rejectMetadataInsert?: boolean;
    };
    expected(f: EntityFixture): {
      metadata: Quad[];
      data: Quad[];
      failedPhases: number;
      attemptedRows: Quad[];
      coverage: Pick<SwmSnapshotCoverage, 'snapshotsResolved' | 'snapshotsTotal' | 'missingCount' | 'missingSample'>;
    };
    parseError?: RegExp;
    resolvedOperation?: { subGraphName?: string };
  }
  const coverage = (resolved: number, total: number, missing: number, sample: string[] = []) => ({
    snapshotsResolved: resolved, snapshotsTotal: total, missingCount: missing, missingSample: sample,
  });
  const recovered = (metadata: Quad[], data: Quad[], expectedCoverage: ReturnType<typeof coverage>, failedPhases = 1) => ({
    metadata, data, failedPhases, coverage: expectedCoverage, attemptedRows: [...data, ...metadata],
  });
  const selectedMode = (accepts: boolean): SharedMemorySyncMode => ({
    kind: 'selected-recovery',
    recoveryGuard: { signal: new AbortController().signal, assertCurrent: noop },
    snapshotEvidencePolicy: { accepts: () => accepts },
  });
  const ambiguousVersion = /ambiguous assertionVersion/;
  const legacyMetadata = (f: EntityFixture, subGraphName?: string): Quad[] => {
    const metadata = subGraphName ? f.namedMeta : f.entityMeta;
    const digestRow = metadata.find(row => row.predicate === 'http://dkg.io/ontology/publicQuadsDigest')!;
    return [...metadata, { ...digestRow, predicate: 'http://dkg.io/ontology/publicSnapshotRef' }];
  };
  const entityScenarios: EntityRecoveryScenario[] = [
    {
      name: 'clean entity share',
      arrange: f => ({ meta: f.entityMeta, data: [] }),
      expected: f => recovered(f.entityMeta, [], coverage(1, 1, 0), 0),
    },
    {
      name: 'clean entity data and metadata share one write',
      arrange: f => ({ meta: f.entityMeta, data: f.data }),
      expected: f => recovered(f.entityMeta, f.data, coverage(1, 1, 0), 0),
    },
    {
      name: 'rejected clean entity write leaves data and metadata retryable',
      arrange: f => ({ meta: f.entityMeta, data: f.data, rejectMetadataInsert: true }),
      expected: f => ({ ...recovered([], [], coverage(0, 1, 1), 1), attemptedRows: [...f.data, ...f.entityMeta] }),
    },
    ...[undefined, 'research'].map((subGraphName): EntityRecoveryScenario => ({
      name: `valid legacy snapshot reference in ${subGraphName ?? 'root'} subgraph`,
      parseError: ambiguousVersion,
      arrange: f => ({ meta: [...legacyMetadata(f, subGraphName), ...f.duplicateHead], data: [] }),
      expected: f => recovered(legacyMetadata(f, subGraphName), [], coverage(1, 2, 1)),
      resolvedOperation: { subGraphName },
    })),
    {
      name: 'duplicate KA version', parseError: ambiguousVersion,
      arrange: f => ({ meta: [...f.entityMeta, ...f.duplicateHead], data: f.data }),
      expected: f => recovered(f.entityMeta, f.data, coverage(1, 2, 1)),
    },
    {
      name: 'future KA content-scope version', parseError: /unsupported contentScopeVersion/,
      arrange: f => ({ meta: [...f.entityMeta, ...f.futureHead], data: f.data }),
      expected: f => recovered(f.entityMeta, f.data, coverage(1, 2, 1)),
    },
    {
      name: 'shared ref with entity source first', parseError: ambiguousVersion,
      arrange: f => ({ meta: [...f.entityMeta, ...f.sharedHead], data: f.data }),
      expected: f => recovered([], f.data, coverage(0, 1, 1)),
    },
    {
      name: 'shared ref with KA source first', parseError: ambiguousVersion,
      arrange: f => ({ meta: [...f.sharedHead, ...f.entityMeta], data: f.data }),
      expected: f => recovered([], f.data, coverage(0, 1, 1)),
    },
    {
      name: 'missing entity snapshot', parseError: ambiguousVersion,
      arrange: f => ({ meta: [...f.entityMeta, ...f.duplicateHead], data: f.data, missingRef: f.digest }),
      // The pool validates the cached KA sibling before the entity miss settles.
      // Its malformed head still keeps it unresolved, but it is no longer an
      // unvisited ref in the walk's bounded missing-reference sample.
      expected: f => recovered([], f.data, coverage(0, 2, 2, [f.digest])),
    },
    {
      name: 'missing unrelated KA snapshot', parseError: ambiguousVersion,
      arrange: f => ({ meta: [...f.entityMeta, ...f.duplicateHead], data: f.data, missingRef: f.ka.digest }),
      expected: f => recovered(f.entityMeta, f.data, coverage(1, 2, 1, [f.ka.digest])),
    },
    {
      name: 'KA head aliases the entity operation', parseError: ambiguousVersion,
      arrange: f => ({ meta: [...f.entityMeta, ...f.aliasHead], data: f.data }),
      expected: f => recovered(f.sliceMeta, f.data, coverage(1, 2, 1)),
    },
    {
      name: 'missing sibling snapshot in a multi-root operation', parseError: ambiguousVersion,
      arrange: f => ({ meta: [...f.twoRootMeta, ...f.duplicateHead], data: f.data, missingRef: f.siblingDigest }),
      expected: f => recovered(f.sliceMeta, f.data, coverage(1, 3, 2, [f.siblingDigest])),
    },
    {
      name: 'ready sibling cannot authorize a mixed-source root', parseError: ambiguousVersion,
      arrange: f => ({ meta: [...f.twoRootMeta, ...f.sharedHead], data: f.data }),
      expected: f => recovered(f.siblingMeta, f.data, coverage(1, 2, 1)),
    },
    {
      name: 'all independently ready roots publish the multi-root operation', parseError: ambiguousVersion,
      arrange: f => ({ meta: [...f.twoRootMeta, ...f.duplicateHead], data: f.data }),
      expected: f => recovered(f.twoRootMeta, f.data, coverage(2, 3, 1)),
    },
    {
      name: 'metadata-only recovery after a malformed head', parseError: ambiguousVersion,
      arrange: f => ({ meta: [...f.entityMeta, ...f.duplicateHead], data: [] }),
      expected: f => recovered(f.entityMeta, [], coverage(1, 2, 1)),
    },
    {
      name: 'finalization memo stamps preserve canonical operation recovery', parseError: ambiguousVersion,
      arrange: f => ({ meta: [...f.entityMeta, ...f.duplicateHead,
        ...['snapshotMerkleRoot', 'snapshotContentDigest'].map(field => ({
          subject: f.entityMeta.find(quad => quad.subject !== f.sliceSubject)!.subject,
          predicate: `http://dkg.io/ontology/${field}`, object: '"peer-local memo"', graph: f.metaGraph,
        })),
      ], data: [] }),
      expected: f => recovered(f.entityMeta, [], coverage(1, 2, 1)),
      resolvedOperation: {},
    },
    {
      name: 'memo sidecars cannot hide a KA commitment on an entity operation', parseError: ambiguousVersion,
      arrange: f => ({ meta: [...f.entityMeta, ...f.duplicateHead,
        ...['snapshotMerkleRoot', 'kaUal'].map(field => ({
          subject: f.entityMeta.find(quad => quad.subject !== f.sliceSubject)!.subject,
          predicate: `http://dkg.io/ontology/${field}`, object: '"unexpected commitment"', graph: f.metaGraph,
        })),
      ], data: [] }),
      expected: f => recovered(f.sliceMeta, [], coverage(1, 2, 1)),
    },
    {
      name: 'a named subgraph recovers matching slice and operation rows', parseError: ambiguousVersion,
      arrange: f => ({ meta: [...f.namedMeta, ...f.duplicateHead], data: [] }),
      expected: f => recovered(f.namedMeta, [], coverage(1, 2, 1)),
      resolvedOperation: { subGraphName: 'research' },
    },
    {
      name: 'entity declarations in the wrong metadata graph are not authoritative',
      parseError: ambiguousVersion,
      arrange: f => ({
        meta: [
          ...f.entityMeta.map(quad => ({ ...quad, graph: f.namedMetaGraph })),
          ...f.duplicateHead,
        ],
        data: [],
      }),
      expected: () => recovered([], [], coverage(0, 2, 2)),
    },
    ...[true, false].map((entityClaimFirst): EntityRecoveryScenario => ({
      name: 'ambiguous head reserves every operation: entity claim ' + (entityClaimFirst ? 'first' : 'last'),
      parseError: ambiguousVersion,
      arrange: f => {
        const claim = { subject: f.ka.headSubject, predicate: 'http://dkg.io/ontology/shareOperationId',
          object: JSON.stringify(f.shareOperationId), graph: f.metaGraph };
        return { meta: [...f.entityMeta, ...(entityClaimFirst ? [claim, ...f.duplicateHead] : [...f.duplicateHead, claim])], data: [] };
      },
      expected: f => recovered(f.sliceMeta, [], coverage(1, 2, 1)),
    })),
    {
      name: 'a missing operation does not suppress its ready slice', parseError: ambiguousVersion,
      arrange: f => ({ meta: [...f.sliceMeta, ...f.duplicateHead], data: [] }),
      expected: f => recovered(f.sliceMeta, [], coverage(1, 2, 1)),
    },
    {
      name: 'a declared root without slice metadata blocks the operation', parseError: ambiguousVersion,
      arrange: f => ({ meta: [...f.twoRootMeta.filter(quad => quad.subject !== f.siblingSubject), ...f.duplicateHead], data: [] }),
      expected: f => recovered(f.sliceMeta, [], coverage(1, 2, 1)),
    },
    {
      name: 'operation and slice subgraphs must agree', parseError: ambiguousVersion,
      arrange: f => ({ meta: [...f.entityMeta, ...f.duplicateHead, {
        subject: f.entityMeta.find(quad => quad.subject !== f.sliceSubject)!.subject,
        predicate: 'http://dkg.io/ontology/subGraphName', object: '"other"', graph: f.metaGraph,
      }], data: [] }),
      expected: f => recovered(f.sliceMeta, [], coverage(1, 2, 1)),
    },
    {
      name: 'an invalid root cannot authorize a slice', parseError: ambiguousVersion,
      arrange: f => ({ meta: [...f.entityMeta.map(quad => quad.predicate.endsWith('/publicSliceRootEntity')
        ? { ...quad, object: '"not an IRI"' } : quad), ...f.duplicateHead], data: [] }),
      expected: () => recovered([], [], coverage(0, 2, 2)),
    },
    {
      name: 'selected recovery accepts entity evidence', parseError: ambiguousVersion,
      arrange: f => ({ meta: [...f.entityMeta, ...f.duplicateHead], data: [], mode: selectedMode(true) }),
      expected: f => recovered(f.entityMeta, [], coverage(1, 2, 1)),
    },
    {
      name: 'selected recovery rejects entity evidence', parseError: ambiguousVersion,
      arrange: f => ({ meta: [...f.entityMeta, ...f.duplicateHead], data: [], mode: selectedMode(false) }),
      expected: () => recovered([], [], coverage(0, 2, 2)),
    },
    {
      name: 'a rejected combined write exposes neither data nor metadata', parseError: ambiguousVersion,
      arrange: f => ({ meta: [...f.entityMeta, ...f.duplicateHead], data: f.data, rejectMetadataInsert: true }),
      expected: f => ({ ...recovered([], [], coverage(0, 2, 2), 2), attemptedRows: [...f.data, ...f.entityMeta] }),
    },
    {
      name: 'a rejected entity metadata write remains retryable', parseError: ambiguousVersion,
      arrange: f => ({
        meta: [...f.entityMeta, ...f.malformedNonManifestHead],
        data: [],
        rejectMetadataInsert: true,
      }),
      expected: f => ({
        ...recovered([], [], coverage(0, 1, 1), 2),
        attemptedRows: f.entityMeta,
      }),
    },
  ];

  it.each(entityScenarios)('preserves entity-share recovery: $name', async scenario => {
    const fixture = await entityShareFixture();
    const input = scenario.arrange(fixture);
    const expected = scenario.expected(fixture);
    if (scenario.parseError) {
      expect(() => parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: COVERAGE_CG, metaQuads: input.meta })).toThrow(scenario.parseError);
    } else {
      expect(parseGraphScopedSwmRecoveryDescriptors({ contextGraphId: COVERAGE_CG, metaQuads: input.meta })).toEqual([]);
    }
    if (input.missingRef) fixture.cached.delete(input.missingRef);
    const snapshotFetches: string[] = [];
    const batches: Quad[][] = [];
    const store = new OxigraphStore();
    const materializer = createSharedMemorySnapshotMaterializer({ store, writeLocks: new Map<string, Promise<void>>(), invalidateListContextGraphsCache: noop });
    try {
      const summary = await runSharedMemorySync({
        mode: input.mode ?? { kind: 'ordinary' }, ctx, remotePeerId: 'peer-entity-share-1a2b3c4d',
        contextGraphIds: [COVERAGE_CG], createContextGraphSyncDeadline: () => Date.now() + 60_000,
        fetchSyncPages: async (_ctx, _peer, contextGraphId, _shared, phase, _graph, _deadline, options) => {
          if (phase === 'snapshot') {
            snapshotFetches.push(String(options?.snapshotRef));
            if (options?.snapshotRef === input.missingRef) return { ...pageResult(contextGraphId, phase), completed: false, timedOut: true };
          }
          return pageResult(contextGraphId, phase);
        },
        processSharedMemoryBatch: async () => ({
          ...sharedMemoryProcessResult(), emptyResponses: 0, verifiedMeta: input.meta, verifiedData: input.data,
          totalFetchedDataQuads: input.data.length, totalFetchedMetaQuads: input.meta.length,
        }),
        ensureContextGraph: async () => {},
        storeInsert: async quads => {
          batches.push([...quads]);
          if (input.rejectMetadataInsert && quads.some(quad => quad.graph === fixture.metaGraph)) throw new Error('metadata batch rejected');
          await store.insert(quads);
        },
        snapshotMaterializer: materializer,
        publicSnapshotStore: { getSnapshot: async ref => fixture.cached.get(ref) ?? null, putSnapshot: async () => ({ ref: 'unused', byteLength: 0 }) },
        deleteCheckpoint: noop, setCheckpoint: noop, ensureOwnedMap: () => new Map(),
        logInfo: noop, logWarn: noop, logDebug: noop,
      });
      expect(snapshotFetches).toEqual(input.missingRef ? [input.missingRef] : []);
      expect(summary.failedPhases).toBe(expected.failedPhases);
      expect(summary.insertedDataTriples).toBe(expected.data.length);
      expect(summary.insertedMetaTriples).toBe(expected.metadata.length);
      expect(summary.swmCoverage).toEqual({
        contextGraphId: COVERAGE_CG, peerIdSuffix: '1a2b3c4d',
        ...expected.coverage, manifestComplete: true, descriptorsAuthoritative: !scenario.parseError, materializationFailures: 0,
      });
      const expectedRows = [...expected.metadata, ...expected.data];
      for (const graph of new Set([fixture.metaGraph, fixture.namedMetaGraph, contextGraphWorkspaceGraphUri(COVERAGE_CG)])) {
        const rows = expectedRows.filter(quad => quad.graph === graph);
        const stored = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
        expect(stored.type).toBe('quads');
        if (stored.type === 'quads') {
          expect(stored.quads).toHaveLength(rows.length);
          expect(stored.quads).toEqual(expect.arrayContaining(rows.map(quad => ({ ...quad, graph: '' }))));
        }
      }
      if (scenario.resolvedOperation) {
        const operation = await resolveWorkspaceOperation({ store, graphManager: new GraphManager(store),
          contextGraphId: COVERAGE_CG, shareOperationId: fixture.shareOperationId, ...scenario.resolvedOperation });
        expect(operation.rootEntities).toEqual([fixture.root]);
      }
      expect(batches).toHaveLength(expected.attemptedRows.length > 0 ? 1 : 0);
      if (expected.attemptedRows.length > 0) {
        expect(batches[0]).toHaveLength(expected.attemptedRows.length);
        expect(batches[0]).toEqual(expect.arrayContaining(expected.attemptedRows));
      }
    } finally {
      await store.close();
    }
  });

  it('advances a selected entity ref only after storage and ownership commit, and retries a rejected write', async () => {
    const f = await entityShareFixture();
    const metadata = [...legacyMetadata(f), ...f.duplicateHead];
    const store = new OxigraphStore();
    const owned = new Map<string, string>();
    let rejectWrite = true;
    let writes = 0;
    let durable = false;
    let walk: SharedMemorySnapshotWalkContinuation | undefined;
    const fetcher = createSelectedSwmMetaFetcher({
      remotePeerId: 'peer-entity-retry', requesterScope: 'selected-swm-meta:retained:entity-retry',
      retentionBudget: createSelectedSwmMetaRetentionBudget({ maxRows: 1000, maxPrefixRows: 1000,
        maxBytesEstimate: 1024 * 1024, maxPrefixBytesEstimate: 1024 * 1024 }),
      deleteCheckpoint: noop,
      fetchPage: async () => pageResult(COVERAGE_CG, 'meta', { quads: metadata, nextOffset: metadata.length }),
    });
    const materializer = createSharedMemorySnapshotMaterializer({ store, writeLocks: new Map<string, Promise<void>>(), invalidateListContextGraphsCache: noop });
    const run = () => runSharedMemorySync({
      mode: { kind: 'selected-recovery', recoveryGuard: { signal: new AbortController().signal, assertCurrent: noop },
        snapshotEvidencePolicy: { accepts: () => true },
        metadataFetcher: { ...fetcher.strategy, snapshotWalk(contextGraphId, manifest) {
          walk = fetcher.strategy.snapshotWalk!(contextGraphId, manifest);
          const current = walk;
          return { ...current, markResolved(ref, suppressedRows) {
            expect(durable).toBe(true);
            expect(owned.get(f.root)).toBe('peer-source');
            current.markResolved(ref, suppressedRows);
          } };
        } },
      },
      ctx, remotePeerId: 'peer-entity-retry', contextGraphIds: [COVERAGE_CG],
      createContextGraphSyncDeadline: () => Date.now() + 60_000,
      fetchSyncPages: async (_ctx, _peer, cg, _shared, phase) => pageResult(cg, phase),
      processSharedMemoryBatch: async () => ({ ...sharedMemoryProcessResult(), emptyResponses: 0,
        verifiedMeta: metadata, verifiedData: f.data,
        totalFetchedDataQuads: f.data.length, totalFetchedMetaQuads: metadata.length,
        entityCreators: [{ dataGraph: contextGraphWorkspaceGraphUri(COVERAGE_CG), entity: f.root, creator: 'peer-source' }],
      }),
      ensureContextGraph: async () => {},
      storeInsert: async rows => {
        writes += 1;
        expect(walk?.resolvedRefsSnapshot()).toEqual([]);
        expect(owned.size).toBe(0);
        if (rejectWrite) throw new Error('first entity batch rejected');
        await store.insert(rows);
        durable = true;
      },
      snapshotMaterializer: materializer,
      publicSnapshotStore: { getSnapshot: async ref => f.cached.get(ref) ?? null, putSnapshot: async () => ({ ref: 'unused', byteLength: 0 }) },
      deleteCheckpoint: noop, setCheckpoint: noop, ensureOwnedMap: () => owned,
      logInfo: noop, logWarn: noop, logDebug: noop,
    });
    try {
      expect((await run()).swmCoverage?.snapshotsResolved).toBe(0);
      expect(walk?.resolvedRefsSnapshot()).toEqual([]);
      expect(owned.size).toBe(0);
      rejectWrite = false;
      expect((await run()).swmCoverage?.snapshotsResolved).toBe(1);
      expect(writes).toBe(2);
      expect(walk?.resolvedRefsSnapshot()).toEqual([f.digest]);
      const operation = await resolveWorkspaceOperation({ store, graphManager: new GraphManager(store),
        contextGraphId: COVERAGE_CG, shareOperationId: f.shareOperationId });
      expect(operation.rootEntities).toEqual([f.root]);
    } finally {
      fetcher.strategy.release(COVERAGE_CG);
      await store.close();
    }
  });

});
