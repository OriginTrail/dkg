import {
  MAX_SELECTIVE_COVERAGE_GRAPHS,
  MAX_SELECTIVE_COVERAGE_ROUNDS,
  SELECTIVE_COVERAGE_CORPUS_SCHEMA,
  SELECTIVE_COVERAGE_EVIDENCE_SCHEMA,
  SELECTIVE_COVERAGE_VERDICT_SCHEMA,
  computeSelectiveCoverageCorpusDigest,
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
  type SelectiveCoverageChecksV1,
  type SelectiveCoverageCorpusV1,
  type SelectiveCoverageEvidenceV1,
  type SelectiveCoverageGraphV1,
  type SelectiveCoverageVerdictV1,
} from './manifest.ts';

const DIGEST = /^(?:0x|sha256:)[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9._:/@-]+$/u;

const CHECK_NAMES: readonly (keyof SelectiveCoverageChecksV1)[] = Object.freeze([
  'schemaWellFormed',
  'provenanceMatches',
  'corpusDigestMatches',
  'corpusCanonicalOrder',
  'requiredPolicyCellsPresent',
  'publisherSnapshotsExact',
  'publicSecondWaveAdvances',
  'edgePassiveBeforeSelection',
  'edgeSelectedSnapshotsExact',
  'edgeOnDemandRemainsPointInTime',
  'edgeAlwaysOnRefreshesAfterRestart',
  'edgeOperationProvenance',
  'edgeSecondOnDemandConverges',
  'edgeUnselectedExcluded',
  'edgePrivateExcluded',
  'coreBatchMatchesManifest',
  'coreBatchWithinBound',
  'coreRoundsPublicOnly',
  'coreAutomaticProvenance',
  'coreEveryPublicScheduled',
  'coreCoverageWithinWindow',
  'coreFinalPublicExact',
  'corePrivateExcluded',
  'noMetadataOnlyCompletion',
]);

const REASONS: Readonly<Record<keyof SelectiveCoverageChecksV1, string>> = Object.freeze({
  schemaWellFormed: 'evidence failed closed structural validation',
  provenanceMatches: 'repository, runtime, network, or process-role provenance differs from the external trust anchor',
  corpusDigestMatches: 'corpus manifest digest does not match its closed payload',
  corpusCanonicalOrder: 'corpus or observation rows are not canonical and unique',
  requiredPolicyCellsPresent: 'corpus must include public on-demand, public always-on, public unselected, private open, and private curated cells',
  publisherSnapshotsExact: 'Publisher-owned VM or SWM source snapshots differ from the anchored corpus',
  publicSecondWaveAdvances: 'one or more public graphs did not produce a distinct, larger second publication wave',
  edgePassiveBeforeSelection: 'Edge acquired VM or SWM payload before any user selection',
  edgeSelectedSnapshotsExact: 'Edge selection did not produce exact VM and SWM snapshot evidence',
  edgeOnDemandRemainsPointInTime: 'on-demand Edge state changed without another explicit request',
  edgeAlwaysOnRefreshesAfterRestart: 'always-on Edge state did not reach the final post-restart snapshot',
  edgeOperationProvenance: 'Edge operations do not prove explicit selection, automatic always-on restart work, and no hidden on-demand refresh',
  edgeSecondOnDemandConverges: 'a second explicit on-demand request did not reach the final exact snapshot',
  edgeUnselectedExcluded: 'Edge acquired an unselected public context graph',
  edgePrivateExcluded: 'Edge acquired an unselected private context graph',
  coreBatchMatchesManifest: 'Core evidence used a different automatic batch bound',
  coreBatchWithinBound: 'a Core automatic round exceeded its configured batch bound',
  coreRoundsPublicOnly: 'a Core automatic round admitted a private, duplicate, or unknown context graph',
  coreAutomaticProvenance: 'Core rounds or final observations are not bound to scheduler-issued automatic jobs with no explicit selections',
  coreEveryPublicScheduled: 'one or more public context graphs never entered a Core automatic round',
  coreCoverageWithinWindow: 'Core did not first admit every public graph within the anchored coverage-round limit',
  coreFinalPublicExact: 'Core did not converge every public VM and SWM plane exactly',
  corePrivateExcluded: 'Core automatic coverage acquired private VM or SWM payload',
  noMetadataOnlyCompletion: 'a required plane reported completion without exact nonzero payload',
});

/** Verify untrusted harness JSON without trusting summary or synced flags. */
export function verifySelectiveCoverage(
  input: unknown,
  expected: ExpectedSelectiveCoverageProvenanceV1,
): SelectiveCoverageVerdictV1 {
  try {
    if (!parseExpectedProvenance(expected)) return schemaReject();
    const evidence = parseEvidence(input);
    if (!evidence) return schemaReject();
    return verifyParsed(evidence, expected);
  } catch {
    return schemaReject();
  }
}

