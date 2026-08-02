import type {
  CoreAutomaticRoundV1,
  EdgeSyncOperationV1,
  SyncCoverageJournalProcessIdentityV1,
  SyncCoverageJournalReferenceV1,
} from './manifest.ts';

const JOURNAL_CAPACITY = 256;
const MAX_CONTEXT_GRAPH_IDS = 32;
const MAX_CONTEXT_GRAPH_ID_LENGTH = 256;

export type {
  SyncCoverageJournalProcessIdentityV1,
  SyncCoverageJournalReferenceV1,
} from './manifest.ts';

/** Parse the closed outer reference before retaining untrusted journal JSON. */
export function parseSyncCoverageJournalReferenceV1(
  input: unknown,
): SyncCoverageJournalReferenceV1 | undefined {
  if (!isPlainRecord(input)
    || Reflect.ownKeys(input).length !== 2
    || !Object.hasOwn(input, 'snapshot')
    || !Object.hasOwn(input, 'sequence')
    || !nonNegativeInteger(input['sequence'])) return undefined;
  return { snapshot: input['snapshot'], sequence: input['sequence'] };
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
    || !positiveInteger(entry['rehydratedSelectionCount'])
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
  const completions = plainArray(entry['completions']);
  if (entry['jobId'] !== round.jobId
    || entry['planningLane'] !== round.planningLane
    || entry['source'] !== 'automatic-core-public'
    || entry['configuredBatchSize'] !== round.configuredBatchSize
    || !nonNegativeInteger(entry['effectiveBatchSize'])
    || entry['automaticContextGraphCount'] !== automaticIds.length
    || entry['explicitSelectedContextGraphCount'] !== explicitIds.length
    || !sameStrings(automaticIds, round.contextGraphIds)
    || !sameStrings(explicitIds, round.explicitSelectedContextGraphIds)
    || completions.length !== round.completions.length) {
    throw new Error('Core round differs from its immutable scheduler journal plan');
  }
  for (const expected of round.completions) {
    const completion = completions.find((candidate) =>
      isPlainRecord(candidate) && candidate['contextGraphId'] === expected.contextGraphId);
    if (!isPlainRecord(completion)
      || completion['jobId'] !== round.jobId
      || completion['state'] !== 'complete'
      || !verifiedPlanes(completion['verified'])
      || !nonNegativeInteger(completion['finishedAt'])) {
      throw new Error('Core round lacks a terminal verified completion for a planned graph');
    }
  }
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
  if (!isPlainRecord(snapshot)
    || snapshot['schemaVersion'] !== 1
    || snapshot['processStartedAt'] !== process.processStartedAt
    || snapshot['waveId'] !== process.evidenceWaveId
    || snapshot['capacity'] !== JOURNAL_CAPACITY
    || !nonNegativeInteger(snapshot['nextSequence'])
    || !nonNegativeInteger(snapshot['droppedBeforeSequence'])) {
    throw new Error('Sync coverage journal snapshot is malformed');
  }
  if ((snapshot['droppedBeforeSequence'] as number) > reference.sequence
    || (snapshot['nextSequence'] as number) <= reference.sequence) {
    throw new Error('Sync coverage journal no longer retains the referenced evidence');
  }
  const entries = plainArray(snapshot['entries']);
  if (entries.length > (snapshot['capacity'] as number)) {
    throw new Error('Sync coverage journal exceeds its declared capacity');
  }
  const candidate = entries.find((entry) =>
    isPlainRecord(entry) && entry['sequence'] === reference.sequence);
  if (!isPlainRecord(candidate)
    || candidate['kind'] !== kind
    || candidate['waveId'] !== snapshot['waveId']
    || candidate['evidenceTruncated'] !== false
    || candidate['state'] !== 'complete'
    || !nonNegativeInteger(candidate['startedAt'])
    || !nonNegativeInteger(candidate['finishedAt'])) {
    throw new Error(`${kind} terminal journal entry is missing, truncated, or incomplete`);
  }
  return candidate;
}

function verifiedPlanes(value: unknown): boolean {
  return isPlainRecord(value)
    && value['metadata'] === true
    && value['durable'] === true
    && value['sharedMemory'] === true;
}

function stringArray(value: unknown): string[] {
  const values = plainArray(value);
  if (values.length > MAX_CONTEXT_GRAPH_IDS
    || values.some((entry) => typeof entry !== 'string'
      || entry.length === 0
      || entry.length > MAX_CONTEXT_GRAPH_ID_LENGTH)
    || new Set(values).size !== values.length) {
    throw new Error('Sync coverage journal contains invalid context graph IDs');
  }
  return values as string[];
}

function plainArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error('Sync coverage journal field is not a plain array');
  }
  return value;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
