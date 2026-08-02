import {
  MAX_SELECTIVE_COVERAGE_GRAPHS,
  MAX_SELECTIVE_COVERAGE_ROUNDS,
  MAX_SYNC_COVERAGE_IDS_PER_JOURNAL_ENTRY,
  SELECTIVE_COVERAGE_CORPUS_SCHEMA,
  SELECTIVE_COVERAGE_EVIDENCE_SCHEMA,
  type CoreAutomaticCompletionV1,
  type CoreAutomaticRoundV1,
  type CoreFinalObservationV1,
  type EdgeCoveragePolicy,
  type EdgeGraphObservationV1,
  type EdgeSyncOperationV1,
  type ExpectedSelectiveCoverageProvenanceV1,
  type GraphObservationV1,
  type GraphSnapshotExpectationV1,
  type PlaneExpectationV1,
  type PlaneObservationV1,
  type SelectiveCoverageCorpusV1,
  type SelectiveCoverageAutomaticJournalEvidenceV1,
  type SelectiveCoverageEvidenceV1,
  type SelectiveCoverageGraphV1,
  type SelectiveCoverageProvenanceV1,
  type SyncCoverageJournalProcessIdentityV1,
  type SyncCoverageJournalReferenceV1,
} from './manifest.ts';
import { parseSyncCoverageJournalReferenceV1 } from './sync-coverage-journal.ts';
import {
  closedArray,
  closedRecord,
  defineRecordKeys,
  identifier,
  nonNegativeInteger,
  positiveInteger,
} from './boundary-codec.ts';

const DIGEST = /^(?:0x|sha256:)[0-9a-f]{64}$/u;

type PublisherEvidenceV1 = SelectiveCoverageEvidenceV1['publisher'];
type EdgeEvidenceV1 = SelectiveCoverageEvidenceV1['edge'];
type CoreEvidenceV1 = SelectiveCoverageEvidenceV1['core'];

const SELECTIVE_COVERAGE_EVIDENCE_KEYS = defineRecordKeys<SelectiveCoverageEvidenceV1>()(
  'schema',
  'provenance',
  'automaticJournalEvidence',
  'corpus',
  'publisher',
  'edge',
  'core',
);
const SELECTIVE_COVERAGE_PROVENANCE_KEYS = defineRecordKeys<
  SelectiveCoverageProvenanceV1
>()(
  'networkId',
  'testedHeadCommit',
  'runtimeManifestDigest',
  'publisherPeerId',
  'edgePeerId',
  'corePeerId',
);
const EXPECTED_SELECTIVE_COVERAGE_PROVENANCE_KEYS = defineRecordKeys<
  ExpectedSelectiveCoverageProvenanceV1
>()(
  ...SELECTIVE_COVERAGE_PROVENANCE_KEYS,
  'corpusManifestDigest',
);
const AUTOMATIC_JOURNAL_EVIDENCE_KEYS = defineRecordKeys<
  SelectiveCoverageAutomaticJournalEvidenceV1
>()(
  'edgeProcess',
  'edgeReconciler',
  'coreProcess',
  'coreRounds',
);
const JOURNAL_PROCESS_IDENTITY_KEYS = defineRecordKeys<
  SyncCoverageJournalProcessIdentityV1
