import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CHANGELOG_GRAPH,
  ChangelogStore,
  EXTERNAL_LITERAL_REF_DATATYPE,
  GraphSetIndexStore,
  OxigraphStore,
  OxigraphWorkerStore,
  SharedMemoryLiteralBlobStore,
  captureStructuredMutationSnapshot,
  type GraphSetMutationEvent,
  type QueryOptions,
  type StructuredMutation,
} from '../src/index.js';
import {
  BOUNDED_MUTATION_MAX_OPERAND_BYTES,
  buildStructuredMutationUpdate,
} from '../src/bounded-structured-mutation.js';
import { BoundedMutationBudgetError } from '../src/structured-mutation/primitives.js';

const GRAPH = 'urn:test:composition';
const TARGET = 'urn:test:composition:target';
const PREDICATE = 'urn:test:composition:predicate';
const SWM_GRAPH = 'did:dkg:context-graph:composition/_shared_memory';

function mutationFixtures(): StructuredMutation[] {
  return [
    { kind: 'delete-subjects', input: {
      graphUri: GRAPH,
      subjects: ['urn:test:composition:delete'],
    } },
    { kind: 'prune-ranked-subjects', input: {
      graphUri: GRAPH,
      subjectPrefix: 'urn:test:composition:ranked:',
      eligibilityPredicate: PREDICATE,
      eligibleObjects: ['approved'],
      primaryRankPredicate: 'urn:test:composition:rank:primary',
      secondaryRankPredicate: 'urn:test:composition:rank:secondary',
      retainNewest: 1,
      maxDelete: 1,
    } },
    { kind: 'prune-linked-record-closures', input: {
      graphUri: GRAPH,
      matchObjectIris: ['urn:test:composition:agent'],
      linkPredicates: [PREDICATE],
      recordParentPredicate: 'urn:test:composition:parent',
      descendantSeparator: '/',
    } },
    { kind: 'replace-subject-predicates', input: {
      graphUri: GRAPH,
      subject: 'urn:test:composition:subject',
      predicates: [PREDICATE],
      replacementQuads: [{
        subject: 'urn:test:composition:subject',
        predicate: PREDICATE,
        object: '"value"',
        graph: GRAPH,
      }],
    } },
    { kind: 'replace-projection-from-graph', input: {
      targetGraphUri: TARGET,
      stagingGraphUri: 'urn:test:composition:staging',
      targetSubject: 'urn:test:composition:subject',
      preservedTargetPredicates: [PREDICATE],
      targetSubjectPrefixes: ['urn:test:composition:prefix:'],
    } },
    { kind: 'copy-subject-projection', input: {
      sourceGraphUris: [GRAPH],
      targetGraphUri: TARGET,
      roots: ['urn:test:composition:root'],
      descendantSuffix: '/',
      excludedPredicates: [PREDICATE],
    } },
  ];
}

