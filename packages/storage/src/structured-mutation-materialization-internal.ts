import {
  assertTrustedStructuredMutationSnapshot,
  type ReadonlyStructuredMutation,
  type StructuredMutationSnapshot,
} from './bounded-structured-mutation.js';
import { buildCopySubjectProjectionUpdateFromNormalized } from './structured-mutation/copy-subject-projection.js';
import { buildDeleteSubjectsUpdateFromNormalized } from './structured-mutation/delete-subjects.js';
import { assertOperandBudget } from './structured-mutation/primitives.js';
import { buildReplaceProjectionFromGraphUpdateFromNormalized } from './structured-mutation/replace-projection-from-graph.js';
import { buildReplaceSubjectPredicatesUpdateFromNormalized } from './structured-mutation/replace-subject-predicates.js';
import {
  buildPruneLinkedRecordClosuresUpdateFromNormalized,
  buildPruneRankedSubjectsUpdateFromNormalized,
} from './structured-mutation/retention.js';

export type MaterializedStructuredMutation =
  | Readonly<{ outcome: 'noop'; snapshot: StructuredMutationSnapshot }>
  | Readonly<{
    outcome: 'execute';
    snapshot: StructuredMutationSnapshot;
    update: string;
  }>;

/** Validate deferred budgets and build one executable update from a trusted snapshot. */
export function materializeStructuredMutation(
  snapshot: StructuredMutationSnapshot,
): MaterializedStructuredMutation {
  assertTrustedStructuredMutationSnapshot(snapshot);
  const mutation = snapshot.mutation;
  assertMutationOperandBudget(mutation);
  const update = buildSnapshotUpdate(mutation);
  if (update === undefined) {
    if (snapshot.outcome !== 'noop') {
      throw new Error('structured mutation candidate unexpectedly materialized as a no-op');
    }
    return Object.freeze({ outcome: 'noop', snapshot });
  }
  if (snapshot.outcome !== 'candidate') {
    throw new Error('structured mutation no-op unexpectedly materialized an update');
  }
  return Object.freeze({ outcome: 'execute', snapshot, update });
}

function buildSnapshotUpdate(mutation: ReadonlyStructuredMutation): string | undefined {
  switch (mutation.kind) {
    case 'delete-subjects':
      return buildDeleteSubjectsUpdateFromNormalized(mutation.input);
    case 'prune-ranked-subjects':
      return buildPruneRankedSubjectsUpdateFromNormalized(mutation.input);
    case 'prune-linked-record-closures':
      return buildPruneLinkedRecordClosuresUpdateFromNormalized(mutation.input);
    case 'replace-subject-predicates':
      return buildReplaceSubjectPredicatesUpdateFromNormalized(mutation.input);
    case 'replace-projection-from-graph':
      return buildReplaceProjectionFromGraphUpdateFromNormalized(mutation.input);
    case 'copy-subject-projection':
      return buildCopySubjectProjectionUpdateFromNormalized(mutation.input);
  }
}

function assertMutationOperandBudget(mutation: ReadonlyStructuredMutation): void {
  switch (mutation.kind) {
    case 'delete-subjects':
      assertOperandBudget('deleteSubjects', deleteSubjectOperands(mutation.input));
      return;
    case 'prune-ranked-subjects':
      assertOperandBudget('pruneRankedSubjects', pruneRankedOperands(mutation.input));
      return;
    case 'prune-linked-record-closures':
      assertOperandBudget(
        'pruneLinkedRecordClosures',
        pruneLinkedRecordOperands(mutation.input),
      );
      return;
    case 'replace-subject-predicates':
      assertOperandBudget(
        'replaceSubjectPredicates',
        replaceSubjectPredicatesOperands(mutation.input),
      );
      return;
    case 'replace-projection-from-graph':
      assertOperandBudget(
        'replaceProjectionFromGraph',
        replaceProjectionOperands(mutation.input),
      );
      return;
    case 'copy-subject-projection':
      assertOperandBudget('copySubjectProjection', copyProjectionOperands(mutation.input));
  }
}

function* deleteSubjectOperands(
  input: Extract<ReadonlyStructuredMutation, { kind: 'delete-subjects' }>['input'],
): Iterable<string> {
  yield input.graphUri;
  yield* input.subjects;
}

function* pruneRankedOperands(
  input: Extract<ReadonlyStructuredMutation, { kind: 'prune-ranked-subjects' }>['input'],
): Iterable<string> {
  yield input.graphUri;
  yield input.subjectPrefix;
  yield input.eligibilityPredicate;
  yield input.primaryRankPredicate;
  yield input.secondaryRankPredicate;
  yield* input.eligibleObjects;
}

function* pruneLinkedRecordOperands(
  input: Extract<ReadonlyStructuredMutation, { kind: 'prune-linked-record-closures' }>['input'],
): Iterable<string> {
  yield input.graphUri;
  yield* input.matchObjectIris;
  yield* input.linkPredicates;
  yield input.recordParentPredicate;
  yield input.descendantSeparator;
  if (input.protectedRecordIri !== undefined) yield input.protectedRecordIri;
}

function* replaceSubjectPredicatesOperands(
  input: Extract<ReadonlyStructuredMutation, { kind: 'replace-subject-predicates' }>['input'],
): Iterable<string> {
  yield input.graphUri;
  yield input.subject;
  yield* input.predicates;
  for (const quad of input.replacementQuads) {
    yield quad.subject;
    yield quad.predicate;
    yield quad.object;
    yield quad.graph;
  }
}

function* replaceProjectionOperands(
  input: Extract<ReadonlyStructuredMutation, { kind: 'replace-projection-from-graph' }>['input'],
): Iterable<string> {
  yield input.targetGraphUri;
  yield input.stagingGraphUri;
  yield input.targetSubject;
  yield* input.preservedTargetPredicates;
  yield* input.targetSubjectPrefixes;
}

function* copyProjectionOperands(
  input: Extract<ReadonlyStructuredMutation, { kind: 'copy-subject-projection' }>['input'],
): Iterable<string> {
  yield* input.sourceGraphUris;
  yield input.targetGraphUri;
  yield* input.roots;
  yield input.descendantSuffix;
  yield* input.excludedPredicates;
}