>()('processStartedAt', 'evidenceWaveId');
const SELECTIVE_COVERAGE_CORPUS_KEYS = defineRecordKeys<SelectiveCoverageCorpusV1>()(
  'schema',
  'networkId',
  'coreAutomaticBatchSize',
  'coreCoverageRoundLimit',
  'graphs',
  'manifestDigest',
);
const SELECTIVE_COVERAGE_GRAPH_KEYS = defineRecordKeys<SelectiveCoverageGraphV1>()(
  'contextGraphId',
  'accessPolicy',
  'publishPolicy',
  'edgePolicy',
  'selectedSnapshot',
  'finalSnapshot',
);
const PUBLISHER_EVIDENCE_KEYS = defineRecordKeys<PublisherEvidenceV1>()('selected', 'final');
const EDGE_EVIDENCE_KEYS = defineRecordKeys<EdgeEvidenceV1>()(
  'beforeSelection',
  'afterSelection',
  'afterRestart',
  'afterSecondOnDemand',
  'operations',
);
const CORE_EVIDENCE_KEYS = defineRecordKeys<CoreEvidenceV1>()(
  'automaticBatchSize',
  'rounds',
  'final',
);
const GRAPH_OBSERVATION_KEYS = defineRecordKeys<GraphObservationV1>()(
  'contextGraphId',
  'vm',
  'swm',
);
const EDGE_GRAPH_OBSERVATION_KEYS = defineRecordKeys<EdgeGraphObservationV1>()(
  'contextGraphId',
  'runtimeSyncMode',
  'producingJobId',
  'vm',
  'swm',
);
const CORE_FINAL_OBSERVATION_KEYS = defineRecordKeys<CoreFinalObservationV1>()(
  'contextGraphId',
  'automaticJobIds',
  'vm',
  'swm',
);
const GRAPH_SNAPSHOT_EXPECTATION_KEYS = defineRecordKeys<GraphSnapshotExpectationV1>()(
  'vm',
  'swm',
);
const EDGE_SYNC_OPERATION_PAYLOAD_KEYS = defineRecordKeys<
  Omit<EdgeSyncOperationV1, 'sequence'>
>()(
  'phase',
  'source',
  'syncMode',
  'contextGraphId',
  'jobId',
  'completedWave',
  'completedSnapshot',
);
const EDGE_SYNC_OPERATION_KEYS = defineRecordKeys<EdgeSyncOperationV1>()(
  'sequence',
  ...EDGE_SYNC_OPERATION_PAYLOAD_KEYS,
);
const CORE_AUTOMATIC_ROUND_KEYS = defineRecordKeys<CoreAutomaticRoundV1>()(
  'round',
  'jobId',
  'planningLane',
  'source',
  'configuredBatchSize',
  'explicitSelectedContextGraphIds',
  'contextGraphIds',
  'completions',
);
const CORE_AUTOMATIC_COMPLETION_KEYS = defineRecordKeys<CoreAutomaticCompletionV1>()(
  'contextGraphId',
  'completedWave',
  'completedSnapshot',
);
const PLANE_EXPECTATION_KEYS = defineRecordKeys<PlaneExpectationV1>()(
  'headDigest',
  'inventoryDigest',
  'assetCount',
  'dataTripleCount',
);
const PLANE_OBSERVATION_KEYS = defineRecordKeys<PlaneObservationV1>()(
  'reportedComplete',
  'headDigest',
  'inventoryDigest',
  'assetCount',
  'metadataTripleCount',
  'dataTripleCount',
);

/** Canonical closed-schema decoder shared by artifact and process boundaries. */
export function decodeSelectiveCoverageEvidence(
  input: unknown,
): SelectiveCoverageEvidenceV1 | undefined {
  const root = closedRecord(input, SELECTIVE_COVERAGE_EVIDENCE_KEYS);
  if (!root || root.schema !== SELECTIVE_COVERAGE_EVIDENCE_SCHEMA) return undefined;
  const provenance = parseProvenance(root.provenance);
  const automaticJournalEvidence = parseAutomaticJournalEvidence(root.automaticJournalEvidence);
  const corpus = decodeSelectiveCoverageCorpus(root.corpus);
  const publisher = closedRecord(root.publisher, PUBLISHER_EVIDENCE_KEYS);
  const edge = closedRecord(root.edge, EDGE_EVIDENCE_KEYS);
  const core = closedRecord(root.core, CORE_EVIDENCE_KEYS);
  if (!provenance || !automaticJournalEvidence || !corpus || !publisher || !edge || !core
    || !nonNegativeInteger(core.automaticBatchSize)
    || !closedArray(core.rounds, 1, MAX_SELECTIVE_COVERAGE_ROUNDS)) return undefined;
  const publisherSelected = decodeGraphObservations(publisher.selected);
  const publisherFinal = decodeGraphObservations(publisher.final);
  const beforeSelection = decodeEdgeObservations(edge.beforeSelection);
  const afterSelection = decodeEdgeObservations(edge.afterSelection);
  const afterRestart = decodeEdgeObservations(edge.afterRestart);
  const afterSecondOnDemand = decodeEdgeObservations(edge.afterSecondOnDemand);
  const operations = parseEdgeOperations(edge.operations);
  const final = decodeCoreFinalObservations(core.final);
  if (!publisherSelected || !publisherFinal || !beforeSelection || !afterSelection
    || !afterRestart || !afterSecondOnDemand || !operations || !final) return undefined;
  const rounds: CoreAutomaticRoundV1[] = [];
  for (let index = 0; index < core.rounds.length; index += 1) {
    const round = decodeCoreAutomaticRound(core.rounds[index]);
    if (!round || round.round !== index) return undefined;
    rounds.push(round);
  }
  return {
    schema: SELECTIVE_COVERAGE_EVIDENCE_SCHEMA,
    provenance,
    automaticJournalEvidence,
    corpus,
    publisher: { selected: publisherSelected, final: publisherFinal },
    edge: {
      beforeSelection,
      afterSelection,
      afterRestart,
      afterSecondOnDemand,
      operations,
    },
    core: {
      automaticBatchSize: core.automaticBatchSize as number,
      rounds: Object.freeze(rounds),
      final,
    },
  };
}

