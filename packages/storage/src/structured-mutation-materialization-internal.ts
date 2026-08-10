import {
  assertTrustedStructuredMutationSnapshot,
  type ReadonlyStructuredMutation,
  type StructuredMutationSnapshot,
} from './bounded-structured-mutation.js';
import {
  assertCopySubjectProjectionInputMaterializable,
  buildCopySubjectProjectionUpdateFromNormalized,
} from './structured-mutation/copy-subject-projection.js';
import {
  assertDeleteSubjectsInputMaterializable,
  buildDeleteSubjectsUpdateFromNormalized,
} from './structured-mutation/delete-subjects.js';
import {
  assertReplaceProjectionFromGraphInputMaterializable,
  buildReplaceProjectionFromGraphUpdateFromNormalized,
} from './structured-mutation/replace-projection-from-graph.js';
import {
  assertReplaceSubjectPredicatesInputMaterializable,
  buildReplaceSubjectPredicatesUpdateFromNormalized,
} from './structured-mutation/replace-subject-predicates.js';
import {
  assertPruneLinkedRecordClosuresInputMaterializable,
  assertPruneRankedSubjectsInputMaterializable,
  buildPruneLinkedRecordClosuresUpdateFromNormalized,
  buildPruneRankedSubjectsUpdateFromNormalized,
} from './structured-mutation/retention.js';
import { markStructuredMutationPreDispatchRefusal } from './structured-mutation/refusal-internal.js';

export type MaterializedStructuredMutation =
  | Readonly<{
    outcome: 'noop';
    snapshot: Extract<StructuredMutationSnapshot, { outcome: 'noop' }>;
  }>
  | Readonly<{
    outcome: 'execute';
    snapshot: Extract<StructuredMutationSnapshot, { outcome: 'candidate' }>;
    update: string;
  }>;

/** Validate deferred budgets and build one executable update from a trusted snapshot. */
export function materializeStructuredMutation(
  snapshot: StructuredMutationSnapshot,
): MaterializedStructuredMutation {
  assertTrustedStructuredMutationSnapshot(snapshot);
  try {
    const mutation = snapshot.mutation;
    assertSnapshotMaterializable(mutation);
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
  } catch (error) {
    markStructuredMutationPreDispatchRefusal(error);
    throw error;
  }
}

/** Validate a worker-bound snapshot before structured clone without building backend text. */
export function assertStructuredMutationSnapshotMaterializable(
  snapshot: StructuredMutationSnapshot,
): void {
  assertTrustedStructuredMutationSnapshot(snapshot);
  try {
    assertSnapshotMaterializable(snapshot.mutation);
  } catch (error) {
    markStructuredMutationPreDispatchRefusal(error);
    throw error;
  }
}

function assertSnapshotMaterializable(mutation: ReadonlyStructuredMutation): void {
  switch (mutation.kind) {
    case 'delete-subjects':
      assertDeleteSubjectsInputMaterializable(mutation.input);
      return;
    case 'prune-ranked-subjects':
      assertPruneRankedSubjectsInputMaterializable(mutation.input);
      return;
    case 'prune-linked-record-closures':
      assertPruneLinkedRecordClosuresInputMaterializable(mutation.input);
      return;
    case 'replace-subject-predicates':
      assertReplaceSubjectPredicatesInputMaterializable(mutation.input);
      return;
    case 'replace-projection-from-graph':
      assertReplaceProjectionFromGraphInputMaterializable(mutation.input);
      return;
    case 'copy-subject-projection':
      assertCopySubjectProjectionInputMaterializable(mutation.input);
  }
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