function verifyParsed(
  evidence: SelectiveCoverageEvidenceV1,
  expected: ExpectedSelectiveCoverageProvenanceV1,
): SelectiveCoverageVerdictV1 {
  const { corpus } = evidence;
  const graphIds = corpus.graphs.map((graph) => graph.contextGraphId);
  const publicGraphs = corpus.graphs.filter((graph) => graph.accessPolicy === 0);
  const privateGraphs = corpus.graphs.filter((graph) => graph.accessPolicy === 1);
  const byId = new Map(corpus.graphs.map((graph) => [graph.contextGraphId, graph]));
  const publisherSelected = byObservationId(evidence.publisher.selected);
  const publisherFinal = byObservationId(evidence.publisher.final);
  const edgeBefore = byObservationId(evidence.edge.beforeSelection);
  const edgeSelected = byObservationId(evidence.edge.afterSelection);
  const edgeRestarted = byObservationId(evidence.edge.afterRestart);
  const edgeSecondOnDemand = byObservationId(evidence.edge.afterSecondOnDemand);
  const coreFinal = byObservationId(evidence.core.final);

  const observationsCanonical = [
    evidence.publisher.selected,
    evidence.publisher.final,
    evidence.edge.beforeSelection,
    evidence.edge.afterSelection,
    evidence.edge.afterRestart,
    evidence.edge.afterSecondOnDemand,
    evidence.core.final,
  ].every((rows) => exactCanonicalIds(rows.map((row) => row.contextGraphId), graphIds));
  const corpusCanonicalOrder = strictlyIncreasing(graphIds) && observationsCanonical;
  const provenanceMatches = evidence.provenance.networkId === expected.networkId
    && evidence.provenance.testedHeadCommit === expected.testedHeadCommit
    && evidence.provenance.runtimeManifestDigest === expected.runtimeManifestDigest
    && evidence.provenance.publisherPeerId === expected.publisherPeerId
    && evidence.provenance.edgePeerId === expected.edgePeerId
    && evidence.provenance.corePeerId === expected.corePeerId
    && corpus.networkId === expected.networkId
    && corpus.manifestDigest === expected.corpusManifestDigest;
  const corpusDigestMatches = computeSelectiveCoverageCorpusDigest(corpus)
    === corpus.manifestDigest;
  const requiredPolicyCellsPresent = hasRequiredPolicyCells(corpus.graphs);
  const publisherSnapshotsExact = corpus.graphs.every((graph) =>
    exactGraph(publisherSelected.get(graph.contextGraphId), graph.selectedSnapshot)
      && exactGraph(publisherFinal.get(graph.contextGraphId), graph.finalSnapshot));
  const publicSecondWaveAdvances = publicGraphs.every((graph) =>
    snapshotsAdvance(graph.selectedSnapshot, graph.finalSnapshot));

  const edgePassiveBeforeSelection = corpus.graphs.every((graph) =>
    absentGraph(edgeBefore.get(graph.contextGraphId))
      && edgeBefore.get(graph.contextGraphId)?.runtimeSyncMode === null
      && edgeBefore.get(graph.contextGraphId)?.producingJobId === null);
  const edgeSelectedSnapshotsExact = corpus.graphs.every((graph) => {
    const observed = edgeSelected.get(graph.contextGraphId);
    return graph.accessPolicy === 0 && graph.edgePolicy !== 'unselected'
      ? exactGraph(observed, graph.selectedSnapshot)
        && observed?.runtimeSyncMode === graph.edgePolicy
        && observed.producingJobId === edgeJobId(evidence.edge.operations, graph.contextGraphId, 'selection')
      : absentGraph(observed) && observed?.runtimeSyncMode === null
        && observed.producingJobId === null;
  });
  const edgeOnDemandRemainsPointInTime = corpus.graphs
    .filter((graph) => graph.edgePolicy === 'on-demand')
    .every((graph) => exactGraph(edgeRestarted.get(graph.contextGraphId), graph.selectedSnapshot)
      && edgeRestarted.get(graph.contextGraphId)?.runtimeSyncMode === null
      && edgeRestarted.get(graph.contextGraphId)?.producingJobId
        === edgeJobId(evidence.edge.operations, graph.contextGraphId, 'selection'));
  const edgeAlwaysOnRefreshesAfterRestart = corpus.graphs
    .filter((graph) => graph.edgePolicy === 'always-on')
    .every((graph) => (
      snapshotsAdvance(graph.selectedSnapshot, graph.finalSnapshot)
      && exactGraph(edgeRestarted.get(graph.contextGraphId), graph.finalSnapshot)
      && edgeRestarted.get(graph.contextGraphId)?.runtimeSyncMode === 'always-on'
      && edgeRestarted.get(graph.contextGraphId)?.producingJobId
        === edgeJobId(evidence.edge.operations, graph.contextGraphId, 'post-restart-auto')
    ));
  const edgeOperationProvenance = verifyEdgeOperations(evidence.edge.operations, corpus.graphs);
  const edgeSecondOnDemandConverges = corpus.graphs.every((graph) => {
    const observed = edgeSecondOnDemand.get(graph.contextGraphId);
    if (graph.accessPolicy !== 0 || graph.edgePolicy === 'unselected') {
      return absentGraph(observed) && observed?.runtimeSyncMode === null
        && observed.producingJobId === null;
    }
    const phase = graph.edgePolicy === 'always-on'
      ? 'post-restart-auto'
      : 'post-restart-explicit';
    return snapshotsAdvance(graph.selectedSnapshot, graph.finalSnapshot)
      && exactGraph(observed, graph.finalSnapshot)
      && observed?.runtimeSyncMode === graph.edgePolicy
      && observed.producingJobId
        === edgeJobId(evidence.edge.operations, graph.contextGraphId, phase);
  });
  const edgeUnselectedExcluded = publicGraphs
    .filter((graph) => graph.edgePolicy === 'unselected')
    .every((graph) => absentGraph(edgeSelected.get(graph.contextGraphId))
      && absentGraph(edgeRestarted.get(graph.contextGraphId))
      && absentGraph(edgeSecondOnDemand.get(graph.contextGraphId))
      && [edgeSelected, edgeRestarted, edgeSecondOnDemand].every((phase) =>
        phase.get(graph.contextGraphId)?.runtimeSyncMode === null
          && phase.get(graph.contextGraphId)?.producingJobId === null));
  const edgePrivateExcluded = privateGraphs.every((graph) =>
    absentGraph(edgeSelected.get(graph.contextGraphId))
      && absentGraph(edgeRestarted.get(graph.contextGraphId))
      && absentGraph(edgeSecondOnDemand.get(graph.contextGraphId))
      && [edgeSelected, edgeRestarted, edgeSecondOnDemand].every((phase) =>
        phase.get(graph.contextGraphId)?.runtimeSyncMode === null
          && phase.get(graph.contextGraphId)?.producingJobId === null));

  const coreBatchMatchesManifest = evidence.core.automaticBatchSize
    === corpus.coreAutomaticBatchSize;
  const coreBatchWithinBound = evidence.core.rounds.every((round) =>
    round.contextGraphIds.length <= corpus.coreAutomaticBatchSize);
  const coreRoundsPublicOnly = evidence.core.rounds.every((round) => {
    const unique = new Set(round.contextGraphIds);
    return unique.size === round.contextGraphIds.length
      && round.contextGraphIds.every((contextGraphId) => byId.get(contextGraphId)?.accessPolicy === 0);
  });
  const automaticJobs = new Map(evidence.core.rounds.map((round) => [round.jobId, round]));
  const coreAutomaticProvenance = automaticJobs.size === evidence.core.rounds.length
    && evidence.core.rounds.every((round) =>
      round.source === 'automatic-core-public'
      && round.planningLane === expected.publisherPeerId
      && round.configuredBatchSize === corpus.coreAutomaticBatchSize
      && round.explicitSelectedContextGraphIds.length === 0
      && new Set(round.completions.map((completion) => completion.contextGraphId)).size
        === round.completions.length
      && round.completions.every((completion) => {
        const graph = byId.get(completion.contextGraphId);
        return round.contextGraphIds.includes(completion.contextGraphId)
          && completion.completedWave === 'final'
          && graph?.accessPolicy === 0
          && exactSnapshot(completion.completedSnapshot, graph.finalSnapshot);
      }))
    && evidence.core.final.every((observation) => {
      const graph = byId.get(observation.contextGraphId);
      if (graph?.accessPolicy !== 0) return observation.automaticJobIds.length === 0;
      return observation.automaticJobIds.length > 0
        && observation.automaticJobIds.every((jobId) =>
          automaticJobs.get(jobId)?.contextGraphIds.includes(observation.contextGraphId) === true)
        && observation.automaticJobIds.some((jobId) =>
          automaticJobs.get(jobId)?.completions.some((completion) =>
            completion.contextGraphId === observation.contextGraphId
              && exactSnapshot(completion.completedSnapshot, graph.finalSnapshot)));
    });
  const scheduled = new Set(evidence.core.rounds.flatMap((round) => round.contextGraphIds));
  const missingCoreContextGraphIds = publicGraphs
    .map((graph) => graph.contextGraphId)
    .filter((contextGraphId) => !scheduled.has(contextGraphId));
  const coreEveryPublicScheduled = missingCoreContextGraphIds.length === 0;
  const scheduledWithinWindow = new Set(
    evidence.core.rounds
      .slice(0, corpus.coreCoverageRoundLimit)
      .flatMap((round) => round.contextGraphIds),
  );
  const coreCoverageWithinWindow = publicGraphs.every((graph) =>
    scheduledWithinWindow.has(graph.contextGraphId));
  const coreFinalPublicExact = publicGraphs.every((graph) =>
    exactGraph(coreFinal.get(graph.contextGraphId), graph.finalSnapshot));
  const corePrivateExcluded = privateGraphs.every((graph) =>
    absentGraph(coreFinal.get(graph.contextGraphId)) && !scheduled.has(graph.contextGraphId));

  const requiredExactPlanes: Array<readonly [PlaneObservationV1 | undefined, PlaneExpectationV1]> = [];
  for (const graph of corpus.graphs) {
    if (graph.accessPolicy === 0 && graph.edgePolicy !== 'unselected') {
      const selected = edgeSelected.get(graph.contextGraphId);
      requiredExactPlanes.push([selected?.vm, graph.selectedSnapshot.vm], [selected?.swm, graph.selectedSnapshot.swm]);
      const restarted = edgeRestarted.get(graph.contextGraphId);
      const expected = graph.edgePolicy === 'always-on' ? graph.finalSnapshot : graph.selectedSnapshot;
      requiredExactPlanes.push([restarted?.vm, expected.vm], [restarted?.swm, expected.swm]);
      const secondOnDemand = edgeSecondOnDemand.get(graph.contextGraphId);
      requiredExactPlanes.push(
        [secondOnDemand?.vm, graph.finalSnapshot.vm],
        [secondOnDemand?.swm, graph.finalSnapshot.swm],
      );
    }
    if (graph.accessPolicy === 0) {
      const final = coreFinal.get(graph.contextGraphId);
      requiredExactPlanes.push([final?.vm, graph.finalSnapshot.vm], [final?.swm, graph.finalSnapshot.swm]);
    }
  }
  const noMetadataOnlyCompletion = requiredExactPlanes.every(([observed, expected]) =>
    exactPlane(observed, expected) && (observed?.dataTripleCount ?? 0) > 0);

  const checks = Object.freeze({
    schemaWellFormed: true,
    provenanceMatches,
    corpusDigestMatches,
    corpusCanonicalOrder,
    requiredPolicyCellsPresent,
    publisherSnapshotsExact,
    publicSecondWaveAdvances,
    edgePassiveBeforeSelection,
    edgeSelectedSnapshotsExact,
    edgeOnDemandRemainsPointInTime,
    edgeAlwaysOnRefreshesAfterRestart,
    edgeOperationProvenance,
    edgeSecondOnDemandConverges,
    edgeUnselectedExcluded,
    edgePrivateExcluded,
    coreBatchMatchesManifest,
    coreBatchWithinBound,
    coreRoundsPublicOnly,
    coreAutomaticProvenance,
    coreEveryPublicScheduled,
    coreCoverageWithinWindow,
    coreFinalPublicExact,
    corePrivateExcluded,
    noMetadataOnlyCompletion,
  }) satisfies SelectiveCoverageChecksV1;
  const rejectReasons = CHECK_NAMES.filter((name) => !checks[name]).map((name) => REASONS[name]);
  return Object.freeze({
    schema: SELECTIVE_COVERAGE_VERDICT_SCHEMA,
    pass: CHECK_NAMES.every((name) => checks[name]),
    checks,
    missingCoreContextGraphIds: Object.freeze(missingCoreContextGraphIds),
    rejectReasons: Object.freeze(rejectReasons),
    recomputedCorpusDigest: computeSelectiveCoverageCorpusDigest(corpus),
  });
}

