import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import oxigraph from 'oxigraph';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BlazegraphStore,
  ChangelogStore,
  GraphSetIndexStore,
  OxigraphStore,
  OxigraphWorkerStore,
  SharedMemoryLiteralBlobStore,
  SparqlHttpStore,
  WAL_PROJECTION_MARKER_GRAPH,
  WalProjectionIntegrityError,
  buildWalProjectionCommitPlanV1,
  readWalProjectionMarkerV1,
  tryCommitWalProjectionV1,
  walProjectionMarkerEqualsV1,
  walProjectionShadowGraphV1,
  walProjectionStoreCapabilityV1,
  type Quad,
  type TripleStore,
  type WalProjectionCommitInputV1,
} from '../src/index.js';

function bytes(label: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(label).digest());
}

const namespaceId = bytes('wal-projection-namespace');
const logicalKey = bytes('wal-projection-logical-key');
const contentGraph = walProjectionShadowGraphV1(namespaceId, logicalKey, 'content');
const metadataGraph = walProjectionShadowGraphV1(namespaceId, logicalKey, 'metadata');
const deltaGraph = walProjectionShadowGraphV1(namespaceId, logicalKey, 'delta');
const conflictGraph = walProjectionShadowGraphV1(namespaceId, logicalKey, 'conflict-a');

function quad(
  subject: string,
  object: string,
  graph = contentGraph,
  predicate = 'urn:test:value',
): Quad {
  return { subject, predicate, object, graph };
}

function commit(
  label: string,
  overrides: Partial<WalProjectionCommitInputV1> = {},
): WalProjectionCommitInputV1 {
  return {
    adapterVersion: 1,
    mode: 'CAS',
    namespaceId,
    logicalKey,
    expectedActiveHeadsDigest: null,
    replaceGraphs: [{
      graphUri: contentGraph,
      quads: [quad('urn:new:content', `"${label}"`)],
    }],
    replaceSubjects: [{
      graphUri: metadataGraph,
      subject: 'urn:projection:subject',
      quads: [quad('urn:projection:subject', `"meta-${label}"`, metadataGraph)],
    }],
    deleteQuads: [quad('urn:delta:old', '"old"', deltaGraph)],
    insertQuads: [quad('urn:delta:new', `"delta-${label}"`, deltaGraph)],
    conflictGraphs: [{
      graphUri: conflictGraph,
      quads: [quad('urn:conflict:head', `"conflict-${label}"`, conflictGraph)],
    }],
    newActiveHeadsDigest: bytes(`${label}-heads`),
    newConflictHeadsDigest: bytes(`${label}-conflicts`),
    newStateDigest: bytes(`${label}-state`),
    sourceVectorId: bytes(`${label}-vector`),
    materializationStatus: 'APPLIED',
    ...overrides,
  };
}

async function bindings(store: TripleStore, graph: string): Promise<Array<Record<string, string>>> {
  const result = await store.query(
    `SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } } ORDER BY ?s ?p ?o`,
  );
  if (result.type !== 'bindings') throw new Error('expected bindings');
  return result.bindings;
}