export function decodeExpectedSelectiveCoverageProvenance(
  input: unknown,
): ExpectedSelectiveCoverageProvenanceV1 | undefined {
  const root = closedRecord(input, EXPECTED_SELECTIVE_COVERAGE_PROVENANCE_KEYS);
  if (!root) return undefined;
  const { corpusManifestDigest: _omitted, ...provenanceInput } = root;
  const provenance = parseProvenance(provenanceInput);
  const corpusManifestDigest = digest(root.corpusManifestDigest);
  return provenance && corpusManifestDigest
    ? { ...provenance, corpusManifestDigest }
    : undefined;
}

export function decodeGraphObservations(
  input: unknown,
): readonly GraphObservationV1[] | undefined {
  if (!closedArray(input, 1, MAX_SELECTIVE_COVERAGE_GRAPHS)) return undefined;
  const result: GraphObservationV1[] = [];
  for (const inputRow of input) {
    const row = closedRecord(inputRow, GRAPH_OBSERVATION_KEYS);
    const contextGraphId = row && identifier(row.contextGraphId);
    const vm = row && parseObservation(row.vm);
    const swm = row && parseObservation(row.swm);
    if (!contextGraphId || !vm || !swm) return undefined;
    result.push({ contextGraphId, vm, swm });
  }
  return Object.freeze(result);
}

export function decodeEdgeObservations(
  input: unknown,
): readonly EdgeGraphObservationV1[] | undefined {
  if (!closedArray(input, 1, MAX_SELECTIVE_COVERAGE_GRAPHS)) return undefined;
  const result: EdgeGraphObservationV1[] = [];
  for (const inputRow of input) {
    const row = closedRecord(inputRow, EDGE_GRAPH_OBSERVATION_KEYS);
    if (!row) return undefined;
    const contextGraphId = identifier(row.contextGraphId);
    const vm = parseObservation(row.vm);
    const swm = parseObservation(row.swm);
    const runtimeSyncMode = row.runtimeSyncMode;
    const producingJobId = row.producingJobId === null ? null : identifier(row.producingJobId);
    if (!contextGraphId || !vm || !swm || producingJobId === undefined
      || (runtimeSyncMode !== null && runtimeSyncMode !== 'on-demand'
        && runtimeSyncMode !== 'always-on')) return undefined;
    result.push({ contextGraphId, runtimeSyncMode, producingJobId, vm, swm });
  }
  return Object.freeze(result);
}