function parseEvidence(input: unknown): SelectiveCoverageEvidenceV1 | undefined {
  const root = closedRecord(input, [
    'schema', 'provenance', 'corpus', 'publisher', 'edge', 'core',
  ]);
  if (!root || root.schema !== SELECTIVE_COVERAGE_EVIDENCE_SCHEMA) return undefined;
  const provenance = parseProvenance(root.provenance);
  const corpus = parseCorpus(root.corpus);
  const publisher = closedRecord(root.publisher, ['selected', 'final']);
  const edge = closedRecord(root.edge, [
    'beforeSelection', 'afterSelection', 'afterRestart', 'afterSecondOnDemand', 'operations',
  ]);
  const core = closedRecord(root.core, ['automaticBatchSize', 'rounds', 'final']);
  if (!provenance || !corpus || !publisher || !edge || !core) return undefined;
  const publisherSelected = parseObservations(publisher.selected);
  const publisherFinal = parseObservations(publisher.final);
  const beforeSelection = parseEdgeObservations(edge.beforeSelection);
  const afterSelection = parseEdgeObservations(edge.afterSelection);
  const afterRestart = parseEdgeObservations(edge.afterRestart);
  const afterSecondOnDemand = parseEdgeObservations(edge.afterSecondOnDemand);
  const operations = parseEdgeOperations(edge.operations);
  const final = parseCoreFinalObservations(core.final);
  if (!publisherSelected || !publisherFinal || !beforeSelection || !afterSelection
    || !afterRestart || !afterSecondOnDemand || !operations || !final) return undefined;
  if (!nonNegativeInteger(core.automaticBatchSize)) return undefined;
  if (!closedArray(core.rounds, 1, MAX_SELECTIVE_COVERAGE_ROUNDS)) return undefined;
  const rounds: CoreAutomaticRoundV1[] = [];
  for (let index = 0; index < core.rounds.length; index += 1) {
    const row = closedRecord(core.rounds[index], [
      'round', 'jobId', 'planningLane', 'source', 'configuredBatchSize',
      'explicitSelectedContextGraphIds', 'contextGraphIds', 'completions',
    ]);
    if (!row || row.round !== index
      || row.source !== 'automatic-core-public'
      || !positiveInteger(row.configuredBatchSize)
      || !closedArray(row.explicitSelectedContextGraphIds, 0, MAX_SELECTIVE_COVERAGE_GRAPHS)
      || !closedArray(row.contextGraphIds, 0, MAX_SELECTIVE_COVERAGE_GRAPHS)
      || !closedArray(row.completions, 0, MAX_SELECTIVE_COVERAGE_GRAPHS)) return undefined;
    const jobId = identifier(row.jobId);
    const planningLane = identifier(row.planningLane);
    if (!jobId || !planningLane) return undefined;
    const explicitSelectedContextGraphIds: string[] = [];
    for (const id of row.explicitSelectedContextGraphIds) {
      const parsed = identifier(id);
      if (!parsed) return undefined;
      explicitSelectedContextGraphIds.push(parsed);
    }
    const ids: string[] = [];
    for (const id of row.contextGraphIds) {
      const parsed = identifier(id);
      if (!parsed) return undefined;
      ids.push(parsed);
    }
    const completions = [];
    for (const inputCompletion of row.completions) {
      const completion = closedRecord(inputCompletion, [
        'contextGraphId', 'completedWave', 'completedSnapshot',
      ]);
      if (!completion || completion.completedWave !== 'final') return undefined;
      const contextGraphId = identifier(completion.contextGraphId);
      const completedSnapshot = parseSnapshot(completion.completedSnapshot);
      if (!contextGraphId || !completedSnapshot) return undefined;
      completions.push({
        contextGraphId,
        completedWave: 'final' as const,
        completedSnapshot,
      });
    }
    rounds.push({
      round: index,
      jobId,
      planningLane,
      source: 'automatic-core-public',
      configuredBatchSize: row.configuredBatchSize as number,
      explicitSelectedContextGraphIds: Object.freeze(explicitSelectedContextGraphIds),
      contextGraphIds: Object.freeze(ids),
      completions: Object.freeze(completions),
    });
  }
  return {
    schema: SELECTIVE_COVERAGE_EVIDENCE_SCHEMA,
    provenance,
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

function parseCorpus(input: unknown): SelectiveCoverageCorpusV1 | undefined {
  const root = closedRecord(input, [
    'schema', 'networkId', 'coreAutomaticBatchSize', 'coreCoverageRoundLimit',
    'graphs', 'manifestDigest',
  ]);
  if (!root || root.schema !== SELECTIVE_COVERAGE_CORPUS_SCHEMA) return undefined;
  const networkId = identifier(root.networkId);
  const manifestDigest = digest(root.manifestDigest);
  if (!networkId || !manifestDigest || !positiveInteger(root.coreAutomaticBatchSize)
    || !positiveInteger(root.coreCoverageRoundLimit)
    || (root.coreCoverageRoundLimit as number) > MAX_SELECTIVE_COVERAGE_ROUNDS
    || !closedArray(root.graphs, 1, MAX_SELECTIVE_COVERAGE_GRAPHS)) return undefined;
  const graphs: SelectiveCoverageGraphV1[] = [];
  for (const inputGraph of root.graphs) {
    const graph = closedRecord(inputGraph, [
      'contextGraphId', 'accessPolicy', 'publishPolicy', 'edgePolicy',
      'selectedSnapshot', 'finalSnapshot',
    ]);
    if (!graph) return undefined;
    const contextGraphId = identifier(graph.contextGraphId);
    const accessPolicy = binaryPolicy(graph.accessPolicy);
    const publishPolicy = binaryPolicy(graph.publishPolicy);
    const edgePolicy = parseEdgePolicy(graph.edgePolicy);
    const selectedSnapshot = parseSnapshot(graph.selectedSnapshot);
    const finalSnapshot = parseSnapshot(graph.finalSnapshot);
    if (!contextGraphId || accessPolicy === undefined || publishPolicy === undefined
      || !edgePolicy || !selectedSnapshot || !finalSnapshot) return undefined;
    if (accessPolicy === 1 && edgePolicy !== 'unselected') return undefined;
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
    coreAutomaticBatchSize: root.coreAutomaticBatchSize as number,
    coreCoverageRoundLimit: root.coreCoverageRoundLimit as number,
    graphs: Object.freeze(graphs),
    manifestDigest,
  };
}

function parseProvenance(input: unknown): SelectiveCoverageEvidenceV1['provenance'] | undefined {
  const root = closedRecord(input, [
    'networkId', 'testedHeadCommit', 'runtimeManifestDigest',
    'publisherPeerId', 'edgePeerId', 'corePeerId',
  ]);
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

function parseExpectedProvenance(
  input: unknown,
): ExpectedSelectiveCoverageProvenanceV1 | undefined {
  const root = closedRecord(input, [
    'networkId', 'testedHeadCommit', 'runtimeManifestDigest', 'corpusManifestDigest',
    'publisherPeerId', 'edgePeerId', 'corePeerId',
  ]);
  if (!root) return undefined;
  const { corpusManifestDigest: _omitted, ...provenanceInput } = root;
  const provenance = parseProvenance(provenanceInput);
  const corpusManifestDigest = digest(root.corpusManifestDigest);
  return provenance && corpusManifestDigest
    ? { ...provenance, corpusManifestDigest }
    : undefined;
}

function parseSnapshot(input: unknown): GraphSnapshotExpectationV1 | undefined {
  const root = closedRecord(input, ['vm', 'swm']);
  if (!root) return undefined;
  const vm = parseExpectation(root.vm);
  const swm = parseExpectation(root.swm);
  return vm && swm ? { vm, swm } : undefined;
}

function parseExpectation(input: unknown): PlaneExpectationV1 | undefined {
  const root = closedRecord(input, ['headDigest', 'inventoryDigest', 'assetCount', 'dataTripleCount']);
  if (!root) return undefined;
  const headDigest = digest(root.headDigest);
  const inventoryDigest = digest(root.inventoryDigest);
  if (!headDigest || !inventoryDigest || !positiveInteger(root.assetCount)
    || !positiveInteger(root.dataTripleCount)) return undefined;
  return {
    headDigest,
    inventoryDigest,
    assetCount: root.assetCount as number,
    dataTripleCount: root.dataTripleCount as number,
  };
}

function parseObservations(input: unknown): readonly GraphObservationV1[] | undefined {
  if (!closedArray(input, 1, MAX_SELECTIVE_COVERAGE_GRAPHS)) return undefined;
  const result: GraphObservationV1[] = [];
  for (const inputRow of input) {
    const row = closedRecord(inputRow, ['contextGraphId', 'vm', 'swm']);
    if (!row) return undefined;
    const contextGraphId = identifier(row.contextGraphId);
    const vm = parseObservation(row.vm);
    const swm = parseObservation(row.swm);
    if (!contextGraphId || !vm || !swm) return undefined;
    result.push({ contextGraphId, vm, swm });
  }
  return Object.freeze(result);
}

function parseEdgeObservations(input: unknown): readonly EdgeGraphObservationV1[] | undefined {
  if (!closedArray(input, 1, MAX_SELECTIVE_COVERAGE_GRAPHS)) return undefined;
  const result: EdgeGraphObservationV1[] = [];
  for (const inputRow of input) {
    const row = closedRecord(inputRow, [
      'contextGraphId', 'runtimeSyncMode', 'producingJobId', 'vm', 'swm',
    ]);
    if (!row) return undefined;
    const contextGraphId = identifier(row.contextGraphId);
    const vm = parseObservation(row.vm);
    const swm = parseObservation(row.swm);
    const runtimeSyncMode = row.runtimeSyncMode;
    const producingJobId = row.producingJobId === null ? null : identifier(row.producingJobId);
    if (!contextGraphId || !vm || !swm
      || producingJobId === undefined
      || (runtimeSyncMode !== null && runtimeSyncMode !== 'on-demand'
        && runtimeSyncMode !== 'always-on')) return undefined;
    result.push({ contextGraphId, runtimeSyncMode, producingJobId, vm, swm });
  }
  return Object.freeze(result);
}

function parseEdgeOperations(input: unknown): readonly EdgeSyncOperationV1[] | undefined {
  if (!closedArray(input, 1, MAX_SELECTIVE_COVERAGE_GRAPHS * 2)) return undefined;
  const result: EdgeSyncOperationV1[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const row = closedRecord(input[index], [
      'sequence', 'phase', 'source', 'syncMode', 'contextGraphId', 'jobId',
      'completedWave', 'completedSnapshot',
    ]);
    if (!row || row.sequence !== index) return undefined;
    const phase = row.phase;
    const source = row.source;
    const syncMode = row.syncMode;
    const contextGraphId = identifier(row.contextGraphId);
    const jobId = identifier(row.jobId);
    const completedWave = row.completedWave;
    const completedSnapshot = parseSnapshot(row.completedSnapshot);
    if ((phase !== 'selection' && phase !== 'post-restart-auto'
      && phase !== 'post-restart-explicit')
      || (source !== 'reconciler' && source !== 'user')
      || (syncMode !== 'always-on' && syncMode !== 'on-demand')
      || (completedWave !== 'selected' && completedWave !== 'final')
      || !completedSnapshot || !contextGraphId || !jobId) return undefined;
    result.push({
      sequence: index,
      phase,
      source,
      syncMode,
      contextGraphId,
      jobId,
      completedWave,
      completedSnapshot,
    });
  }
  return Object.freeze(result);
}

function parseCoreFinalObservations(
  input: unknown,
): readonly CoreFinalObservationV1[] | undefined {
  if (!closedArray(input, 1, MAX_SELECTIVE_COVERAGE_GRAPHS)) return undefined;
  const result: CoreFinalObservationV1[] = [];
  for (const inputRow of input) {
    const row = closedRecord(inputRow, ['contextGraphId', 'automaticJobIds', 'vm', 'swm']);
    if (!row || !closedArray(row.automaticJobIds, 0, MAX_SELECTIVE_COVERAGE_ROUNDS)) {
      return undefined;
    }
    const contextGraphId = identifier(row.contextGraphId);
    const vm = parseObservation(row.vm);
    const swm = parseObservation(row.swm);
    const automaticJobIds: string[] = [];
    for (const inputJobId of row.automaticJobIds) {
      const jobId = identifier(inputJobId);
      if (!jobId) return undefined;
      automaticJobIds.push(jobId);
    }
    if (!contextGraphId || !vm || !swm
      || new Set(automaticJobIds).size !== automaticJobIds.length) return undefined;
    result.push({ contextGraphId, automaticJobIds: Object.freeze(automaticJobIds), vm, swm });
  }
  return Object.freeze(result);
}

function parseObservation(input: unknown): PlaneObservationV1 | undefined {
  const root = closedRecord(input, [
    'reportedComplete', 'headDigest', 'inventoryDigest', 'assetCount',
    'metadataTripleCount', 'dataTripleCount',
  ]);
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
    assetCount: root.assetCount as number,
    metadataTripleCount: root.metadataTripleCount as number,
    dataTripleCount: root.dataTripleCount as number,
  };
}

function hasRequiredPolicyCells(graphs: readonly SelectiveCoverageGraphV1[]): boolean {
  return graphs.some((graph) => graph.accessPolicy === 0 && graph.edgePolicy === 'on-demand')
    && graphs.some((graph) => graph.accessPolicy === 0 && graph.edgePolicy === 'always-on')
    && graphs.some((graph) => graph.accessPolicy === 0 && graph.edgePolicy === 'unselected')
    && graphs.some((graph) => graph.accessPolicy === 0 && graph.publishPolicy === 1)
    && graphs.some((graph) => graph.accessPolicy === 0 && graph.publishPolicy === 0)
    && graphs.some((graph) => graph.accessPolicy === 1 && graph.publishPolicy === 1)
    && graphs.some((graph) => graph.accessPolicy === 1 && graph.publishPolicy === 0);
}

function verifyEdgeOperations(
  operations: readonly EdgeSyncOperationV1[],
  graphs: readonly SelectiveCoverageGraphV1[],
): boolean {
  const selected = graphs.filter((graph) =>
    graph.accessPolicy === 0 && graph.edgePolicy !== 'unselected');
  if (operations.length !== selected.length * 2
    || new Set(operations.map((operation) => operation.jobId)).size !== operations.length) {
    return false;
  }
  const selectionSequences = operations
    .filter((operation) => operation.phase === 'selection')
    .map((operation) => operation.sequence);
  const automaticSequences = operations
    .filter((operation) => operation.phase === 'post-restart-auto')
    .map((operation) => operation.sequence);
  const secondOnDemandSequences = operations
    .filter((operation) => operation.phase === 'post-restart-explicit')
    .map((operation) => operation.sequence);
  if (selectionSequences.length === 0
    || Math.max(...selectionSequences) >= Math.min(...automaticSequences)
    || Math.max(...automaticSequences) >= Math.min(...secondOnDemandSequences)) return false;
  return selected.every((graph) => {
    const graphOperations = operations.filter((operation) =>
      operation.contextGraphId === graph.contextGraphId);
    if (graphOperations.length !== 2) return false;
    const selection = graphOperations.find((operation) => operation.phase === 'selection');
    if (selection?.source !== 'user' || selection.syncMode !== graph.edgePolicy
      || selection.completedWave !== 'selected'
      || !exactSnapshot(selection.completedSnapshot, graph.selectedSnapshot)) return false;
    if (graph.edgePolicy === 'on-demand') {
      const refresh = graphOperations.find((operation) =>
        operation.phase === 'post-restart-explicit');
      return refresh?.source === 'user' && refresh.syncMode === 'on-demand'
        && refresh.completedWave === 'final'
        && exactSnapshot(refresh.completedSnapshot, graph.finalSnapshot);
    }
    const refresh = graphOperations.find((operation) =>
      operation.phase === 'post-restart-auto');
    return refresh?.source === 'reconciler' && refresh.syncMode === 'always-on'
      && refresh.completedWave === 'final'
      && exactSnapshot(refresh.completedSnapshot, graph.finalSnapshot);
  }) && operations.every((operation) => {
    const graph = graphs.find((candidate) =>
      candidate.contextGraphId === operation.contextGraphId);
    return graph?.accessPolicy === 0 && graph.edgePolicy !== 'unselected';
  });
}

function edgeJobId(
  operations: readonly EdgeSyncOperationV1[],
  contextGraphId: string,
  phase: EdgeSyncOperationV1['phase'],
): string | undefined {
  return operations.find((operation) =>
    operation.contextGraphId === contextGraphId && operation.phase === phase)?.jobId;
}

function exactGraph(
  observed: GraphObservationV1 | undefined,
  expected: GraphSnapshotExpectationV1,
): boolean {
  return exactPlane(observed?.vm, expected.vm) && exactPlane(observed?.swm, expected.swm);
}

function exactPlane(
  observed: PlaneObservationV1 | undefined,
  expected: PlaneExpectationV1,
): boolean {
  return observed?.reportedComplete === true
    && observed.headDigest === expected.headDigest
    && observed.inventoryDigest === expected.inventoryDigest
    && observed.assetCount === expected.assetCount
    && observed.metadataTripleCount > 0
    && observed.dataTripleCount === expected.dataTripleCount;
}

function absentGraph(observed: GraphObservationV1 | undefined): boolean {
  return absentPlane(observed?.vm) && absentPlane(observed?.swm);
}

function absentPlane(observed: PlaneObservationV1 | undefined): boolean {
  return observed?.reportedComplete === false
    && observed.headDigest === null
    && observed.inventoryDigest === null
    && observed.assetCount === 0
    && observed.dataTripleCount === 0;
}

function exactSnapshot(
  left: GraphSnapshotExpectationV1,
  right: GraphSnapshotExpectationV1,
): boolean {
  return exactExpectation(left.vm, right.vm) && exactExpectation(left.swm, right.swm);
}

function exactExpectation(left: PlaneExpectationV1, right: PlaneExpectationV1): boolean {
  return left.headDigest === right.headDigest
    && left.inventoryDigest === right.inventoryDigest
    && left.assetCount === right.assetCount
    && left.dataTripleCount === right.dataTripleCount;
}

function snapshotsAdvance(
  left: GraphSnapshotExpectationV1,
  right: GraphSnapshotExpectationV1,
): boolean {
  return left.vm.headDigest !== right.vm.headDigest
    && left.vm.inventoryDigest !== right.vm.inventoryDigest
    && left.swm.headDigest !== right.swm.headDigest
    && left.swm.inventoryDigest !== right.swm.inventoryDigest
    && right.vm.assetCount > left.vm.assetCount
    && right.vm.dataTripleCount > left.vm.dataTripleCount
    && right.swm.assetCount > left.swm.assetCount
    && right.swm.dataTripleCount > left.swm.dataTripleCount;
}

function byObservationId<T extends GraphObservationV1>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.contextGraphId, row]));
}

