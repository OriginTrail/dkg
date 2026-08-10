import { describe, expect, it, vi } from 'vitest';

import {
  BOUNDED_MUTATION_MAX_SOURCE_GRAPHS,
  buildStructuredMutationUpdate,
  captureStructuredMutationEffects,
  captureStructuredMutationSnapshot,
  type StructuredMutationSnapshot,
} from '../src/bounded-structured-mutation.js';
import { GraphSetIndexStore } from '../src/graph-set-index-store.js';
import { materializeStructuredMutation } from '../src/structured-mutation-materialization-internal.js';
import type { StructuredMutation, TripleStore } from '../src/triple-store.js';

const GRAPH = 'urn:test:preparation';
const TARGET = 'urn:test:preparation:target';
const PREDICATE = 'urn:test:preparation:predicate';

function deleteMutation(subjects: readonly string[] = ['urn:test:subject']): StructuredMutation {
  return { kind: 'delete-subjects', input: { graphUri: GRAPH, subjects } };
}

describe('structured mutation preparation', () => {
  it('captures one deeply frozen caller-independent snapshot and reuses its identity', () => {
    const subjects = ['urn:test:subject'];
    const mutation = deleteMutation(subjects);
    const snapshot = captureStructuredMutationSnapshot(mutation);

    subjects[0] = 'urn:test:redirected';
    expect(snapshot.mutation).toEqual({
      kind: 'delete-subjects',
      input: { graphUri: GRAPH, subjects: ['urn:test:subject'] },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.mutation)).toBe(true);
    expect(Object.isFrozen(snapshot.mutation.input)).toBe(true);
    expect(snapshot.mutation.kind === 'delete-subjects'
      && Object.isFrozen(snapshot.mutation.input.subjects)).toBe(true);
    expect(captureStructuredMutationSnapshot(snapshot.mutation)).toBe(snapshot);
    expect(captureStructuredMutationSnapshot({ ...snapshot.mutation })).not.toBe(snapshot);
    expect(() => {
      (snapshot.mutation.input as { graphUri: string }).graphUri = TARGET;
    }).toThrow(TypeError);
  });

  it('keeps final backend materialization off the package-root surface', async () => {
    const storage = await import('../src/index.js');
    expect('materializeStructuredMutation' in storage).toBe(false);
  });

  it('reads accessor-backed descriptors and proxy-array entries exactly once', () => {
    const reads = new Map<string, number>();
    const read = <T>(key: string, value: T): T => {
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return value;
    };
    const subjects = new Proxy(['urn:test:subject'], {
      get(target, property, receiver) {
        if (property === 'length' || property === '0') read(`subjects.${String(property)}`, null);
        return Reflect.get(target, property, receiver);
      },
    });
    const input = Object.defineProperties({}, {
      graphUri: { enumerable: true, get: () => read('graphUri', GRAPH) },
      subjects: { enumerable: true, get: () => read('subjects', subjects) },
    });
    const mutation = Object.defineProperties({}, {
      kind: { enumerable: true, get: () => read('kind', 'delete-subjects') },
      input: { enumerable: true, get: () => read('input', input) },
    }) as StructuredMutation;

    const snapshot = captureStructuredMutationSnapshot(mutation);

    expect(snapshot.mutation).toEqual(deleteMutation());
    expect(Object.fromEntries(reads)).toEqual({
      kind: 1,
      input: 1,
      graphUri: 1,
      subjects: 1,
      'subjects.length': 1,
      'subjects.0': 1,
    });
  });

  it('copies exact quad fields and cannot be redirected after capture', () => {
    const quad = {
      subject: 'urn:test:subject',
      predicate: PREDICATE,
      object: '"before"',
      graph: GRAPH,
      ignored: 'caller-only',
    };
    const snapshot = captureStructuredMutationSnapshot({
      kind: 'replace-subject-predicates',
      input: {
        graphUri: GRAPH,
        subject: quad.subject,
        predicates: [PREDICATE],
        replacementQuads: [quad],
      },
    });
    quad.object = '"after"';
    quad.graph = TARGET;

    expect(snapshot.mutation.kind).toBe('replace-subject-predicates');
    if (snapshot.mutation.kind !== 'replace-subject-predicates') return;
    expect(snapshot.mutation.input.replacementQuads).toEqual([{
      subject: 'urn:test:subject',
      predicate: PREDICATE,
      object: '"before"',
      graph: GRAPH,
    }]);
    expect(Object.isFrozen(snapshot.mutation.input.replacementQuads[0])).toBe(true);
    expect('ignored' in snapshot.mutation.input.replacementQuads[0]).toBe(false);
  });

  it('materializes every trusted snapshot without replacing its operands', () => {
    const mutations: StructuredMutation[] = [
      deleteMutation(),
      { kind: 'prune-ranked-subjects', input: {
        graphUri: GRAPH,
        subjectPrefix: 'urn:test:ranked:',
        eligibilityPredicate: PREDICATE,
        eligibleObjects: ['approved'],
        primaryRankPredicate: 'urn:test:rank:primary',
        secondaryRankPredicate: 'urn:test:rank:secondary',
        retainNewest: 1,
        maxDelete: 1,
      } },
      { kind: 'prune-linked-record-closures', input: {
        graphUri: GRAPH,
        matchObjectIris: ['urn:test:agent'],
        linkPredicates: [PREDICATE],
        recordParentPredicate: 'urn:test:parent',
        descendantSeparator: '/',
      } },
      { kind: 'replace-subject-predicates', input: {
        graphUri: GRAPH,
        subject: 'urn:test:subject',
        predicates: [PREDICATE],
        replacementQuads: [{
          subject: 'urn:test:subject', predicate: PREDICATE, object: '"value"', graph: GRAPH,
        }],
      } },
      { kind: 'replace-projection-from-graph', input: {
        targetGraphUri: TARGET,
        stagingGraphUri: 'urn:test:preparation:staging',
        targetSubject: 'urn:test:subject',
        preservedTargetPredicates: [PREDICATE],
        targetSubjectPrefixes: [],
      } },
      { kind: 'copy-subject-projection', input: {
        sourceGraphUris: [GRAPH],
        targetGraphUri: TARGET,
        roots: ['urn:test:subject'],
        descendantSuffix: '/',
        excludedPredicates: [],
      } },
    ];

    for (const mutation of mutations) {
      const snapshot = captureStructuredMutationSnapshot(mutation);
      const capturedInput = snapshot.mutation.input;
      const materialized = materializeStructuredMutation(snapshot);
      expect(materialized.outcome).toBe('execute');
      if (materialized.outcome !== 'execute') continue;
      expect(materialized.snapshot).toBe(snapshot);
      expect(materialized.snapshot.mutation.input).toBe(capturedInput);
      expect(materialized.update).toBe(buildStructuredMutationUpdate(mutation));
    }
  });

  it('classifies no-op only after trusted deferred validation', () => {
    const snapshot = captureStructuredMutationSnapshot(deleteMutation([]));
    expect(snapshot.outcome).toBe('noop');
    expect(snapshot.effects).toBeUndefined();
    expect(materializeStructuredMutation(snapshot)).toEqual({ outcome: 'noop', snapshot });
  });

  it('rejects copied or forged snapshots at the internal materialization boundary', () => {
    const snapshot = captureStructuredMutationSnapshot(deleteMutation());
    const copied = { ...snapshot } as StructuredMutationSnapshot;
    const forged = {
      ...snapshot,
      mutation: { ...snapshot.mutation },
    } as StructuredMutationSnapshot;

    expect(() => materializeStructuredMutation(copied)).toThrow(/not trusted/);
    expect(() => materializeStructuredMutation(forged)).toThrow(/not trusted/);
  });

  it('defers the aggregate replacement budget until after snapshot capture', () => {
    const object = JSON.stringify('x'.repeat(4 * 1024 * 1024));
    const snapshot = captureStructuredMutationSnapshot({
      kind: 'replace-subject-predicates',
      input: {
        graphUri: GRAPH,
        subject: 'urn:test:subject',
        predicates: [PREDICATE],
        replacementQuads: [{
          subject: 'urn:test:subject', predicate: PREDICATE, object, graph: GRAPH,
        }],
      },
    });

    expect(snapshot.outcome).toBe('candidate');
    expect(() => materializeStructuredMutation(snapshot)).toThrow(/operand bytes/);
  });

  it('preserves the non-validating synchronous effects compatibility helper', () => {
    const malformed = {
      kind: 'delete-subjects',
      input: { graphUri: 'relative', subjects: [] },
    } as StructuredMutation;
    expect(captureStructuredMutationEffects(malformed)).toBeUndefined();
    expect(() => captureStructuredMutationSnapshot(malformed)).toThrow(/absolute IRI/);
  });

  it.each(invalidSnapshotDescriptors())(
    'rejects the $name descriptor through snapshot capture',
    ({ mutation, expected }) => {
      expect(() => captureStructuredMutationSnapshot(mutation)).toThrow(expected);
    },
  );

  it('rejects an invalid descriptor in a decorator before inner I/O', async () => {
    const operation = vi.fn(async () => {});
    const store = new GraphSetIndexStore({
      structuredMutation: operation,
    } as unknown as TripleStore);

    await expect(store.structuredMutation({
      kind: 'copy-subject-projection',
      input: {
        sourceGraphUris: [GRAPH],
        targetGraphUri: GRAPH,
        roots: ['urn:test:subject'],
        descendantSuffix: '/',
        excludedPredicates: [],
      },
    })).rejects.toThrow(/must not be a source/);
    expect(operation).not.toHaveBeenCalled();
  });
});

