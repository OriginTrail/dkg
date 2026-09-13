import { describe, expect, it } from 'vitest';
import { contextGraphWorkspaceMetaGraphUri } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { workspacePublicQuadsDigest } from '@origintrail-official/dkg-publisher';
import { swmFixtures, type SwmShare } from './swm-descriptor-fixtures.js';
import { parseGraphScopedSwmRecoveryDescriptors } from '../src/sync/graph-scoped-swm-recovery.js';
import { collectPublicSnapshotMetadata } from '../src/sync/requester/shared-memory-sync.js';
import type { SwmSnapshotCoverage } from '../src/dkg-agent-types.js';
import { ctx, quad } from './sync-requester-fixtures.js';
import {
  makeEntitySharePublisherFixture,
  type EntitySharePublisherFixture,
} from './_helpers/swm-entity-share-publisher-fixture.js';
import { runManagedSwmSyncHarness } from './_helpers/swm-sync-harness.js';

const COVERAGE_CG = 'coverage-swm';
const META_GRAPH = contextGraphWorkspaceMetaGraphUri(COVERAGE_CG);

interface SnapshotCoverageScenario {
  readonly contextGraphId: string;
  readonly remotePeerId: string;
  readonly servedMeta: readonly Quad[];
  readonly cachedSnapshots: ReadonlyMap<string, readonly Quad[]>;
  readonly expectedCoverage: SwmSnapshotCoverage;
}

function mixedManifestScenario(): SnapshotCoverageScenario & { readonly current: SwmShare } {
  const { share } = swmFixtures(COVERAGE_CG);
  const ual = 'did:dkg:hardhat:31337/0xcccccccccccccccccccccccccccccccccccccccc/1';
  const superseded = share({
    version: 1, operationId: 'op-superseded', marker: 'superseded', ual, payloadCount: 2,
  });
  const current = share({
    version: 2, operationId: 'op-current', marker: 'current', ual, payloadCount: 3,
  });
  return {
    contextGraphId: COVERAGE_CG,
    remotePeerId: 'peer-resharing-5a5a5a5a',
    // Re-sharing retains the old operation while the head names only the current one.
    servedMeta: [...current.meta, ...superseded.meta.filter(row => row.subject === superseded.operationSubject)],
    cachedSnapshots: new Map([[current.digest, current.payload], [superseded.digest, superseded.payload]]),
    current,
    expectedCoverage: {
      contextGraphId: COVERAGE_CG, peerIdSuffix: '5a5a5a5a',
      snapshotsResolved: 2, snapshotsTotal: 2, manifestComplete: true,
      descriptorsAuthoritative: true, missingCount: 0, missingSample: [], materializationFailures: 0,
    },
  };
}

async function entityShareManifestScenario(): Promise<SnapshotCoverageScenario & {
  readonly published: EntitySharePublisherFixture;
  readonly expectedSlice: readonly Quad[];
}> {
  const root = 'https://example.org/thing/1';
  const expectedSlice: Quad[] = [
    { subject: root, predicate: 'https://schema.org/name', object: '"Thing One"', graph: '' },
    { subject: root, predicate: 'https://schema.org/color', object: '"blue"', graph: '' },
  ];
  const published = await makeEntitySharePublisherFixture({
    contextGraphId: COVERAGE_CG,
    shareOperationId: 'op-entity-share-1',
    rootEntity: root,
    publisherPeerId: 'peer-source',
    payload: [
      ...expectedSlice,
      { subject: 'https://example.org/thing/not-shared', predicate: 'https://schema.org/name',
        object: '"Not part of this root slice"', graph: '' },
    ],
  });
  return {
    contextGraphId: COVERAGE_CG,
    remotePeerId: 'peer-entity-share-1a2b3c4d',
    servedMeta: published.meta,
    cachedSnapshots: new Map([[published.digest, published.payload]]),
    published,
    expectedSlice,
    expectedCoverage: {
      contextGraphId: COVERAGE_CG, peerIdSuffix: '1a2b3c4d',
      snapshotsResolved: 1, snapshotsTotal: 1, manifestComplete: true,
      descriptorsAuthoritative: true, missingCount: 0, missingSample: [], materializationFailures: 0,
    },
  };
}

function ambiguousDescriptorManifestScenario(): SnapshotCoverageScenario & {
  readonly validMeta: readonly Quad[];
  readonly shares: readonly SwmShare[];
  readonly expectedValidCoverage: SwmSnapshotCoverage;
} {
  const { manifest, metaGraph } = swmFixtures(COVERAGE_CG);
  const [validKa, residueKa] = manifest(2);
  const validMeta = [...validKa.meta, ...residueKa.meta];
  const expectedCoverage: SwmSnapshotCoverage = {
    contextGraphId: COVERAGE_CG, peerIdSuffix: '7c7c7c7c',
    snapshotsResolved: 0, snapshotsTotal: 2, manifestComplete: true,
    descriptorsAuthoritative: false, missingCount: 2, missingSample: [], materializationFailures: 0,
  };
  return {
    contextGraphId: COVERAGE_CG,
    remotePeerId: 'peer-head-residue-7c7c7c7c',
    // One conflicting head invalidates the complete descriptor set, including the first KA.
    servedMeta: [...validMeta, {
      subject: residueKa.headSubject,
      predicate: 'http://dkg.io/ontology/assertionVersion',
      object: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>',
      graph: metaGraph,
    }],
    cachedSnapshots: new Map([[validKa.digest, validKa.payload], [residueKa.digest, residueKa.payload]]),
    validMeta,
    shares: [validKa, residueKa],
    expectedCoverage,
    expectedValidCoverage: {
      ...expectedCoverage, snapshotsResolved: 2, descriptorsAuthoritative: true, missingCount: 0,
    },
  };
}