function exactCanonicalIds(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((id, index) => id === expected[index]);
}

function strictlyIncreasing(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function closedRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) return undefined;
  const actual = (ownKeys as string[]).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return undefined;
  }
  if (actual.some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !descriptor?.enumerable || !('value' in descriptor);
  })) return undefined;
  return value as Record<string, unknown>;
}

function closedArray(value: unknown, minimum: number, maximum: number): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < minimum || value.length > maximum) return false;
  const expected = new Set<PropertyKey>(['length']);
  for (let index = 0; index < value.length; index += 1) expected.add(String(index));
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expected.size || ownKeys.some((key) => !expected.has(key))) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) return false;
  }
  return true;
}

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 256 && ID.test(value) ? value : undefined;
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

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function schemaReject(): SelectiveCoverageVerdictV1 {
  const checks = Object.freeze(Object.fromEntries(
    CHECK_NAMES.map((name) => [name, false]),
  )) as Readonly<SelectiveCoverageChecksV1>;
  return Object.freeze({
    schema: SELECTIVE_COVERAGE_VERDICT_SCHEMA,
    pass: false,
    checks,
    missingCoreContextGraphIds: Object.freeze([]),
    rejectReasons: Object.freeze([REASONS.schemaWellFormed]),
    recomputedCorpusDigest: '',
  });
}
