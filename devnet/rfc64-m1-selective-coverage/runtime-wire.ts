import {
  type CoreAutomaticRoundV1,
  type CoreFinalObservationV1,
  type EdgeGraphObservationV1,
  type EdgeSyncOperationV1,
  type GraphObservationV1,
} from './manifest.ts';
import {
  decodeCoreAutomaticRound,
  decodeCoreFinalObservations as parseCoreFinalObservations,
  decodeEdgeObservations as parseEdgeObservations,
  decodeEdgeSyncOperationPayload,
  decodeGraphObservations as parseGraphObservations,
} from './evidence-codec.ts';
import {
  SELECTIVE_COVERAGE_RUNTIME_PROTOCOL,
  type SelectiveCoverageEdgeRestartReceiptV1,
  type SelectiveCoverageRuntimeReadyV1,
} from './runtime.ts';
import {
  parseSyncCoverageJournalReferenceV1,
  type SyncCoverageJournalReferenceV1,
} from './sync-coverage-journal.ts';
import {
  boundedString,
  closedRecord,
  defineRecordKeys,
  nonNegativeInteger,
  positiveInteger,
  requireDecoded,
} from './boundary-codec.ts';

type EdgeRestartPreviousV1 = SelectiveCoverageEdgeRestartReceiptV1['previous'];
type EdgeSyncResultV1 = {
  readonly operation: Omit<EdgeSyncOperationV1, 'sequence'>;
  readonly journal?: SyncCoverageJournalReferenceV1;
};
type EdgeReconcilerResultV1 = {
  readonly operation: Omit<EdgeSyncOperationV1, 'sequence'>;
  readonly journal: SyncCoverageJournalReferenceV1;
};
type CoreRoundResultV1 = {
  readonly round: CoreAutomaticRoundV1;
  readonly journal: SyncCoverageJournalReferenceV1;
};
type OptionalPropertyKeys<T> = {
  [Key in keyof T]-?: object extends Pick<T, Key> ? Key : never;
}[keyof T];

const RUNTIME_READY_KEYS = defineRecordKeys<SelectiveCoverageRuntimeReadyV1>()(
  'protocol',
  'role',
  'hostIdentity',
  'pid',
  'peerId',
  'networkId',
  'testedHeadCommit',
  'runtimeManifestDigest',
  'processStartedAt',
  'processInstanceId',
  'dataDirectoryIdentity',
  'evidenceWaveId',
);
const EDGE_RESTART_RECEIPT_KEYS = defineRecordKeys<SelectiveCoverageEdgeRestartReceiptV1>()(
  'previous',
  'current',
);
const EDGE_RESTART_PREVIOUS_KEYS = defineRecordKeys<EdgeRestartPreviousV1>()(
  'hostIdentity',
  'pid',
  'processInstanceId',
  'exitedAt',
);
const EDGE_SYNC_RESULT_KEYS = defineRecordKeys<EdgeSyncResultV1>()('operation', 'journal');
const EDGE_SYNC_RESULT_OPTIONAL_KEYS = defineRecordKeys<
  Pick<EdgeSyncResultV1, OptionalPropertyKeys<EdgeSyncResultV1>>
>()('journal');
const EDGE_RECONCILER_RESULT_KEYS = defineRecordKeys<EdgeReconcilerResultV1>()(
  'operation',
  'journal',
);
const CORE_ROUND_RESULT_KEYS = defineRecordKeys<CoreRoundResultV1>()('round', 'journal');

export function decodeRuntimeReady(input: unknown): SelectiveCoverageRuntimeReadyV1 {
  const row = record(input, RUNTIME_READY_KEYS);
  const role = row.role;
  if (row.protocol !== SELECTIVE_COVERAGE_RUNTIME_PROTOCOL
    || (role !== 'publisher' && role !== 'edge' && role !== 'core')
    || !positiveInteger(row.pid)
    || !nonNegativeInteger(row.processStartedAt)) fail('runtime ready');
  return {
    protocol: SELECTIVE_COVERAGE_RUNTIME_PROTOCOL,
    role,
    hostIdentity: text(row.hostIdentity, 'hostIdentity'),
    pid: row.pid as number,
    peerId: text(row.peerId, 'peerId'),
    networkId: text(row.networkId, 'networkId'),
    testedHeadCommit: text(row.testedHeadCommit, 'testedHeadCommit'),
    runtimeManifestDigest: text(row.runtimeManifestDigest, 'runtimeManifestDigest'),
    processStartedAt: row.processStartedAt as number,
    processInstanceId: text(row.processInstanceId, 'processInstanceId'),
    dataDirectoryIdentity: text(row.dataDirectoryIdentity, 'dataDirectoryIdentity'),
    evidenceWaveId: text(row.evidenceWaveId, 'evidenceWaveId'),
  };
}