function redirectCallerMutation(mutation: StructuredMutation): void {
  const input = mutation.input as unknown as Record<string, unknown>;
  if ('graphUri' in input) input.graphUri = 'urn:test:redirected';
  if ('targetGraphUri' in input) input.targetGraphUri = 'urn:test:redirected';
  for (const key of [
    'subjects',
    'eligibleObjects',
    'matchObjectIris',
    'predicates',
    'preservedTargetPredicates',
    'roots',
  ]) {
    const values = input[key];
    if (Array.isArray(values) && values.length > 0) values[0] = 'urn:test:redirected';
  }
  if (mutation.kind === 'replace-subject-predicates') {
    (mutation.input.replacementQuads[0] as { object: string }).object = '"redirected"';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('structured mutation composition', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('reuses one snapshot through unchanged wrappers for every mutation kind', async () => {
    const blobDir = await mkdtemp(join(tmpdir(), 'structured-mutation-composition-'));
    tempDirs.push(blobDir);
    const leaf = new OxigraphStore();
    const literal = new SharedMemoryLiteralBlobStore(leaf, {
      blobDir,
      thresholdBytes: 1_024,
    });
    const graphSet = new GraphSetIndexStore(literal);
    const changelog = new ChangelogStore(graphSet);
    const graphSetMutation = vi.spyOn(graphSet, 'structuredMutation');
    const literalMutation = vi.spyOn(literal, 'structuredMutation');
    const leafMutation = vi.spyOn(leaf, 'structuredMutation');
    const options: QueryOptions = { source: 'composition.identity' };

    try {
      for (const mutation of mutationFixtures()) {
        const expected = JSON.parse(JSON.stringify(mutation)) as StructuredMutation;
        const graphSetCalls = graphSetMutation.mock.calls.length;
        const literalCalls = literalMutation.mock.calls.length;
        const leafCalls = leafMutation.mock.calls.length;

        const pending = changelog.structuredMutation(mutation, options);
        redirectCallerMutation(mutation);
        await pending;

        const graphSetCall = graphSetMutation.mock.calls[graphSetCalls];
        const literalCall = literalMutation.mock.calls[literalCalls];
        const leafCall = leafMutation.mock.calls[leafCalls];
        expect(graphSetCall[0]).toEqual(expected);
        expect(literalCall[0]).toEqual(expected);
        expect(leafCall[0]).toEqual(expected);
        expect(graphSetCall[0]).toBe(literalCall[0]);
        expect(captureStructuredMutationSnapshot(graphSetCall[0]))
          .toBe(captureStructuredMutationSnapshot(literalCall[0]));
        if (expected.kind === 'replace-subject-predicates') {
          expect(leafCall[0]).not.toBe(literalCall[0]);
          expect(captureStructuredMutationSnapshot(leafCall[0]))
            .not.toBe(captureStructuredMutationSnapshot(literalCall[0]));
        } else {
          expect(leafCall[0]).toBe(literalCall[0]);
          expect(captureStructuredMutationSnapshot(leafCall[0]))
            .toBe(captureStructuredMutationSnapshot(literalCall[0]));
        }
        expect(Object.isFrozen(graphSetCall[0])).toBe(true);
        expect(Object.isFrozen(leafCall[0])).toBe(true);
        expect(graphSetCall[1]).toBe(options);
        expect(literalCall[1]).toBe(options);
        expect(leafCall[1]).toBe(options);
      }
    } finally {
      await changelog.close();
    }
  });

  it('runs no-op policy preflight but performs no I/O, maintenance, or generation advance', async () => {
    const blobDir = await mkdtemp(join(tmpdir(), 'structured-mutation-noop-'));
    tempDirs.push(blobDir);
    const leaf = new OxigraphStore();
    const embedded = (leaf as unknown as { store: { update: (sparql: string) => void } }).store;
    const update = vi.spyOn(embedded, 'update');
    const leafMutation = vi.spyOn(leaf, 'structuredMutation');
    const query = vi.spyOn(leaf, 'query');
    const hasGraph = vi.spyOn(leaf, 'hasGraph');
    const graphEvents: GraphSetMutationEvent[] = [];
    const changelogEvents: unknown[] = [];
    const literal = new SharedMemoryLiteralBlobStore(leaf, { blobDir, thresholdBytes: 20 });
    const graphSet = new GraphSetIndexStore(literal, {
      onMutation: (event) => graphEvents.push(event),
    });
    const changelog = new ChangelogStore(graphSet, {
      onAppend: (event) => changelogEvents.push(event),
    });
    const options = { source: 'composition.noop' };
    const generation = leaf.getWriteGen(GRAPH);

    try {
      await changelog.structuredMutation({
        kind: 'delete-subjects',
        input: { graphUri: GRAPH, subjects: [] },
      }, options);

      expect(leafMutation).toHaveBeenCalledOnce();
      expect(leafMutation.mock.calls[0][1]).toBe(options);
      expect(update).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(hasGraph).not.toHaveBeenCalled();
      expect(graphEvents).toEqual([]);
      expect(changelogEvents).toEqual([]);
      expect(leaf.getWriteGen(GRAPH)).toBe(generation);

      leafMutation.mockClear();
      await expect(changelog.structuredMutation({
        kind: 'delete-subjects',
        input: { graphUri: CHANGELOG_GRAPH, subjects: [] },
      })).rejects.toThrow(/reserved changelog plane/);
      expect(leafMutation).not.toHaveBeenCalled();

      const neutral = new GraphSetIndexStore(literal);
      await expect(neutral.structuredMutation({
        kind: 'delete-subjects',
        input: { graphUri: CHANGELOG_GRAPH, subjects: [] },
      })).resolves.toBeUndefined();
      expect(leafMutation).toHaveBeenCalledOnce();
      expect(update).not.toHaveBeenCalled();
    } finally {
      await changelog.close();
    }
  });

  it('externalizes an over-budget literal before final validation through the full stack', async () => {
    const blobDir = await mkdtemp(join(tmpdir(), 'structured-mutation-large-composition-'));
    tempDirs.push(blobDir);
    const leaf = new OxigraphStore();
    const leafMutation = vi.spyOn(leaf, 'structuredMutation');
    const literal = new SharedMemoryLiteralBlobStore(leaf, { blobDir, thresholdBytes: 20 });
    const graphSet = new GraphSetIndexStore(literal);
    const changelog = new ChangelogStore(graphSet);
    const subject = 'urn:test:composition:large-subject';
    const largeLiteral = `"${'x'.repeat(BOUNDED_MUTATION_MAX_OPERAND_BYTES + 1)}"`;

    try {
      await changelog.structuredMutation({
        kind: 'replace-subject-predicates',
        input: {
          graphUri: SWM_GRAPH,
          subject,
          predicates: [PREDICATE],
          replacementQuads: [{
            subject,
            predicate: PREDICATE,
            object: largeLiteral,
            graph: SWM_GRAPH,
          }],
        },
      });

      expect(leafMutation).toHaveBeenCalledOnce();
      const forwarded = leafMutation.mock.calls[0][0];
      expect(forwarded.kind).toBe('replace-subject-predicates');
      if (forwarded.kind !== 'replace-subject-predicates') return;
      expect(forwarded.input.replacementQuads[0].object).toBe(
        `"sha256:${sha256(largeLiteral)}"^^<${EXTERNAL_LITERAL_REF_DATATYPE}>`,
      );
      expect(await leaf.hasGraph(SWM_GRAPH)).toBe(true);
      expect(changelog.needsReconcile).toBe(false);
    } finally {
      await changelog.close();
    }
  });

  it('does not trust forged or bare low-level refusals after the inner store commits', async () => {
    const failures: ReadonlyArray<readonly [string, () => Error]> = [
      ['forged-code', () => Object.assign(
        new Error('committed then forged a clean refusal'),
        { code: 'STRUCTURED_MUTATION_PRE_DISPATCH_REFUSAL' },
      )],
      ['bare-budget', () => new BoundedMutationBudgetError(
        'committed then threw a bare budget error',
      )],
    ];

    for (const [suffix, createFailure] of failures) {
      const source = `urn:test:composition:${suffix}:source`;
      const target = `urn:test:composition:${suffix}:target`;
      const root = `urn:test:composition:${suffix}:root`;
      const failure = createFailure();
      const leaf = new (class extends OxigraphStore {
        override async structuredMutation(
          mutation: StructuredMutation,
          options?: QueryOptions,
        ): Promise<void> {
          await super.structuredMutation(mutation, options);
          throw failure;
        }
      })();
      const listGraphs = vi.spyOn(leaf, 'listGraphs');
      const graphSet = new GraphSetIndexStore(leaf);
      const changelog = new ChangelogStore(graphSet);

      try {
        await leaf.insert([{
          subject: root,
          predicate: PREDICATE,
          object: '"source"',
          graph: source,
        }]);
        await expect(changelog.listGraphs()).resolves.toEqual([source]);
        expect(listGraphs).toHaveBeenCalledOnce();

        const received = await changelog.structuredMutation({
          kind: 'copy-subject-projection',
          input: {
            sourceGraphUris: [source],
            targetGraphUri: target,
            roots: [root],
            descendantSuffix: '/',
            excludedPredicates: [],
          },
        }).then(() => undefined, (error: unknown) => error);
        expect(received).toBe(failure);

        expect(changelog.needsReconcile).toBe(true);
        expect(await leaf.hasGraph(target)).toBe(true);
        await expect(changelog.listGraphs())
          .resolves.toEqual(expect.arrayContaining([source, target]));
        expect(listGraphs).toHaveBeenCalledTimes(2);
      } finally {
        await changelog.close();
      }
    }
  });

  it('preserves worker-side serialized-budget refusals as mutation-free', async () => {
    const leaf = new OxigraphWorkerStore();
    const graphSet = new GraphSetIndexStore(leaf);
    const changelog = new ChangelogStore(graphSet);
    const listGraphs = vi.spyOn(leaf, 'listGraphs');
    const mutation: StructuredMutation = {
      kind: 'delete-subjects',
      input: {
        graphUri: GRAPH,
        subjects: Array.from(
          { length: 75_000 },
          (_, index) => `urn:test:${index.toString().padStart(5, '0')}:${'x'.repeat(40)}`,
        ),
      },
    };

    try {
      await leaf.insert([{
        subject: 'urn:test:composition:retained',
        predicate: PREDICATE,
        object: '"retained"',
        graph: GRAPH,
      }]);
      await expect(changelog.listGraphs()).resolves.toEqual([GRAPH]);
      expect(listGraphs).toHaveBeenCalledOnce();
      const generation = leaf.getWriteGen(GRAPH);
      expect(() => buildStructuredMutationUpdate(mutation))
        .toThrow(/serialized update exceeds/);

      await expect(changelog.structuredMutation(mutation))
        .rejects.toMatchObject({
          code: 'STRUCTURED_MUTATION_PRE_DISPATCH_REFUSAL',
          message: expect.stringMatching(/serialized update exceeds/),
        });

      expect(changelog.needsReconcile).toBe(false);
      expect(leaf.getWriteGen(GRAPH)).toBe(generation);
      expect(await leaf.countQuads(GRAPH)).toBe(1);
      await expect(changelog.listGraphs()).resolves.toEqual([GRAPH]);
      expect(listGraphs).toHaveBeenCalledOnce();
    } finally {
      await changelog.close();
    }
  });
});