export function decodeCoreFinalObservations(
  input: unknown,
): readonly CoreFinalObservationV1[] | undefined {
  if (!closedArray(input, 1, MAX_SELECTIVE_COVERAGE_GRAPHS)) return undefined;
  const result: CoreFinalObservationV1[] = [];
  for (const inputRow of input) {
    const row = closedRecord(inputRow, CORE_FINAL_OBSERVATION_KEYS);
    if (!row || !closedArray(row.automaticJobIds, 0, MAX_SELECTIVE_COVERAGE_ROUNDS)) {
      return undefined;
    }
    const contextGraphId = identifier(row.contextGraphId);
    const vm = parseObservation(row.vm);
    const swm = parseObservation(row.swm);
    const automaticJobIds = row.automaticJobIds.map(identifier);
    if (!contextGraphId || !vm || !swm || automaticJobIds.some((value) => !value)
      || new Set(automaticJobIds).size !== automaticJobIds.length) return undefined;
    result.push({
      contextGraphId,
      automaticJobIds: Object.freeze(automaticJobIds as string[]),
      vm,
      swm,
    });
  }
  return Object.freeze(result);
}

export function decodeGraphSnapshot(
  input: unknown,
): GraphSnapshotExpectationV1 | undefined {
  const root = closedRecord(input, GRAPH_SNAPSHOT_EXPECTATION_KEYS);
  if (!root) return undefined;
  const vm = parseExpectation(root.vm);
  const swm = parseExpectation(root.swm);
  return vm && swm ? { vm, swm } : undefined;
}

/** Shared closed decoder for the Edge operation artifact and runtime adapter. */
export function decodeEdgeSyncOperationPayload(
  input: unknown,
): Omit<EdgeSyncOperationV1, 'sequence'> | undefined {
  const row = closedRecord(input, EDGE_SYNC_OPERATION_PAYLOAD_KEYS);
  return row ? parseEdgeSyncOperationRecord(row) : undefined;
}

export function decodeCoreAutomaticRound(input: unknown): CoreAutomaticRoundV1 | undefined {
  const row = closedRecord(input, CORE_AUTOMATIC_ROUND_KEYS);
  if (!row || !nonNegativeInteger(row.round)
    || row.source !== 'automatic-core-public'
    || !positiveInteger(row.configuredBatchSize)
    || !closedArray(row.explicitSelectedContextGraphIds, 0, MAX_SELECTIVE_COVERAGE_GRAPHS)
    || !closedArray(row.contextGraphIds, 0, MAX_SELECTIVE_COVERAGE_GRAPHS)
    || !closedArray(row.completions, 0, MAX_SELECTIVE_COVERAGE_GRAPHS)) return undefined;
  const jobId = identifier(row.jobId);
  const planningLane = identifier(row.planningLane);
  const explicitSelectedContextGraphIds = row.explicitSelectedContextGraphIds.map(identifier);
  const contextGraphIds = row.contextGraphIds.map(identifier);
  if (!jobId || !planningLane
    || explicitSelectedContextGraphIds.some((value) => !value)
    || contextGraphIds.some((value) => !value)) return undefined;
  const completions = [];
  for (const inputCompletion of row.completions) {
    const completion = closedRecord(inputCompletion, CORE_AUTOMATIC_COMPLETION_KEYS);
    const contextGraphId = completion && identifier(completion.contextGraphId);
    const completedSnapshot = completion && decodeGraphSnapshot(completion.completedSnapshot);
    if (!completion || completion.completedWave !== 'final'
      || !contextGraphId || !completedSnapshot) return undefined;
    completions.push({ contextGraphId, completedWave: 'final' as const, completedSnapshot });
  }
  return {
    round: row.round,
    jobId,
    planningLane,
    source: 'automatic-core-public',
    configuredBatchSize: row.configuredBatchSize,
    explicitSelectedContextGraphIds: Object.freeze(explicitSelectedContextGraphIds as string[]),
    contextGraphIds: Object.freeze(contextGraphIds as string[]),
    completions: Object.freeze(completions),
  };
}

