import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  ChangelogStore,
  GraphSetIndexStore,
  SharedMemoryLiteralBlobStore,
  OxigraphStore,
  OxigraphWorkerStore,
  TRIPLE_STORE_CAPABILITY_SUPPORT,
  UnsupportedTripleStoreCapabilityError,
  captureStructuredMutationEffects,
  supportsReplaceSubjectPredicatesAtomically,
  supportsTripleStoreCapability,
  tryCopySubjectProjection,
  tryDeleteSubjects,
  tryReplaceProjectionFromGraphAtomically,
  type Quad,
  type StructuredMutation,
  type TripleStore,
} from '../src/index.js';
import {
  BOUNDED_MUTATION_MAX_IRIS,
  BOUNDED_MUTATION_MAX_UPDATE_BYTES,
  buildCopySubjectProjectionUpdate,
  buildDeleteSubjectsUpdate,
  buildStructuredMutationUpdate,
  chunkCopySubjectProjectionInput,
  normalizeCopySubjectProjectionInput,
  normalizeDeleteSubjectsInput,
  normalizeReplaceSubjectPredicatesInput,
} from '../src/bounded-structured-mutation.js';
import { linkStoreChainV1 } from '../src/store-chain-capability.js';

const GRAPH = 'urn:test:bounded';
const OTHER_GRAPH = 'urn:test:bounded:other';
const P = 'urn:test:p';
const STATUS = 'urn:test:status';
const REQUESTED_AT = 'urn:test:requested-at';
const DECIDED_AT = 'urn:test:decided-at';

function quad(subject: string, predicate: string, object: string, graph = GRAPH): Quad {
  return { subject, predicate, object, graph };
}

async function rows(store: TripleStore, graph: string): Promise<Array<Record<string, string>>> {
  const result = await store.query(
    `SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } } ORDER BY ?s ?p ?o`,
  );
  return result.type === 'bindings' ? result.bindings : [];
}

