import { describe, expect, it, vi } from 'vitest';

import {
  BOUNDED_MUTATION_MAX_IRIS,
  buildDeleteSubjectsUpdate,
  OxigraphStore,
  OxigraphWorkerStore,
  UnsupportedTripleStoreCapabilityError,
  tryDeleteSubjects,
  type Quad,
  type TripleStore,
} from '../src/index.js';
import {
  normalizeCopySubjectProjectionInput,
  normalizeDeleteSubjectsInput,
  normalizeReplaceSubjectPredicatesInput,
} from '../src/bounded-structured-mutation.js';

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

      expect(await rows(store, OTHER_GRAPH)).toEqual([
        { s: 'urn:test:projection', p: P, o: '"fresh"' },
      ]);
    } finally {
      await store.close();
    }
  });
});
