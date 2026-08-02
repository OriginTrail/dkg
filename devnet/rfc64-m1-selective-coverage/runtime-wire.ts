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
  decodeGraphObservations as parseGraphObservations,
  decodeGraphSnapshot,
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
  nonNegativeInteger,
  positiveInteger,
  requireDecoded,
} from './boundary-codec.ts';

export function decodeRuntimeReady(input: unknown): SelectiveCoverageRuntimeReadyV1 {
  const row = record(input, [
    'protocol', 'role', 'pid', 'peerId', 'networkId', 'testedHeadCommit',
    'runtimeManifestDigest', 'processStartedAt', 'processInstanceId',
    'dataDirectoryIdentity', 'evidenceWaveId',
  ]);
  const role = row.role;
  if (row.protocol !== SELECTIVE_COVERAGE_RUNTIME_PROTOCOL
    || (role !== 'publisher' && role !== 'edge' && role !== 'core')
    || !positiveInteger(row.pid)
    || !nonNegativeInteger(row.processStartedAt)) fail('runtime ready');
  return {
    protocol: SELECTIVE_COVERAGE_RUNTIME_PROTOCOL,
    role,
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
  const row = record(input, ['previous', 'current']);
  const previous = record(row.previous, ['pid', 'processInstanceId', 'exitedAt']);
  if (!positiveInteger(previous.pid) || !nonNegativeInteger(previous.exitedAt)) {
    fail('restart receipt');
  }
  return {
    previous: {
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

export function decodeEdgeSyncResult(input: unknown): {
  readonly operation: Omit<EdgeSyncOperationV1, 'sequence'>;
  readonly journal?: SyncCoverageJournalReferenceV1;
} {
  const row = optionalRecord(input, ['operation'], ['journal']);
  const journal = Object.hasOwn(row, 'journal')
    ? requiredJournal(row.journal)
    : undefined;
  return { operation: decodeEdgeOperation(row.operation), ...(journal ? { journal } : {}) };
}

export function decodeEdgeReconcilerResult(input: unknown): {
  readonly operation: Omit<EdgeSyncOperationV1, 'sequence'>;
  readonly journal: SyncCoverageJournalReferenceV1;
} {
  const row = record(input, ['operation', 'journal']);
  return {
    operation: decodeEdgeOperation(row.operation),
    journal: requiredJournal(row.journal),
  };
}

export function decodeCoreRoundResult(input: unknown): {
  readonly round: CoreAutomaticRoundV1;
  readonly journal: SyncCoverageJournalReferenceV1;
} {
  const row = record(input, ['round', 'journal']);
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
  const row = record(input, [
    'phase', 'source', 'syncMode', 'contextGraphId', 'jobId',
    'completedWave', 'completedSnapshot',
  ]);
  if ((row.phase !== 'selection' && row.phase !== 'post-restart-auto'
      && row.phase !== 'post-restart-explicit')
    || (row.source !== 'user' && row.source !== 'reconciler')
    || (row.syncMode !== 'always-on' && row.syncMode !== 'on-demand')
    || (row.completedWave !== 'selected' && row.completedWave !== 'final')) {
    fail('Edge operation');
  }
  return {
    phase: row.phase,
    source: row.source,
    syncMode: row.syncMode,
    contextGraphId: text(row.contextGraphId, 'contextGraphId'),
    jobId: text(row.jobId, 'jobId'),
    completedWave: row.completedWave,
    completedSnapshot: requireDecoded(
      decodeGraphSnapshot(row.completedSnapshot),
      'M1 runtime adapter graph snapshot',
    ),
  };
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
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
): Record<string, unknown> {
  return requireDecoded(
    closedRecord(input, requiredKeys, optionalKeys),
    'M1 runtime adapter record',
  );
}

function text(input: unknown, label: string): string {
  return requireDecoded(boundedString(input, 1, 4_096), `M1 runtime adapter ${label}`);
}

function fail(label: string): never {
  throw new TypeError(`M1 runtime adapter returned invalid ${label}`);
}
