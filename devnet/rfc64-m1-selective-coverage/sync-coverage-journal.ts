import type {
  CoreAutomaticRoundV1,
  EdgeSyncOperationV1,
  SyncCoverageJournalProcessIdentityV1,
  SyncCoverageJournalReferenceV1,
} from './manifest.ts';
import { MAX_SYNC_COVERAGE_IDS_PER_JOURNAL_ENTRY } from './manifest.ts';
import {
  boundedString,
  closedArray,
  closedRecord,
  defineRecordKeys,
  nonNegativeInteger,
  plainRecord,
  positiveInteger,
} from './boundary-codec.ts';

const JOURNAL_CAPACITY = 256;
const MAX_CONTEXT_GRAPH_ID_LENGTH = 256;
const SYNC_COVERAGE_JOURNAL_REFERENCE_KEYS = defineRecordKeys<
  SyncCoverageJournalReferenceV1
>()('snapshot', 'sequence');

export type {
  SyncCoverageJournalProcessIdentityV1,
  SyncCoverageJournalReferenceV1,
} from './manifest.ts';

/** Parse the closed outer reference before retaining untrusted journal JSON. */
export function parseSyncCoverageJournalReferenceV1(
  input: unknown,
): SyncCoverageJournalReferenceV1 | undefined {
  const row = closedRecord(input, SYNC_COVERAGE_JOURNAL_REFERENCE_KEYS);
  if (!row || !nonNegativeInteger(row['sequence'])) return undefined;
  return { snapshot: row['snapshot'], sequence: row['sequence'] };
}

/**
 * Bind an automatic Edge completion to the immutable operator journal. The
 * exact VM/SWM snapshot remains independently queried by the harness.
 */
export function assertEdgeReconcilerJournalV1(
  reference: SyncCoverageJournalReferenceV1 | undefined,
  operation: Omit<EdgeSyncOperationV1, 'sequence'>,
  process: SyncCoverageJournalProcessIdentityV1,
): void {
  const entry = terminalEntry(reference, 'edge-reconciler-job', process);
  if (entry['jobId'] !== operation.jobId
    || entry['contextGraphId'] !== operation.contextGraphId
    || entry['source'] !== 'reconciler'
    || entry['trigger'] !== 'periodic-reconciler'
    || entry['syncMode'] !== 'always-on'
    || !positiveInteger(entry['durableSelectionCount'])
    || !verifiedPlanes(entry['verified'])) {
    throw new Error('Edge automatic completion lacks exact reconciler journal provenance');
  }
}

/** Bind one claimed Core round to its frozen scheduler plan and completions. */
export function assertCoreAutomaticRoundJournalV1(
  reference: SyncCoverageJournalReferenceV1 | undefined,
  round: CoreAutomaticRoundV1,
  process: SyncCoverageJournalProcessIdentityV1,
): void {
  const entry = terminalEntry(reference, 'core-automatic-round', process);
  const automaticIds = stringArray(entry['automaticContextGraphIds']);
  const explicitIds = stringArray(entry['explicitSelectedContextGraphIds']);
  const completions = requiredArray(
    entry['completions'],
    MAX_SYNC_COVERAGE_IDS_PER_JOURNAL_ENTRY,
    'Core completions',
  );
  const effectiveBatchSize = entry['effectiveBatchSize'];
  if (entry['jobId'] !== round.jobId
    || entry['planningLane'] !== round.planningLane
    || entry['source'] !== 'automatic-core-public'
    || !isCoreAutomaticTriggerV1(entry['trigger'])
    || entry['configuredBatchSize'] !== round.configuredBatchSize
    || !nonNegativeInteger(effectiveBatchSize)
    || effectiveBatchSize > round.configuredBatchSize
    || automaticIds.length > effectiveBatchSize
    || entry['automaticContextGraphCount'] !== automaticIds.length
    || entry['explicitSelectedContextGraphCount'] !== explicitIds.length
    || !sameStrings(automaticIds, round.contextGraphIds)
    || !sameStrings(explicitIds, round.explicitSelectedContextGraphIds)
    || round.completions.length !== round.contextGraphIds.length
    || completions.length !== automaticIds.length) {
    throw new Error('Core round differs from its immutable scheduler journal plan');
  }
  for (let index = 0; index < round.completions.length; index += 1) {
    const expected = round.completions[index]!;
    const completion = completions[index];
    const completionRow = plainRecord(completion);
    if (!completionRow
      || expected.contextGraphId !== round.contextGraphIds[index]
      || completionRow['contextGraphId'] !== automaticIds[index]
      || completionRow['jobId'] !== round.jobId
      || completionRow['state'] !== 'complete'
      || !verifiedPlanes(completionRow['verified'])
      || !nonNegativeInteger(completionRow['finishedAt'])) {
      throw new Error('Core round lacks a terminal verified completion for a planned graph');
    }
  }
}

