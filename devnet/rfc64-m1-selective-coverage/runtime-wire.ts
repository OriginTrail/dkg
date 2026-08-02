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
  return requiredCodec(parseGraphObservations(input), 'graph observations');
}

export function decodeEdgeObservations(input: unknown): readonly EdgeGraphObservationV1[] {
  return requiredCodec(parseEdgeObservations(input), 'Edge observations');
}

export function decodeCoreFinalObservations(input: unknown): readonly CoreFinalObservationV1[] {
  return requiredCodec(parseCoreFinalObservations(input), 'Core final observations');
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
    round: requiredCodec(decodeCoreAutomaticRound(row.round), 'Core round'),
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
    completedSnapshot: requiredCodec(
      decodeGraphSnapshot(row.completedSnapshot),
      'graph snapshot',
    ),
  };
}

function requiredJournal(input: unknown): SyncCoverageJournalReferenceV1 {
  const parsed = parseSyncCoverageJournalReferenceV1(input);
  if (!parsed) fail('journal reference');
  return parsed;
}

function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  return optionalRecord(input, keys, []);
}

function optionalRecord(
  input: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
): Record<string, unknown> {
  if (!isPlainRecord(input)) fail('record');
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (Reflect.ownKeys(input).some((key) => typeof key !== 'string' || !allowed.has(key))
    || requiredKeys.some((key) => !Object.hasOwn(input, key))) fail('record');
  return input;
}

function text(input: unknown, label: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > 4_096) fail(label);
  return input;
}

function requiredCodec<T>(input: T | undefined, label: string): T {
  if (input === undefined) fail(label);
  return input;
}

function positiveInteger(input: unknown): boolean {
  return Number.isSafeInteger(input) && (input as number) > 0;
}

function nonNegativeInteger(input: unknown): boolean {
  return Number.isSafeInteger(input) && (input as number) >= 0;
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return input !== null
    && typeof input === 'object'
    && !Array.isArray(input)
    && Object.getPrototypeOf(input) === Object.prototype;
}

function fail(label: string): never {
  throw new TypeError(`M1 runtime adapter returned invalid ${label}`);
}