describe('WAL-v1 transactional projection commit', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(
      directory => rm(directory, { recursive: true, force: true }),
    ));
  });

  it('commits content, conflict graphs, deltas, subject replacement, and marker together', async () => {
    const store = new OxigraphStore();
    await store.insert([
      quad('urn:old:content', '"old"'),
      quad('urn:projection:subject', '"old-meta"', metadataGraph),
      quad('urn:metadata:keep', '"keep"', metadataGraph),
      quad('urn:delta:old', '"old"', deltaGraph),
      quad('urn:unrelated', '"keep"', 'urn:test:production'),
    ]);
    const input = commit('first');

    await expect(tryCommitWalProjectionV1(store, input)).resolves.toEqual({
      status: 'COMMITTED',
      marker: buildWalProjectionCommitPlanV1(input).marker,
    });
    expect(await bindings(store, contentGraph)).toEqual([
      { s: 'urn:new:content', p: 'urn:test:value', o: '"first"' },
    ]);
    expect(await bindings(store, metadataGraph)).toEqual([
      { s: 'urn:metadata:keep', p: 'urn:test:value', o: '"keep"' },
      { s: 'urn:projection:subject', p: 'urn:test:value', o: '"meta-first"' },
    ]);
    expect(await bindings(store, deltaGraph)).toEqual([
      { s: 'urn:delta:new', p: 'urn:test:value', o: '"delta-first"' },
    ]);
    expect(await bindings(store, conflictGraph)).toEqual([
      { s: 'urn:conflict:head', p: 'urn:test:value', o: '"conflict-first"' },
    ]);
    expect(await store.countQuads('urn:test:production')).toBe(1);
    expect(await readWalProjectionMarkerV1(store, namespaceId, logicalKey)).toEqual(
      buildWalProjectionCommitPlanV1(input).marker,
    );
    expect(await store.listGraphs()).toEqual(['urn:test:production']);
    await store.close();
  });

  it('returns GUARD_FAILED without changing any projection row', async () => {
    const store = new OxigraphStore();
    const first = commit('first', { deleteQuads: [] });
    await store.commitWalProjectionV1(first);
    const before = {
      content: await bindings(store, contentGraph),
      conflict: await bindings(store, conflictGraph),
      marker: await readWalProjectionMarkerV1(store, namespaceId, logicalKey),
    };
    const stale = commit('stale', {
      expectedActiveHeadsDigest: bytes('not-the-current-heads'),
      deleteQuads: [],
    });

    await expect(store.commitWalProjectionV1(stale)).resolves.toEqual({
      status: 'GUARD_FAILED',
      marker: before.marker,
    });
    expect(await bindings(store, contentGraph)).toEqual(before.content);
    expect(await bindings(store, conflictGraph)).toEqual(before.conflict);
    expect(await readWalProjectionMarkerV1(store, namespaceId, logicalKey)).toEqual(before.marker);
    await store.close();
  });

  it('commits a guarded successor and remains semantically passive across opaque outcomes', async () => {
    const store = new OxigraphStore();
    const first = commit('first', { deleteQuads: [] });
    await store.commitWalProjectionV1(first);
    const second = commit('second', {
      expectedActiveHeadsDigest: first.newActiveHeadsDigest,
      deleteQuads: [],
      replaceGraphs: [{
        graphUri: contentGraph,
        quads: [
          quad('urn:opaque:anything', '"the storage layer does not interpret this"'),
          quad('urn:opaque:other', '"another complete semantic outcome"'),
        ],
      }],
    });

    await expect(store.commitWalProjectionV1(second)).resolves.toMatchObject({ status: 'COMMITTED' });
    expect(await bindings(store, contentGraph)).toHaveLength(2);
    expect(walProjectionMarkerEqualsV1(
      await readWalProjectionMarkerV1(store, namespaceId, logicalKey),
      buildWalProjectionCommitPlanV1(second).marker,
    )).toBe(true);
    await store.close();
  });

  it('rejects malformed, ambiguous, production-graph, and corrupt-marker inputs before mutation', async () => {
    const store = new OxigraphStore();
    await store.insert([quad('urn:old', '"old"')]);
    const invalid = [
      commit('bad-version', { adapterVersion: 2 as never }),
      commit('bad-scope', {
        replaceGraphs: [{ graphUri: 'urn:test:production', quads: [] }],
      }),
      commit('overlap', {
        replaceGraphs: [{ graphUri: contentGraph, quads: [] }],
        insertQuads: [quad('urn:x', '"x"')],
      }),
      commit('delta-contradiction', {
        replaceGraphs: [],
        deleteQuads: [quad('urn:x', '"x"', deltaGraph)],
        insertQuads: [quad('urn:x', '"x"', deltaGraph)],
      }),
      commit('blank', {
        replaceGraphs: [{ graphUri: contentGraph, quads: [quad('_:blank', '"x"')] }],
      }),
    ];
    for (const value of invalid) {
      await expect(store.commitWalProjectionV1(value)).rejects.toBeInstanceOf(WalProjectionIntegrityError);
    }
    expect(await bindings(store, contentGraph)).toEqual([
      { s: 'urn:old', p: 'urn:test:value', o: '"old"' },
    ]);

    const valid = commit('valid', { deleteQuads: [] });
    await store.commitWalProjectionV1(valid);
    await store.update(`
      INSERT DATA { GRAPH <${WAL_PROJECTION_MARKER_GRAPH}> {
        <urn:dkg:wal:projection:v1:${Buffer.from(namespaceId).toString('hex')}:${Buffer.from(logicalKey).toString('hex')}>
          <urn:dkg:wal:projection:v1:unexpected> "corrupt" .
      } }
    `);
    await expect(store.commitWalProjectionV1(commit('after-corruption', {
      expectedActiveHeadsDigest: valid.newActiveHeadsDigest,
      deleteQuads: [],
    }))).rejects.toBeInstanceOf(WalProjectionIntegrityError);
    await store.close();
  });

  it('proves the Oxigraph multi-operation request rolls back after a late runtime failure', () => {
    const raw = new oxigraph.Store();
    raw.load('<urn:old> <urn:test:value> "old" <urn:test:production> .\n', {
      format: 'application/n-quads',
    });
    const input = commit('rollback', { deleteQuads: [] });
    const plan = buildWalProjectionCommitPlanV1(input);
    expect(() => raw.update(
      `${plan.update};\nMOVE GRAPH <urn:test:missing-staging-graph> TO GRAPH <urn:test:must-not-exist>`,
    )).toThrow();
    expect(raw.match(null, null, null, oxigraph.namedNode(contentGraph))).toHaveLength(0);
    expect(raw.match(null, null, null, oxigraph.namedNode(conflictGraph))).toHaveLength(0);
    expect(raw.match(null, null, null, oxigraph.namedNode(WAL_PROJECTION_MARKER_GRAPH))).toHaveLength(0);
    expect(raw.match(null, null, null, oxigraph.namedNode('urn:test:production'))).toHaveLength(1);
  });

  it('rebuilds a corrupt scope from complete graphs and removes stale scope graphs', async () => {
    const store = new OxigraphStore();
    const staleGraph = walProjectionShadowGraphV1(namespaceId, logicalKey, 'stale');
    await store.insert([
      quad('urn:stale', '"stale"', staleGraph),
      {
        subject: `urn:dkg:wal:projection:v1:${Buffer.from(namespaceId).toString('hex')}:${Buffer.from(logicalKey).toString('hex')}`,
        predicate: 'urn:dkg:wal:projection:v1:unexpected',
        object: '"corrupt"',
        graph: WAL_PROJECTION_MARKER_GRAPH,
      },
    ]);
    const rebuilt = commit('rebuilt', {
      mode: 'REBUILD',
      expectedActiveHeadsDigest: null,
      replaceSubjects: [],
      deleteQuads: [],
      insertQuads: [],
    });

    await expect(store.commitWalProjectionV1(rebuilt)).resolves.toMatchObject({ status: 'COMMITTED' });
    expect(await store.hasGraph(staleGraph)).toBe(false);
    expect(await bindings(store, contentGraph)).toEqual([
      { s: 'urn:new:content', p: 'urn:test:value', o: '"rebuilt"' },
    ]);
    expect(await readWalProjectionMarkerV1(store, namespaceId, logicalKey)).toEqual(
      buildWalProjectionCommitPlanV1(rebuilt).marker,
    );
    await store.close();
  });

  it('persists the transaction and exact marker across restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wal-projection-persistence-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'store.nq');
    const input = commit('persistent', { deleteQuads: [] });
    const first = new OxigraphStore(path);
    await first.commitWalProjectionV1(input);
    await first.flush();
    await first.close();

    const second = new OxigraphStore(path);
    expect(await bindings(second, contentGraph)).toHaveLength(1);
    expect(await readWalProjectionMarkerV1(second, namespaceId, logicalKey)).toEqual(
      buildWalProjectionCommitPlanV1(input).marker,
    );
    await second.close();
  });

  it('forwards the capability through production decorators without entering legacy changelog', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wal-projection-blobs-'));
    temporaryDirectories.push(directory);
    const raw = new OxigraphStore();
    const records: unknown[] = [];
    const wrapped = new ChangelogStore(
      new GraphSetIndexStore(
        new SharedMemoryLiteralBlobStore(raw, { blobDir: directory, thresholdBytes: 64 }),
      ),
      { onAppend: record => records.push(record) },
    );
    expect(walProjectionStoreCapabilityV1(wrapped)).toEqual({
      transactionVersion: 'v1',
      authoritativeEligible: true,
    });
    await expect(wrapped.commitWalProjectionV1!(commit('wrapped', { deleteQuads: [] })))
      .resolves.toMatchObject({ status: 'COMMITTED' });
    expect(records).toEqual([]);
    expect(await wrapped.listGraphs()).toEqual([]);
    await wrapped.close();
  });

  it('marks only proven Oxigraph capabilities authoritative and supports the worker adapter', async () => {
    const unsupported = {} as TripleStore;
    expect(walProjectionStoreCapabilityV1(unsupported)).toEqual({
      transactionVersion: null,
      authoritativeEligible: false,
    });
    await expect(tryCommitWalProjectionV1(unsupported, commit('unsupported'))).resolves.toBeNull();
    for (const ineligible of [
      new BlazegraphStore('http://127.0.0.1:1'),
      new SparqlHttpStore({ queryEndpoint: 'http://127.0.0.1:1' }),
    ]) {
      expect(walProjectionStoreCapabilityV1(ineligible)).toEqual({
        transactionVersion: null,
        authoritativeEligible: false,
      });
      await expect(tryCommitWalProjectionV1(ineligible, commit('ineligible'))).resolves.toBeNull();
      await ineligible.close();
    }

    const worker = new OxigraphWorkerStore();
    try {
      expect(walProjectionStoreCapabilityV1(worker).authoritativeEligible).toBe(true);
      await expect(worker.commitWalProjectionV1(commit('worker', { deleteQuads: [] })))
        .resolves.toMatchObject({ status: 'COMMITTED' });
      expect(await readWalProjectionMarkerV1(worker, namespaceId, logicalKey)).toEqual(
        buildWalProjectionCommitPlanV1(commit('worker', { deleteQuads: [] })).marker,
      );
    } finally {
      await worker.close().catch(() => {});
    }
  });
});