export function decodeRestartReceipt(input: unknown): SelectiveCoverageEdgeRestartReceiptV1 {
  const row = record(input, EDGE_RESTART_RECEIPT_KEYS);
  const previous = record(row.previous, EDGE_RESTART_PREVIOUS_KEYS);
  if (!positiveInteger(previous.pid) || !nonNegativeInteger(previous.exitedAt)) {
    fail('restart receipt');
  }
  return {
    previous: {
      hostIdentity: text(previous.hostIdentity, 'hostIdentity'),
      pid: previous.pid as number,
      processInstanceId: text(previous.processInstanceId, 'processInstanceId'),
      exitedAt: previous.exitedAt as number,
    },
    current: decodeRuntimeReady(row.current),
  };
}

export function decodeGraphObservations(input: unknown): readonly GraphObservationV1[] {
  return requireDecoded(parseGraphObservations(input), 'M1 runtime adapter graph observations');
}

export function decodeEdgeObservations(input: unknown): readonly EdgeGraphObservationV1[] {
  return requireDecoded(parseEdgeObservations(input), 'M1 runtime adapter Edge observations');
}

export function decodeCoreFinalObservations(input: unknown): readonly CoreFinalObservationV1[] {
  return requireDecoded(
    parseCoreFinalObservations(input),
    'M1 runtime adapter Core final observations',
  );
}

export function decodeEdgeSyncResult(input: unknown): EdgeSyncResultV1 {
  const row = optionalRecord(input, EDGE_SYNC_RESULT_KEYS, EDGE_SYNC_RESULT_OPTIONAL_KEYS);
  const journal = Object.hasOwn(row, 'journal')
    ? requiredJournal(row.journal)
    : undefined;
  return { operation: decodeEdgeOperation(row.operation), ...(journal ? { journal } : {}) };
}

export function decodeEdgeReconcilerResult(input: unknown): EdgeReconcilerResultV1 {
  const row = record(input, EDGE_RECONCILER_RESULT_KEYS);
  return {
    operation: decodeEdgeOperation(row.operation),
    journal: requiredJournal(row.journal),
  };
}

export function decodeCoreRoundResult(input: unknown): CoreRoundResultV1 {
  const row = record(input, CORE_ROUND_RESULT_KEYS);
  return {
    round: requireDecoded(decodeCoreAutomaticRound(row.round), 'M1 runtime adapter Core round'),
    journal: requiredJournal(row.journal),
  };
}

export function decodeNull(input: unknown): null {
  if (input !== null) fail('null acknowledgement');
  return null;
}

function decodeEdgeOperation(input: unknown): Omit<EdgeSyncOperationV1, 'sequence'> {
  return requireDecoded(
    decodeEdgeSyncOperationPayload(input),
    'M1 runtime adapter Edge operation',
  );
}

function requiredJournal(input: unknown): SyncCoverageJournalReferenceV1 {
  const parsed = parseSyncCoverageJournalReferenceV1(input);
  if (!parsed) fail('journal reference');
  return parsed;
}

function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  return requireDecoded(closedRecord(input, keys), 'M1 runtime adapter record');
}

function optionalRecord(
  input: unknown,
  keys: readonly string[],
  optionalKeys: readonly string[],
): Record<string, unknown> {
  const optional = new Set(optionalKeys);
  return requireDecoded(
    closedRecord(input, keys.filter((key) => !optional.has(key)), optionalKeys),
    'M1 runtime adapter record',
  );
}

function text(input: unknown, label: string): string {
  return requireDecoded(boundedString(input, 1, 4_096), `M1 runtime adapter ${label}`);
}

function fail(label: string): never {
  throw new TypeError(`M1 runtime adapter returned invalid ${label}`);
}