function parseAutomaticJournalEvidence(
  input: unknown,
): SelectiveCoverageEvidenceV1['automaticJournalEvidence'] | undefined {
  const root = closedRecord(input, AUTOMATIC_JOURNAL_EVIDENCE_KEYS);
  if (!root
    || !closedArray(root.edgeReconciler, 0, MAX_SELECTIVE_COVERAGE_GRAPHS)
    || !closedArray(root.coreRounds, 1, MAX_SELECTIVE_COVERAGE_ROUNDS)) return undefined;
  const edgeProcess = parseJournalProcessIdentity(root.edgeProcess);
  const coreProcess = parseJournalProcessIdentity(root.coreProcess);
  const edgeReconciler = root.edgeReconciler.map(parseSyncCoverageJournalReferenceV1);
  const coreRounds = root.coreRounds.map(parseSyncCoverageJournalReferenceV1);
  if (!edgeProcess || !coreProcess
    || edgeReconciler.some((entry) => entry === undefined)
    || coreRounds.some((entry) => entry === undefined)) return undefined;
  return {
    edgeProcess,
    edgeReconciler: Object.freeze(edgeReconciler as SyncCoverageJournalReferenceV1[]),
    coreProcess,
    coreRounds: Object.freeze(coreRounds as SyncCoverageJournalReferenceV1[]),
  };
}

function parseJournalProcessIdentity(
  input: unknown,
): SyncCoverageJournalProcessIdentityV1 | undefined {
  const root = closedRecord(input, JOURNAL_PROCESS_IDENTITY_KEYS);
  const evidenceWaveId = root && identifier(root.evidenceWaveId);
  if (!root || !nonNegativeInteger(root.processStartedAt) || !evidenceWaveId) return undefined;
  return { processStartedAt: root.processStartedAt, evidenceWaveId };
}

export function decodeSelectiveCoverageCorpus(
  input: unknown,
): SelectiveCoverageCorpusV1 | undefined {
  const root = closedRecord(input, SELECTIVE_COVERAGE_CORPUS_KEYS);
  if (!root || root.schema !== SELECTIVE_COVERAGE_CORPUS_SCHEMA) return undefined;
  const networkId = identifier(root.networkId);
  const manifestDigest = digest(root.manifestDigest);
  if (!networkId || !manifestDigest || !positiveInteger(root.coreAutomaticBatchSize)
    || root.coreAutomaticBatchSize > MAX_SYNC_COVERAGE_IDS_PER_JOURNAL_ENTRY
    || !positiveInteger(root.coreCoverageRoundLimit)
    || root.coreCoverageRoundLimit > MAX_SELECTIVE_COVERAGE_ROUNDS
    || !closedArray(root.graphs, 1, MAX_SELECTIVE_COVERAGE_GRAPHS)) return undefined;
  const graphs: SelectiveCoverageGraphV1[] = [];
  for (const inputGraph of root.graphs) {
    const graph = closedRecord(inputGraph, SELECTIVE_COVERAGE_GRAPH_KEYS);
    if (!graph) return undefined;
    const contextGraphId = identifier(graph.contextGraphId);
    const accessPolicy = binaryPolicy(graph.accessPolicy);
    const publishPolicy = binaryPolicy(graph.publishPolicy);
    const edgePolicy = parseEdgePolicy(graph.edgePolicy);
    const selectedSnapshot = decodeGraphSnapshot(graph.selectedSnapshot);
    const finalSnapshot = decodeGraphSnapshot(graph.finalSnapshot);
    if (!contextGraphId || accessPolicy === undefined || publishPolicy === undefined
      || !edgePolicy || !selectedSnapshot || !finalSnapshot
      || (accessPolicy === 1 && edgePolicy !== 'unselected')) return undefined;
    graphs.push({
      contextGraphId,
      accessPolicy,
      publishPolicy,
      edgePolicy,
      selectedSnapshot,
      finalSnapshot,
    });
  }
  return {
    schema: SELECTIVE_COVERAGE_CORPUS_SCHEMA,
    networkId,
    coreAutomaticBatchSize: root.coreAutomaticBatchSize,
    coreCoverageRoundLimit: root.coreCoverageRoundLimit,
    graphs: Object.freeze(graphs),
    manifestDigest,
  };
}

