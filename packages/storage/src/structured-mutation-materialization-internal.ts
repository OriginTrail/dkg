import {
  assertTrustedStructuredMutationSnapshot,
  type ReadonlyStructuredMutation,
  type StructuredMutationSnapshot,
} from './bounded-structured-mutation.js';
import { materializeCopySubjectProjectionInput } from './structured-mutation/copy-subject-projection.js';
import { materializeDeleteSubjectsInput } from './structured-mutation/delete-subjects.js';
import { materializeReplaceProjectionFromGraphInput } from './structured-mutation/replace-projection-from-graph.js';
import { materializeReplaceSubjectPredicatesInput } from './structured-mutation/replace-subject-predicates.js';
import {
  materializePruneLinkedRecordClosuresInput,
  materializePruneRankedSubjectsInput,
} from './structured-mutation/retention.js';

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
  const mutation = snapshot.mutation;
  const update = materializeSnapshotUpdate(mutation);
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

/** Validate a worker-bound snapshot before structured clone without building backend text. */
export function assertStructuredMutationSnapshotMaterializable(
  snapshot: StructuredMutationSnapshot,
): void {
  assertTrustedStructuredMutationSnapshot(snapshot);
  materializeSnapshotUpdate(snapshot.mutation, false);
}

function materializeSnapshotUpdate(
  mutation: ReadonlyStructuredMutation,
  buildUpdate = true,
): string | undefined {
  switch (mutation.kind) {
    case 'delete-subjects':
      return materializeDeleteSubjectsInput(mutation.input, buildUpdate);
    case 'prune-ranked-subjects':
      return materializePruneRankedSubjectsInput(mutation.input, buildUpdate);
    case 'prune-linked-record-closures':
      return materializePruneLinkedRecordClosuresInput(mutation.input, buildUpdate);
    case 'replace-subject-predicates':
      return materializeReplaceSubjectPredicatesInput(mutation.input, buildUpdate);
    case 'replace-projection-from-graph':
      return materializeReplaceProjectionFromGraphInput(mutation.input, buildUpdate);
    case 'copy-subject-projection':
      return materializeCopySubjectProjectionInput(mutation.input, buildUpdate);
  }
}