function invalidSnapshotDescriptors(): Array<{
  name: string;
  mutation: StructuredMutation;
  expected: RegExp;
}> {
  const sparseSubjects = Array(2) as string[];
  sparseSubjects[1] = 'urn:test:subject';
  return [
    {
      name: 'sparse',
      mutation: deleteMutation(sparseSubjects),
      expected: /dense array/,
    },
    {
      name: 'duplicate',
      mutation: deleteMutation(['urn:test:subject', 'urn:test:subject']),
      expected: /duplicate/,
    },
    {
      name: 'oversized',
      mutation: {
        kind: 'copy-subject-projection',
        input: {
          sourceGraphUris: Array.from(
            { length: BOUNDED_MUTATION_MAX_SOURCE_GRAPHS + 1 },
            (_, index) => `urn:test:source:${index}`,
          ),
          targetGraphUri: TARGET,
          roots: ['urn:test:subject'],
          descendantSuffix: '/',
          excludedPredicates: [],
        },
      },
      expected: /must contain/,
    },
    {
      name: 'cross-scope',
      mutation: {
        kind: 'replace-subject-predicates',
        input: {
          graphUri: GRAPH,
          subject: 'urn:test:subject',
          predicates: [PREDICATE],
          replacementQuads: [{
            subject: 'urn:test:subject',
            predicate: PREDICATE,
            object: '"value"',
            graph: TARGET,
          }],
        },
      },
      expected: /must target subject/,
    },
    {
      name: 'same source and target',
      mutation: {
        kind: 'copy-subject-projection',
        input: {
          sourceGraphUris: [GRAPH],
          targetGraphUri: GRAPH,
          roots: ['urn:test:subject'],
          descendantSuffix: '/',
          excludedPredicates: [],
        },
      },
      expected: /must not be a source/,
    },
  ];
}