function parseProvenance(input: unknown): SelectiveCoverageEvidenceV1['provenance'] | undefined {
  const root = closedRecord(input, SELECTIVE_COVERAGE_PROVENANCE_KEYS);
  if (!root) return undefined;
  const networkId = identifier(root.networkId);
  const runtimeManifestDigest = digest(root.runtimeManifestDigest);
  const publisherPeerId = identifier(root.publisherPeerId);
  const edgePeerId = identifier(root.edgePeerId);
  const corePeerId = identifier(root.corePeerId);
  if (!networkId || typeof root.testedHeadCommit !== 'string'
    || !/^[0-9a-f]{40,64}$/u.test(root.testedHeadCommit)
    || !runtimeManifestDigest || !publisherPeerId || !edgePeerId || !corePeerId
    || new Set([publisherPeerId, edgePeerId, corePeerId]).size !== 3) return undefined;
  return {
    networkId,
    testedHeadCommit: root.testedHeadCommit,
    runtimeManifestDigest,
    publisherPeerId,
    edgePeerId,
    corePeerId,
  };
}

function parseEdgeOperations(input: unknown): readonly EdgeSyncOperationV1[] | undefined {
  if (!closedArray(input, 1, MAX_SELECTIVE_COVERAGE_GRAPHS * 2)) return undefined;
  const result: EdgeSyncOperationV1[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const row = closedRecord(input[index], EDGE_SYNC_OPERATION_KEYS);
    const operation = row && parseEdgeSyncOperationRecord(row);
    if (!row || row.sequence !== index || !operation) return undefined;
    result.push({
      sequence: index,
      ...operation,
    });
  }
  return Object.freeze(result);
}

function parseEdgeSyncOperationRecord(
  row: Record<string, unknown>,
): Omit<EdgeSyncOperationV1, 'sequence'> | undefined {
  const phase = row.phase;
  const source = row.source;
  const syncMode = row.syncMode;
  const contextGraphId = identifier(row.contextGraphId);
  const jobId = identifier(row.jobId);
  const completedWave = row.completedWave;
  const completedSnapshot = decodeGraphSnapshot(row.completedSnapshot);
  if ((phase !== 'selection' && phase !== 'post-restart-auto'
    && phase !== 'post-restart-explicit')
    || (source !== 'reconciler' && source !== 'user')
    || (syncMode !== 'always-on' && syncMode !== 'on-demand')
    || (completedWave !== 'selected' && completedWave !== 'final')
    || !completedSnapshot || !contextGraphId || !jobId) return undefined;
  return {
    phase,
    source,
    syncMode,
    contextGraphId,
    jobId,
    completedWave,
    completedSnapshot,
  };
}

function parseExpectation(input: unknown): PlaneExpectationV1 | undefined {
  const root = closedRecord(input, PLANE_EXPECTATION_KEYS);
  if (!root) return undefined;
  const headDigest = digest(root.headDigest);
  const inventoryDigest = digest(root.inventoryDigest);
  if (!headDigest || !inventoryDigest || !positiveInteger(root.assetCount)
    || !positiveInteger(root.dataTripleCount)) return undefined;
  return {
    headDigest,
    inventoryDigest,
    assetCount: root.assetCount,
    dataTripleCount: root.dataTripleCount,
  };
}

function parseObservation(input: unknown): PlaneObservationV1 | undefined {
  const root = closedRecord(input, PLANE_OBSERVATION_KEYS);
  if (!root || typeof root.reportedComplete !== 'boolean'
    || !nonNegativeInteger(root.assetCount)
    || !nonNegativeInteger(root.metadataTripleCount)
    || !nonNegativeInteger(root.dataTripleCount)) return undefined;
  const headDigest = root.headDigest === null ? null : digest(root.headDigest);
  const inventoryDigest = root.inventoryDigest === null ? null : digest(root.inventoryDigest);
  if (headDigest === undefined || inventoryDigest === undefined) return undefined;
  return {
    reportedComplete: root.reportedComplete,
    headDigest,
    inventoryDigest,
    assetCount: root.assetCount,
    metadataTripleCount: root.metadataTripleCount,
    dataTripleCount: root.dataTripleCount,
  };
}

function digest(value: unknown): string | undefined {
  return typeof value === 'string' && DIGEST.test(value) ? value : undefined;
}

function binaryPolicy(value: unknown): 0 | 1 | undefined {
  return value === 0 || value === 1 ? value : undefined;
}

function parseEdgePolicy(value: unknown): EdgeCoveragePolicy | undefined {
  return value === 'on-demand' || value === 'always-on' || value === 'unselected'
    ? value
    : undefined;
}