describe('bounded structured mutation capabilities', () => {
  it('preserves the canonical update bytes for every mutation kind and the no-op shape', () => {
    const fixtures: ReadonlyArray<readonly [string, StructuredMutation, number, string]> = [
      ['delete-subjects', {
        kind: 'delete-subjects',
        input: { graphUri: GRAPH, subjects: ['urn:test:a', 'urn:test:b'] },
      }, 184, '1816e8bb2a177b1a5abc7b66b0d716b9ecfa39caccbc57280add47bc25b7f775'],
      ['prune-ranked-subjects', {
        kind: 'prune-ranked-subjects',
        input: {
          graphUri: GRAPH,
          subjectPrefix: 'urn:test:req:',
          eligibilityPredicate: STATUS,
          eligibleObjects: ['approved', 'rejected'],
          primaryRankPredicate: DECIDED_AT,
          secondaryRankPredicate: REQUESTED_AT,
          retainNewest: 5,
          maxDelete: 10,
        },
      }, 1_460, 'a4383f845f8eaa592d6e48932c9d1a37623d933e7c550970fea711d040a9f491'],
      ['prune-linked-record-closures', {
        kind: 'prune-linked-record-closures',
        input: {
          graphUri: GRAPH,
          matchObjectIris: ['urn:test:agent'],
          linkPredicates: [P],
          recordParentPredicate: STATUS,
          protectedRecordIri: 'urn:test:keep',
          descendantSeparator: '/',
        },
      }, 478, 'a5b262cba67f38f7467316f2e39f917c9c51a96593a10d55c8f1e589a1df9a1f'],
      ['replace-subject-predicates', {
        kind: 'replace-subject-predicates',
        input: {
          graphUri: GRAPH,
          subject: 'urn:test:a',
          predicates: [P],
          replacementQuads: [quad('urn:test:a', P, '"value"')],
        },
      }, 310, '63257772a038004b2043e8946de4f8da682e90e7bcf6156807520966e3f256b8'],
      ['replace-projection-from-graph', {
        kind: 'replace-projection-from-graph',
        input: {
          targetGraphUri: GRAPH,
          stagingGraphUri: OTHER_GRAPH,
          targetSubject: 'urn:test:a',
          preservedTargetPredicates: [P],
          targetSubjectPrefixes: ['urn:test:child:'],
        },
      }, 618, '1f15cafd7c386ee0f32f742d9188bb53d04e8b026c0aa984302603a2b615fe21'],
      ['copy-subject-projection', {
        kind: 'copy-subject-projection',
        input: {
          sourceGraphUris: [GRAPH],
          targetGraphUri: OTHER_GRAPH,
          roots: ['urn:test:a'],
          descendantSuffix: '/',
          excludedPredicates: [P],
        },
      }, 434, '16d90e11bc91e1aaa049a5f56b4f55ec03e27090205010fb3a76e64508685ec1'],
      ['delete-subjects/noop', {
        kind: 'delete-subjects',
        input: { graphUri: GRAPH, subjects: [] },
      }, 0, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ];

    for (const [label, mutation, expectedBytes, expectedHash] of fixtures) {
      const update = buildStructuredMutationUpdate(mutation);
      const bytes = update === undefined ? Buffer.alloc(0) : Buffer.from(update, 'utf8');
      expect(bytes.byteLength, label).toBe(expectedBytes);
      expect(createHash('sha256').update(bytes).digest('hex'), label).toBe(expectedHash);
      expect(update === undefined, label).toBe(label.endsWith('/noop'));
    }
  });

  it('captures immutable graph effects before dispatch', () => {
    const mutation = {
      kind: 'copy-subject-projection' as const,
      input: {
        sourceGraphUris: [GRAPH],
        targetGraphUri: OTHER_GRAPH,
        roots: ['urn:test:a'],
        descendantSuffix: '/',
        excludedPredicates: [],
      },
    };

    const effects = captureStructuredMutationEffects(mutation);
    mutation.input.targetGraphUri = 'urn:test:redirected';
    expect(effects).toEqual({ touchedGraphs: [OTHER_GRAPH] });
    expect(Object.isFrozen(effects)).toBe(true);
    expect(Object.isFrozen(effects.touchedGraphs)).toBe(true);
  });

  it('classifies structural no-ops without store orchestration', () => {
    expect(captureStructuredMutationEffects({
      kind: 'delete-subjects',
      input: { graphUri: GRAPH, subjects: [] },
    })).toBeUndefined();
    expect(captureStructuredMutationEffects({
      kind: 'delete-subjects',
      input: { graphUri: GRAPH, subjects: ['urn:test:a'] },
    })).toEqual({ touchedGraphs: [GRAPH] });
  });

  it('reports the canonical target graph for every structured mutation kind', async () => {
    const mutations: Array<readonly [StructuredMutation, string]> = [
      [{ kind: 'delete-subjects', input: {
        graphUri: GRAPH, subjects: ['urn:test:a'],
      } }, GRAPH],
      [{ kind: 'prune-ranked-subjects', input: {
        graphUri: GRAPH, subjectPrefix: 'urn:test:req:', eligibilityPredicate: STATUS,
        eligibleObjects: ['approved'], primaryRankPredicate: DECIDED_AT,
        secondaryRankPredicate: REQUESTED_AT, retainNewest: 1, maxDelete: 1,
      } }, GRAPH],
      [{ kind: 'prune-linked-record-closures', input: {
        graphUri: GRAPH, matchObjectIris: ['urn:test:agent'], linkPredicates: [P],
        recordParentPredicate: STATUS, descendantSeparator: '/',
      } }, GRAPH],
      [{ kind: 'replace-subject-predicates', input: {
        graphUri: GRAPH, subject: 'urn:test:a', predicates: [P],
        replacementQuads: [quad('urn:test:a', P, '"replacement"')],
      } }, GRAPH],
      [{ kind: 'replace-projection-from-graph', input: {
        targetGraphUri: GRAPH, stagingGraphUri: 'urn:test:staging',
        targetSubject: 'urn:test:a', preservedTargetPredicates: [],
        targetSubjectPrefixes: [],
      } }, GRAPH],
      [{ kind: 'copy-subject-projection', input: {
        sourceGraphUris: [GRAPH], targetGraphUri: OTHER_GRAPH,
        roots: ['urn:test:a'], descendantSuffix: '/', excludedPredicates: [],
      } }, OTHER_GRAPH],
    ];
    for (const [mutation, expectedGraph] of mutations) {
      expect(captureStructuredMutationEffects(mutation)).toEqual({
        touchedGraphs: [expectedGraph],
      });
    }
  });

  it('deletes one explicit subject set and preserves co-located rows', async () => {
    const store = new OxigraphStore();
    await store.insert([
      quad('urn:test:a', P, '"a"'),
      quad('urn:test:b', P, '"b"'),
      quad('urn:test:c', P, '"c"'),
    ]);

    await store.structuredMutation({
      kind: 'delete-subjects',
      input: { graphUri: GRAPH, subjects: ['urn:test:a', 'urn:test:c'] },
    });

    expect(await rows(store, GRAPH)).toEqual([{ s: 'urn:test:b', p: P, o: '"b"' }]);
  });

  it('prunes only bounded terminal overflow and rechecks terminal state in the delete', async () => {
    const store = new OxigraphStore();
    await store.insert([
      quad('urn:test:req:old', STATUS, '"approved"'),
      quad('urn:test:req:old', DECIDED_AT, '"1"'),
      quad('urn:test:req:new', STATUS, '"rejected"'),
      quad('urn:test:req:new', DECIDED_AT, '"2"'),
      // A reused record with one terminal and one non-terminal status must survive.
      quad('urn:test:req:reused', STATUS, '"approved"'),
      quad('urn:test:req:reused', STATUS, '"pending"'),
      quad('urn:test:req:reused', REQUESTED_AT, '"0"'),
    ]);

    await store.structuredMutation({ kind: 'prune-ranked-subjects', input: {
      graphUri: GRAPH,
      subjectPrefix: 'urn:test:req:',
      eligibilityPredicate: STATUS,
      eligibleObjects: ['approved', 'rejected'],
      primaryRankPredicate: DECIDED_AT,
      secondaryRankPredicate: REQUESTED_AT,
      retainNewest: 1,
      maxDelete: 1,
    } });

    const remaining = await rows(store, GRAPH);
    expect(remaining.some((row) => row.s === 'urn:test:req:old')).toBe(false);
    expect(remaining.some((row) => row.s === 'urn:test:req:new')).toBe(true);
    expect(remaining.some((row) => row.s === 'urn:test:req:reused')).toBe(true);
  });

  it('prunes complete record closures while preserving the protected root', async () => {
    const store = new OxigraphStore();
    const memberPredicate = 'urn:test:member';
    const parentPredicate = 'urn:test:parent';
    await store.insert([
      quad('urn:test:record:old/1', memberPredicate, 'urn:test:agent'),
      quad('urn:test:record:old/1', parentPredicate, 'urn:test:record:old'),
      quad('urn:test:record:old', P, '"old"'),
      quad('urn:test:record:keep', memberPredicate, 'urn:test:agent'),
      quad('urn:test:record:keep', P, '"keep"'),
      quad('urn:test:unrelated', P, '"unrelated"'),
    ]);

    await store.structuredMutation({ kind: 'prune-linked-record-closures', input: {
      graphUri: GRAPH,
      matchObjectIris: ['urn:test:agent'],
      linkPredicates: [memberPredicate],
      recordParentPredicate: parentPredicate,
      protectedRecordIri: 'urn:test:record:keep',
      descendantSeparator: '/',
    } });

    const remaining = await rows(store, GRAPH);
    expect(remaining.some((row) => row.s.startsWith('urn:test:record:old'))).toBe(false);
    expect(remaining.some((row) => row.s === 'urn:test:record:keep')).toBe(true);
    expect(remaining.some((row) => row.s === 'urn:test:unrelated')).toBe(true);
  });

  it('atomically replaces only declared predicates on one subject', async () => {
    const store = new OxigraphStore();
    const subject = 'urn:test:request';
    await store.insert([
      quad(subject, STATUS, '"pending"'),
      quad(subject, DECIDED_AT, '"1"'),
      quad(subject, 'urn:test:signed-delegation', '"preserve"'),
    ]);

    await store.structuredMutation({ kind: 'replace-subject-predicates', input: {
      graphUri: GRAPH,
      subject,
      predicates: [STATUS, DECIDED_AT],
      replacementQuads: [
        quad(subject, STATUS, '"approved"'),
        quad(subject, DECIDED_AT, '"2"'),
      ],
    } });

    expect(await rows(store, GRAPH)).toEqual([
      { s: subject, p: DECIDED_AT, o: '"2"' },
      { s: subject, p: 'urn:test:signed-delegation', o: '"preserve"' },
      { s: subject, p: STATUS, o: '"approved"' },
    ]);
  });

  it('replaces one staged projection while preserving local tombstones and unrelated subjects', async () => {
    const store = new OxigraphStore();
    const target = 'urn:test:meta';
    const staging = 'urn:test:staging';
    const subject = 'urn:test:cg';
    const revoked = 'urn:test:revoked';
    const delegationPrefix = 'urn:test:delegation:';
    await store.insert([
      quad(subject, P, '"stale"', target),
      quad(subject, revoked, 'urn:test:agent:revoked', target),
      quad(`${delegationPrefix}old`, P, '"stale"', target),
      quad('urn:test:unrelated', P, '"keep"', target),
      quad(subject, P, '"fresh"', staging),
      quad(`${delegationPrefix}new`, P, '"fresh"', staging),
      quad('urn:test:staging-unrelated', P, '"do-not-copy"', staging),
    ]);

    await store.structuredMutation({ kind: 'replace-projection-from-graph', input: {
      targetGraphUri: target,
      stagingGraphUri: staging,
      targetSubject: subject,
      preservedTargetPredicates: [revoked],
      targetSubjectPrefixes: [delegationPrefix],
    } });

    expect(await rows(store, target)).toEqual([
      { s: subject, p: P, o: '"fresh"' },
      { s: subject, p: revoked, o: 'urn:test:agent:revoked' },
      { s: `${delegationPrefix}new`, p: P, o: '"fresh"' },
      { s: 'urn:test:unrelated', p: P, o: '"keep"' },
    ]);
  });

  it('copies exact subject closures from bounded sources without RDF term round-tripping', async () => {
    const store = new OxigraphStore();
    const sourceA = 'urn:test:source:a';
    const sourceB = 'urn:test:source:b';
    const target = 'urn:test:target';
    const root = 'urn:test:root';
    const excluded = 'urn:test:excluded';
    const escapeBearing = JSON.stringify('line1\\line2\n"quoted" µ');
    await store.insert([
      quad(root, P, escapeBearing, sourceA),
      quad(`${root}/.well-known/genid/1`, P, '"child"', sourceB),
      quad(root, excluded, '"skip"', sourceB),
      quad('urn:test:other', P, '"other"', sourceA),
      quad(root, P, '"wrong graph"', OTHER_GRAPH),
    ]);

    await store.structuredMutation({ kind: 'copy-subject-projection', input: {
      sourceGraphUris: [sourceA, sourceB],
      targetGraphUri: target,
      roots: [root],
      descendantSuffix: '/.well-known/genid/',
      excludedPredicates: [excluded],
    } });

    expect(await rows(store, target)).toEqual([
      { s: root, p: P, o: escapeBearing },
      { s: `${root}/.well-known/genid/1`, p: P, o: '"child"' },
    ]);
  });

  it('chunks oversized subject projection roots below the encoded update budget', () => {
    const roots = Array.from(
      { length: 10 },
      (_, index) => `urn:test:large-root:${index}:${'x'.repeat(500_000)}`,
    );
    const input = {
      sourceGraphUris: [GRAPH],
      targetGraphUri: OTHER_GRAPH,
      roots,
      descendantSuffix: '/.well-known/genid/',
      excludedPredicates: [P],
    };

    expect(() => buildCopySubjectProjectionUpdate(input)).toThrow(/exceeds/);
    const chunks = chunkCopySubjectProjectionInput(input);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flatMap((chunk) => chunk.roots)).toEqual(roots);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(buildCopySubjectProjectionUpdate(chunk), 'utf8'))
        .toBeLessThanOrEqual(BOUNDED_MUTATION_MAX_UPDATE_BYTES);
    }
    for (let index = 0; index < chunks.length - 1; index++) {
      expect(() => buildCopySubjectProjectionUpdate({
        ...chunks[index],
        roots: [...chunks[index].roots, chunks[index + 1].roots[0]],
      })).toThrow(/exceeds/);
    }
  });

  it('reports atomic predicate replacement support at the operation boundary', () => {
    const updateOnly = new GraphSetIndexStore({ update: vi.fn() } as unknown as TripleStore);
    const incapable = new GraphSetIndexStore({} as TripleStore);

    expect(supportsTripleStoreCapability(updateOnly, 'structuredMutation')).toBe(false);
    expect(supportsReplaceSubjectPredicatesAtomically(updateOnly)).toBe(true);
    expect(supportsReplaceSubjectPredicatesAtomically(incapable)).toBe(false);
  });

  it('preserves bounded projection operations for update-only stores', async () => {
    const update = vi.fn(async () => undefined);
    const store = { update } as unknown as TripleStore;
    const projection = {
      targetGraphUri: OTHER_GRAPH,
      stagingGraphUri: 'urn:test:staging',
      targetSubject: 'urn:test:subject',
      preservedTargetPredicates: [STATUS],
      targetSubjectPrefixes: ['urn:test:prefix:'],
    };
    const copy = {
      sourceGraphUris: [GRAPH],
      targetGraphUri: OTHER_GRAPH,
      roots: ['urn:test:root'],
      descendantSuffix: '/.well-known/genid/',
      excludedPredicates: [STATUS],
    };

    await expect(tryReplaceProjectionFromGraphAtomically(store, projection))
      .resolves.toBe(true);
    await expect(tryCopySubjectProjection(store, copy)).resolves.toBe(true);
    expect(update).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(`GRAPH <${OTHER_GRAPH}>`),
      { touchedGraphs: [OTHER_GRAPH] },
    );
    expect(update).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('VALUES ?root { <urn:test:root> }'),
      { touchedGraphs: [OTHER_GRAPH] },
    );
  });

  it('dispatches a max accepted subject set as one embedded update', async () => {
    const store = new OxigraphStore();
    const embedded = (store as unknown as { store: { update: (sparql: string) => void } }).store;
    const update = vi.spyOn(embedded, 'update').mockImplementation(() => undefined);
    const subjects = Array.from(
      { length: BOUNDED_MUTATION_MAX_IRIS },
      (_, index) => `urn:test:subject:${index}`,
    );

    await store.structuredMutation({ kind: 'delete-subjects', input: { graphUri: GRAPH, subjects } });

    expect(update).toHaveBeenCalledTimes(1);
  });

  it('rejects sparse, duplicate, oversized, and cross-scope descriptors before dispatch', () => {
    const sparse = Array(2) as string[];
    sparse[1] = 'urn:test:a';
    expect(() => normalizeDeleteSubjectsInput({ graphUri: GRAPH, subjects: sparse }))
      .toThrow(/dense array/);
    expect(() => normalizeDeleteSubjectsInput({
      graphUri: GRAPH,
      subjects: ['urn:test:a', 'urn:test:a'],
    })).toThrow(/duplicate/);
    expect(() => normalizeDeleteSubjectsInput({
      graphUri: GRAPH,
      subjects: ['_:blank'],
    })).toThrow(/absolute IRI/);
    expect(() => normalizeDeleteSubjectsInput({
      graphUri: 'relative-graph',
      subjects: ['urn:test:a'],
    })).toThrow(/absolute IRI/);
    expect(() => normalizeDeleteSubjectsInput({
      graphUri: GRAPH,
      subjects: Array(BOUNDED_MUTATION_MAX_IRIS + 1).fill('urn:test:a'),
    })).toThrow(/must contain/);

    const sparseQuads = Array(2) as Quad[];
    sparseQuads[1] = quad('urn:test:a', P, '"a"');
    expect(() => normalizeReplaceSubjectPredicatesInput({
      graphUri: GRAPH,
      subject: 'urn:test:a',
      predicates: [P],
      replacementQuads: sparseQuads,
    })).toThrow(/dense array/);
    expect(() => normalizeReplaceSubjectPredicatesInput({
      graphUri: GRAPH,
      subject: 'urn:test:a',
      predicates: [P],
      replacementQuads: [quad('urn:test:a', P, 'relative-object')],
    })).toThrow(/absolute IRI/);

    expect(() => normalizeCopySubjectProjectionInput({
      sourceGraphUris: [GRAPH],
      targetGraphUri: GRAPH,
      roots: ['urn:test:a'],
      descendantSuffix: '/',
      excludedPredicates: [],
    })).toThrow(/must not be a source/);
  });

  it('rejects a generated request whose syntax overhead crosses the byte cap', () => {
    const subjects = Array.from(
      { length: 75_000 },
      (_, index) => `urn:test:${index.toString().padStart(5, '0')}:${'x'.repeat(40)}`,
    );
    expect(() => buildDeleteSubjectsUpdate({ graphUri: GRAPH, subjects }))
      .toThrow(/serialized update exceeds/);
  });

  it('reports only typed capability refusal as unsupported', async () => {
    const missing = {} as TripleStore;
    await expect(tryDeleteSubjects(missing, { graphUri: GRAPH, subjects: [] }))
      .resolves.toBe(false);

    const refusing = {
      structuredMutation: async () => {
        throw new UnsupportedTripleStoreCapabilityError('structuredMutation', 'test');
      },
    } as unknown as TripleStore;
    await expect(tryDeleteSubjects(refusing, { graphUri: GRAPH, subjects: [] }))
      .resolves.toBe(false);

    const failing = {
      structuredMutation: async () => { throw new Error('backend failed'); },
    } as unknown as TripleStore;
    await expect(tryDeleteSubjects(failing, { graphUri: GRAPH, subjects: [] }))
      .rejects.toThrow('backend failed');
  });

  it('reports structured mutation support truthfully through every decorator', async () => {
    const incapable = new ChangelogStore(new GraphSetIndexStore(
      new SharedMemoryLiteralBlobStore({} as TripleStore, {
        blobDir: '/tmp/dkg-structured-mutation-capability-test',
        thresholdBytes: 1024,
      }),
    ));
    expect(supportsTripleStoreCapability(incapable, 'structuredMutation')).toBe(false);

    const capable = new ChangelogStore(new GraphSetIndexStore(
      new SharedMemoryLiteralBlobStore(new OxigraphStore(), {
        blobDir: '/tmp/dkg-structured-mutation-capability-test',
        thresholdBytes: 1024,
      }),
    ));
    expect(supportsTripleStoreCapability(capable, 'structuredMutation')).toBe(true);
    await capable.close();
  });

  it('discovers optional operations through link-only transparent wrappers', () => {
    const capable = { structuredMutation: vi.fn() } as unknown as TripleStore;
    const capableWrapper = { structuredMutation: vi.fn() } as unknown as TripleStore;
    linkStoreChainV1(capableWrapper, capable);
    expect(supportsTripleStoreCapability(capableWrapper, 'structuredMutation')).toBe(true);

    const incapable = {} as TripleStore;
    const incapableWrapper = { structuredMutation: vi.fn() } as unknown as TripleStore;
    linkStoreChainV1(incapableWrapper, incapable);
    expect(supportsTripleStoreCapability(incapableWrapper, 'structuredMutation')).toBe(false);

    const constrainingWrapper = {
      structuredMutation: vi.fn(),
      [TRIPLE_STORE_CAPABILITY_SUPPORT]: () => false,
    } as unknown as TripleStore;
    linkStoreChainV1(constrainingWrapper, capable);
    expect(supportsTripleStoreCapability(constrainingWrapper, 'structuredMutation')).toBe(false);
  });

  it('executes every mutation variant through the real worker RPC boundary', async () => {
    const store = new OxigraphWorkerStore();
    try {
      const staging = 'urn:test:worker:staging';
      const target = 'urn:test:worker:target';
      const member = 'urn:test:worker:member';
      const parent = 'urn:test:worker:parent';
      await store.insert([
        quad('urn:test:delete', P, '"delete"'),
        quad('urn:test:req:old', STATUS, '"approved"'),
        quad('urn:test:req:old', DECIDED_AT, '"1"'),
        quad('urn:test:req:new', STATUS, '"approved"'),
        quad('urn:test:req:new', DECIDED_AT, '"2"'),
        quad('urn:test:record/1', member, 'urn:test:agent'),
        quad('urn:test:record/1', parent, 'urn:test:record'),
        quad('urn:test:record', P, '"record"'),
        quad('urn:test:subject', STATUS, '"pending"'),
        quad('urn:test:projection', P, '"fresh"', staging),
      ]);

      await store.structuredMutation({ kind: 'delete-subjects', input: {
        graphUri: GRAPH, subjects: ['urn:test:delete'],
      } });
      await store.structuredMutation({ kind: 'prune-ranked-subjects', input: {
        graphUri: GRAPH, subjectPrefix: 'urn:test:req:', eligibilityPredicate: STATUS,
        eligibleObjects: ['approved'], primaryRankPredicate: DECIDED_AT,
        secondaryRankPredicate: REQUESTED_AT, retainNewest: 1, maxDelete: 1,
      } });
      await store.structuredMutation({ kind: 'prune-linked-record-closures', input: {
        graphUri: GRAPH, matchObjectIris: ['urn:test:agent'], linkPredicates: [member],
        recordParentPredicate: parent, descendantSeparator: '/',
      } });
      await store.structuredMutation({ kind: 'replace-subject-predicates', input: {
        graphUri: GRAPH, subject: 'urn:test:subject', predicates: [STATUS],
        replacementQuads: [quad('urn:test:subject', STATUS, '"approved"')],
      } });
      await store.structuredMutation({ kind: 'replace-projection-from-graph', input: {
        targetGraphUri: target, stagingGraphUri: staging, targetSubject: 'urn:test:projection',
        preservedTargetPredicates: [], targetSubjectPrefixes: [],
      } });
      await store.structuredMutation({ kind: 'copy-subject-projection', input: {
        sourceGraphUris: [target], targetGraphUri: OTHER_GRAPH, roots: ['urn:test:projection'],
        descendantSuffix: '/', excludedPredicates: [],
      } });

      const sourceRows = await rows(store, GRAPH);
      expect(sourceRows.some((row) => row.s === 'urn:test:delete')).toBe(false);
      expect(sourceRows.some((row) => row.s === 'urn:test:req:old')).toBe(false);
      expect(sourceRows.some((row) => row.s === 'urn:test:req:new')).toBe(true);
      expect(sourceRows.some((row) => row.s === 'urn:test:record')).toBe(false);
      expect(sourceRows.some((row) => row.s === 'urn:test:record/1')).toBe(false);
      expect(sourceRows).toContainEqual({
        s: 'urn:test:subject',
        p: STATUS,
        o: '"approved"',
      });
      expect(await rows(store, target)).toEqual([
        { s: 'urn:test:projection', p: P, o: '"fresh"' },
      ]);
      expect(await rows(store, OTHER_GRAPH)).toEqual([
        { s: 'urn:test:projection', p: P, o: '"fresh"' },
      ]);
    } finally {
      await store.close();
    }
  });
});