function snapshotMeta(subject: string, digest: string, count: number): Quad[] {
  return [
    { subject, predicate: 'http://dkg.io/ontology/publicQuadsDigest', object: `"${digest}"`, graph: META_GRAPH },
    { subject, predicate: 'http://dkg.io/ontology/publicQuadsCount', object: `"${count}"`, graph: META_GRAPH },
  ];
}

describe('public SWM snapshot coverage (#2050)', () => {
  it('retains unresolved coverage when snapshot fetching does not finish and materialization is disabled', async () => {
    const cachedQuads = [quad('cached-snapshot-row')];
    const cachedDigest = workspacePublicQuadsDigest(cachedQuads);
    const { summary } = await runManagedSwmSyncHarness({
      ctx,
      remotePeerId: 'peer-coverage-abcd1234',
      contextGraphId: COVERAGE_CG,
      servedMeta: [
        ...snapshotMeta('did:dkg:assertion:cached', cachedDigest, cachedQuads.length),
        ...snapshotMeta('did:dkg:assertion:unreachable', 'digest-never-served', 5),
      ],
      cachedSnapshots: new Map([[cachedDigest, cachedQuads]]),
      materialization: 'disabled',
      fetchPage: async ({ phase }, fallback) => phase === 'snapshot'
        ? { ...fallback, completed: false, timedOut: true }
        : fallback,
    });
    expect(summary.swmCoverage).toEqual({
      contextGraphId: COVERAGE_CG, peerIdSuffix: 'abcd1234',
      snapshotsResolved: 0, snapshotsTotal: 2, manifestComplete: true,
      descriptorsAuthoritative: true, missingCount: 2,
      missingSample: ['digest-never-served'], materializationFailures: 0,
    });
  });

  it('resolves both refs in a mixed manifest while materializing the current share', async () => {
    const { expectedCoverage, current, ...source } = mixedManifestScenario();
    expect(collectPublicSnapshotMetadata(source.servedMeta).map(entry => entry.ref).sort())
      .toEqual([...source.cachedSnapshots.keys()].sort());
    const descriptors = parseGraphScopedSwmRecoveryDescriptors({
      contextGraphId: source.contextGraphId, metaQuads: source.servedMeta,
    });
    expect(descriptors.map(descriptor => descriptor.publicSnapshotRef)).toEqual([current.digest]);

    const { summary, snapshotFetches } = await runManagedSwmSyncHarness({ ctx, ...source });
    expect(snapshotFetches).toEqual([]);
    expect(summary.insertedDataTriples).toBeGreaterThanOrEqual(current.payload.length);
    expect(summary.failedPhases).toBe(0);
    expect(summary.swmCoverage).toEqual(expectedCoverage);
  });

  it('resolves a cached entity share with no graph-scoped descriptor and no graph write', async () => {
    const { expectedCoverage, published, expectedSlice, ...source } = await entityShareManifestScenario();
    expect(published.payload).toEqual(expectedSlice);
    expect(source.servedMeta.some(row => row.subject === published.sliceSubject)).toBe(true);
    expect(collectPublicSnapshotMetadata(source.servedMeta)).toEqual([{
      ref: published.digest, digest: published.digest, count: published.payload.length, publishedAtMs: 0,
    }]);
    expect(parseGraphScopedSwmRecoveryDescriptors({
      contextGraphId: source.contextGraphId, metaQuads: source.servedMeta,
    })).toEqual([]);

    const { summary, snapshotFetches } = await runManagedSwmSyncHarness({ ctx, ...source });
    expect(snapshotFetches).toEqual([]);
    expect(summary.failedPhases).toBe(0);
    expect(summary.insertedDataTriples).toBe(0);
    expect(summary.swmCoverage).toEqual(expectedCoverage);
  });

  it('withholds resolution and metadata when a complete manifest has an ambiguous descriptor', async () => {
    const { expectedCoverage, expectedValidCoverage, validMeta, shares, ...source } =
      ambiguousDescriptorManifestScenario();
    expect(() => parseGraphScopedSwmRecoveryDescriptors({
      contextGraphId: source.contextGraphId, metaQuads: source.servedMeta,
    })).toThrow(/ambiguous assertionVersion/);
    expect(collectPublicSnapshotMetadata(source.servedMeta).map(entry => entry.ref).sort())
      .toEqual(shares.map(share => share.digest).sort());

    // The same snapshots must materialize when only the conflicting row is absent.
    const validReplacements: string[] = [];
    const valid = await runManagedSwmSyncHarness({
      ctx, ...source, servedMeta: validMeta,
      onReplaceGraph: graph => { validReplacements.push(graph); },
    });
    expect(valid.snapshotFetches).toEqual([]);
    expect(validReplacements.sort()).toEqual(shares.map(share => share.assertionGraph).sort());
    expect(valid.summary.insertedDataTriples).toBeGreaterThanOrEqual(
      shares.reduce((count, share) => count + share.payload.length, 0),
    );
    expect(valid.summary.insertedMetaTriples).toBeGreaterThan(0);
    expect(valid.summary.failedPhases).toBe(0);
    expect(valid.summary.swmCoverage).toEqual(expectedValidCoverage);

    const replacedGraphs: string[] = [];
    const { summary, snapshotFetches } = await runManagedSwmSyncHarness({
      ctx, ...source, onReplaceGraph: graph => { replacedGraphs.push(graph); },
    });
    expect(snapshotFetches).toEqual([]);
    expect(replacedGraphs).toEqual([]);
    expect(summary.insertedDataTriples).toBe(0);
    expect(summary.swmCoverage).toEqual(expectedCoverage);
    expect(summary.failedPhases).toBeGreaterThanOrEqual(1);
    expect(summary.insertedMetaTriples).toBe(0);
  });
});