function isCoreAutomaticTriggerV1(value: unknown): boolean {
  return value === 'connection-open'
    || value === 'peer-update'
    || value === 'periodic-reconciler';
}

function terminalEntry(
  reference: SyncCoverageJournalReferenceV1 | undefined,
  kind: 'edge-reconciler-job' | 'core-automatic-round',
  process: SyncCoverageJournalProcessIdentityV1,
): Record<string, unknown> {
  if (!reference || !nonNegativeInteger(reference.sequence)) {
    throw new Error(`${kind} requires an operator-journal terminal entry`);
  }
  const snapshot = reference.snapshot;
  const snapshotRow = plainRecord(snapshot);
  if (!snapshotRow
    || snapshotRow['schemaVersion'] !== 1
    || snapshotRow['processStartedAt'] !== process.processStartedAt
    || snapshotRow['waveId'] !== process.evidenceWaveId
    || snapshotRow['capacity'] !== JOURNAL_CAPACITY
    || !nonNegativeInteger(snapshotRow['nextSequence'])
    || !nonNegativeInteger(snapshotRow['droppedBeforeSequence'])) {
    throw new Error('Sync coverage journal snapshot is malformed');
  }
  if ((snapshotRow['droppedBeforeSequence'] as number) > reference.sequence
    || (snapshotRow['nextSequence'] as number) <= reference.sequence) {
    throw new Error('Sync coverage journal no longer retains the referenced evidence');
  }
  const entries = requiredArray(snapshotRow['entries'], JOURNAL_CAPACITY, 'journal entries');
  if (entries.length > (snapshotRow['capacity'] as number)) {
    throw new Error('Sync coverage journal exceeds its declared capacity');
  }
  const candidate = entries.find((entry) => {
    const row = plainRecord(entry);
    return row !== undefined && row['sequence'] === reference.sequence;
  });
  const candidateRow = plainRecord(candidate);
  if (!candidateRow
    || candidateRow['kind'] !== kind
    || candidateRow['waveId'] !== snapshotRow['waveId']
    || candidateRow['evidenceTruncated'] !== false
    || candidateRow['state'] !== 'complete'
    || !nonNegativeInteger(candidateRow['startedAt'])
    || !nonNegativeInteger(candidateRow['finishedAt'])) {
    throw new Error(`${kind} terminal journal entry is missing, truncated, or incomplete`);
  }
  return candidateRow;
}

function verifiedPlanes(value: unknown): boolean {
  const row = plainRecord(value);
  return row !== undefined
    && row['metadata'] === true
    && row['durable'] === true
    && row['sharedMemory'] === true;
}

function stringArray(value: unknown): string[] {
  const values = requiredArray(
    value,
    MAX_SYNC_COVERAGE_IDS_PER_JOURNAL_ENTRY,
    'context graph IDs',
  );
  if (values.length > MAX_SYNC_COVERAGE_IDS_PER_JOURNAL_ENTRY
    || values.some((entry) => boundedString(entry, 1, MAX_CONTEXT_GRAPH_ID_LENGTH) === undefined)
    || new Set(values).size !== values.length) {
    throw new Error('Sync coverage journal contains invalid context graph IDs');
  }
  return values as string[];
}

function requiredArray(value: unknown, maximum: number, label: string): unknown[] {
  if (!closedArray(value, 0, maximum)) {
    throw new Error(`Sync coverage journal ${label} is not a bounded plain array`);
  }
  return value;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
