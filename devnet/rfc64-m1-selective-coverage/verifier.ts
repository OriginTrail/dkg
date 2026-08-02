import {
  SELECTIVE_COVERAGE_VERDICT_SCHEMA,
  computeSelectiveCoverageCorpusDigest,
  type CoreAutomaticRoundV1,
  type CoreFinalObservationV1,
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
import {
  assertCoreAutomaticRoundJournalV1,
  assertEdgeReconcilerJournalV1,
} from './sync-coverage-journal.ts';
import {
  buildEdgeOperationPlan,
  findEdgeOperationPlanStep,
  matchesEdgeOperationPlanStep,
  type EdgeOperationPlanV1,
} from './edge-operation-plan.ts';

import {
  decodeExpectedSelectiveCoverageProvenance,
  decodeSelectiveCoverageEvidence,
} from './evidence-codec.ts';

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
    if (!decodeExpectedSelectiveCoverageProvenance(expected)) return schemaReject();
    const evidence = decodeSelectiveCoverageEvidence(input);
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
  const context = buildVerificationContext(evidence, expected);
  const envelope = verifyEnvelope(context);
  const publisher = verifyPublisher(context);
  const edge = verifyEdge(context);
  const core = verifyCore(context);
  const checks = Object.freeze({
    schemaWellFormed: true,
    ...envelope,
    ...publisher,
    ...edge,
    ...core.checks,
    noMetadataOnlyCompletion: verifyExactPayloads(context),
  }) satisfies SelectiveCoverageChecksV1;
  const rejectReasons = CHECK_NAMES.filter((name) => !checks[name]).map((name) => REASONS[name]);
  return Object.freeze({
    schema: SELECTIVE_COVERAGE_VERDICT_SCHEMA,
    pass: CHECK_NAMES.every((name) => checks[name]),
    checks,
    missingCoreContextGraphIds: core.missingContextGraphIds,
    rejectReasons: Object.freeze(rejectReasons),
    recomputedCorpusDigest: computeSelectiveCoverageCorpusDigest(context.corpus),
  });
}

interface VerificationContext {
  readonly evidence: SelectiveCoverageEvidenceV1;
  readonly expected: ExpectedSelectiveCoverageProvenanceV1;
  readonly corpus: SelectiveCoverageCorpusV1;
  readonly graphIds: readonly string[];
  readonly publicGraphs: readonly SelectiveCoverageGraphV1[];
  readonly privateGraphs: readonly SelectiveCoverageGraphV1[];
  readonly byId: ReadonlyMap<string, SelectiveCoverageGraphV1>;
  readonly publisherSelected: ReadonlyMap<string, GraphObservationV1>;
  readonly publisherFinal: ReadonlyMap<string, GraphObservationV1>;
  readonly edgeBefore: ReadonlyMap<string, EdgeGraphObservationV1>;
  readonly edgeSelected: ReadonlyMap<string, EdgeGraphObservationV1>;
  readonly edgeRestarted: ReadonlyMap<string, EdgeGraphObservationV1>;
  readonly edgeSecondOnDemand: ReadonlyMap<string, EdgeGraphObservationV1>;
  readonly coreFinal: ReadonlyMap<string, CoreFinalObservationV1>;
}

function buildVerificationContext(
  evidence: SelectiveCoverageEvidenceV1,
  expected: ExpectedSelectiveCoverageProvenanceV1,
): VerificationContext {
  const corpus = evidence.corpus;
  return {
    evidence,
    expected,
    corpus,
    graphIds: corpus.graphs.map((graph) => graph.contextGraphId),
    publicGraphs: corpus.graphs.filter((graph) => graph.accessPolicy === 0),
    privateGraphs: corpus.graphs.filter((graph) => graph.accessPolicy === 1),
    byId: new Map(corpus.graphs.map((graph) => [graph.contextGraphId, graph])),
    publisherSelected: byObservationId(evidence.publisher.selected),
    publisherFinal: byObservationId(evidence.publisher.final),
    edgeBefore: byObservationId(evidence.edge.beforeSelection),
    edgeSelected: byObservationId(evidence.edge.afterSelection),
    edgeRestarted: byObservationId(evidence.edge.afterRestart),
    edgeSecondOnDemand: byObservationId(evidence.edge.afterSecondOnDemand),
    coreFinal: byObservationId(evidence.core.final),
  };
}

function verifyEnvelope(context: VerificationContext) {
  const { evidence, expected, corpus, graphIds } = context;
  const observationsCanonical = [
    evidence.publisher.selected,
    evidence.publisher.final,
    evidence.edge.beforeSelection,
    evidence.edge.afterSelection,
    evidence.edge.afterRestart,
    evidence.edge.afterSecondOnDemand,
    evidence.core.final,
  ].every((rows) => exactCanonicalIds(rows.map((row) => row.contextGraphId), graphIds));
  return {
    provenanceMatches: evidence.provenance.networkId === expected.networkId
      && evidence.provenance.testedHeadCommit === expected.testedHeadCommit
      && evidence.provenance.runtimeManifestDigest === expected.runtimeManifestDigest
      && evidence.provenance.publisherPeerId === expected.publisherPeerId
      && evidence.provenance.edgePeerId === expected.edgePeerId
      && evidence.provenance.corePeerId === expected.corePeerId
      && corpus.networkId === expected.networkId
      && corpus.manifestDigest === expected.corpusManifestDigest,
    corpusDigestMatches: computeSelectiveCoverageCorpusDigest(corpus) === corpus.manifestDigest,
    corpusCanonicalOrder: strictlyIncreasing(graphIds) && observationsCanonical,
    requiredPolicyCellsPresent: hasRequiredPolicyCells(corpus.graphs),
  };
}

function verifyPublisher(context: VerificationContext) {
  return {
    publisherSnapshotsExact: context.corpus.graphs.every((graph) =>
      exactGraph(context.publisherSelected.get(graph.contextGraphId), graph.selectedSnapshot)
        && exactGraph(context.publisherFinal.get(graph.contextGraphId), graph.finalSnapshot)),
    publicSecondWaveAdvances: context.publicGraphs.every((graph) =>
      snapshotsAdvance(graph.selectedSnapshot, graph.finalSnapshot)),
  };
}

function verifyEdge(context: VerificationContext) {
  const { corpus, evidence, edgeBefore, edgeSelected, edgeRestarted,
    edgeSecondOnDemand } = context;
  const operationPlan = buildEdgeOperationPlan(corpus);
  const edgePassiveBeforeSelection = corpus.graphs.every((graph) =>
    absentGraph(edgeBefore.get(graph.contextGraphId))
      && edgeBefore.get(graph.contextGraphId)?.runtimeSyncMode === null
      && edgeBefore.get(graph.contextGraphId)?.producingJobId === null);
  const edgeSelectedSnapshotsExact = corpus.graphs.every((graph) => {
    const observed = edgeSelected.get(graph.contextGraphId);
    return graph.accessPolicy === 0 && graph.edgePolicy !== 'unselected'
      ? exactGraph(observed, graph.selectedSnapshot)
        && observed?.runtimeSyncMode === graph.edgePolicy
        && observed.producingJobId
          === edgeJobId(operationPlan, evidence.edge.operations, graph.contextGraphId, 'selection')
      : absentGraph(observed) && observed?.runtimeSyncMode === null
        && observed.producingJobId === null;
  });
  const edgeOnDemandRemainsPointInTime = corpus.graphs
    .filter((graph) => graph.edgePolicy === 'on-demand')
    .every((graph) => exactGraph(edgeRestarted.get(graph.contextGraphId), graph.selectedSnapshot)
      && edgeRestarted.get(graph.contextGraphId)?.runtimeSyncMode === null
      && edgeRestarted.get(graph.contextGraphId)?.producingJobId
        === edgeJobId(operationPlan, evidence.edge.operations, graph.contextGraphId, 'selection'));
  const edgeAlwaysOnRefreshesAfterRestart = corpus.graphs
    .filter((graph) => graph.edgePolicy === 'always-on')
    .every((graph) => snapshotsAdvance(graph.selectedSnapshot, graph.finalSnapshot)
      && exactGraph(edgeRestarted.get(graph.contextGraphId), graph.finalSnapshot)
      && edgeRestarted.get(graph.contextGraphId)?.runtimeSyncMode === 'always-on'
      && edgeRestarted.get(graph.contextGraphId)?.producingJobId
        === edgeJobId(
          operationPlan,
          evidence.edge.operations,
          graph.contextGraphId,
          'post-restart-auto',
        ));
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
        === edgeJobId(operationPlan, evidence.edge.operations, graph.contextGraphId, phase);
  });
  const excluded = (graph: SelectiveCoverageGraphV1) =>
    absentGraph(edgeSelected.get(graph.contextGraphId))
      && absentGraph(edgeRestarted.get(graph.contextGraphId))
      && absentGraph(edgeSecondOnDemand.get(graph.contextGraphId))
      && [edgeSelected, edgeRestarted, edgeSecondOnDemand].every((phase) =>
        phase.get(graph.contextGraphId)?.runtimeSyncMode === null
          && phase.get(graph.contextGraphId)?.producingJobId === null);
  return {
    edgePassiveBeforeSelection,
    edgeSelectedSnapshotsExact,
    edgeOnDemandRemainsPointInTime,
    edgeAlwaysOnRefreshesAfterRestart,
    edgeOperationProvenance: verifyEdgeOperations(evidence.edge.operations, operationPlan)
      && verifyAutomaticEdgeJournals(evidence),
    edgeSecondOnDemandConverges,
    edgeUnselectedExcluded: context.publicGraphs
      .filter((graph) => graph.edgePolicy === 'unselected').every(excluded),
    edgePrivateExcluded: context.privateGraphs.every(excluded),
  };
}

function verifyCore(context: VerificationContext) {
  const { evidence, expected, corpus, byId, coreFinal } = context;
  const automaticJobs = new Map(evidence.core.rounds.map((round) => [round.jobId, round]));
  const scheduled = new Set(evidence.core.rounds.flatMap((round) => round.contextGraphIds));
  const missingContextGraphIds = Object.freeze(context.publicGraphs
    .map((graph) => graph.contextGraphId)
    .filter((contextGraphId) => !scheduled.has(contextGraphId)));
  const scheduledWithinWindow = new Set(evidence.core.rounds
    .slice(0, corpus.coreCoverageRoundLimit)
    .flatMap((round) => round.contextGraphIds));
  const coreAutomaticProvenance = automaticJobs.size === evidence.core.rounds.length
    && verifyAutomaticCoreJournals(evidence)
    && evidence.core.rounds.every((round) =>
      round.source === 'automatic-core-public'
      && round.planningLane === expected.publisherPeerId
      && round.configuredBatchSize === corpus.coreAutomaticBatchSize
      && round.explicitSelectedContextGraphIds.length === 0
      && round.completions.length === round.contextGraphIds.length
      && new Set(round.completions.map((completion) => completion.contextGraphId)).size
        === round.completions.length
      && round.completions.every((completion, index) => {
        const graph = byId.get(completion.contextGraphId);
        return round.contextGraphIds[index] === completion.contextGraphId
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
  return {
    checks: {
      coreBatchMatchesManifest: evidence.core.automaticBatchSize
        === corpus.coreAutomaticBatchSize,
      coreBatchWithinBound: evidence.core.rounds.every((round) =>
        round.contextGraphIds.length <= corpus.coreAutomaticBatchSize),
      coreRoundsPublicOnly: evidence.core.rounds.every((round) =>
        new Set(round.contextGraphIds).size === round.contextGraphIds.length
          && round.contextGraphIds.every((id) => byId.get(id)?.accessPolicy === 0)),
      coreAutomaticProvenance,
      coreEveryPublicScheduled: missingContextGraphIds.length === 0,
      coreCoverageWithinWindow: context.publicGraphs.every((graph) =>
        scheduledWithinWindow.has(graph.contextGraphId)),
      coreFinalPublicExact: context.publicGraphs.every((graph) =>
        exactGraph(coreFinal.get(graph.contextGraphId), graph.finalSnapshot)),
      corePrivateExcluded: context.privateGraphs.every((graph) =>
        absentGraph(coreFinal.get(graph.contextGraphId)) && !scheduled.has(graph.contextGraphId)),
    },
    missingContextGraphIds,
  };
}

function verifyExactPayloads(context: VerificationContext): boolean {
  const required: Array<readonly [PlaneObservationV1 | undefined, PlaneExpectationV1]> = [];
  for (const graph of context.corpus.graphs) {
    if (graph.accessPolicy === 0 && graph.edgePolicy !== 'unselected') {
      const selected = context.edgeSelected.get(graph.contextGraphId);
      required.push([selected?.vm, graph.selectedSnapshot.vm], [selected?.swm, graph.selectedSnapshot.swm]);
      const restarted = context.edgeRestarted.get(graph.contextGraphId);
      const expected = graph.edgePolicy === 'always-on' ? graph.finalSnapshot : graph.selectedSnapshot;
      required.push([restarted?.vm, expected.vm], [restarted?.swm, expected.swm]);
      const final = context.edgeSecondOnDemand.get(graph.contextGraphId);
      required.push([final?.vm, graph.finalSnapshot.vm], [final?.swm, graph.finalSnapshot.swm]);
    }
    if (graph.accessPolicy === 0) {
      const final = context.coreFinal.get(graph.contextGraphId);
      required.push([final?.vm, graph.finalSnapshot.vm], [final?.swm, graph.finalSnapshot.swm]);
    }
  }
  return required.every(([observed, expected]) =>
    exactPlane(observed, expected) && (observed?.dataTripleCount ?? 0) > 0);
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

function verifyAutomaticEdgeJournals(evidence: SelectiveCoverageEvidenceV1): boolean {
  const operations = evidence.edge.operations.filter((operation) =>
    operation.phase === 'post-restart-auto');
  if (operations.length !== evidence.automaticJournalEvidence.edgeReconciler.length) {
    return false;
  }
  try {
    operations.forEach((operation, index) => assertEdgeReconcilerJournalV1(
      evidence.automaticJournalEvidence.edgeReconciler[index],
      operation,
      evidence.automaticJournalEvidence.edgeProcess,
    ));
    return true;
  } catch {
    return false;
  }
}

function verifyAutomaticCoreJournals(evidence: SelectiveCoverageEvidenceV1): boolean {
  if (evidence.core.rounds.length !== evidence.automaticJournalEvidence.coreRounds.length) {
    return false;
  }
  try {
    evidence.core.rounds.forEach((round, index) => assertCoreAutomaticRoundJournalV1(
      evidence.automaticJournalEvidence.coreRounds[index],
      round,
      evidence.automaticJournalEvidence.coreProcess,
    ));
    return true;
  } catch {
    return false;
  }
}

function verifyEdgeOperations(
  operations: readonly EdgeSyncOperationV1[],
  plan: EdgeOperationPlanV1,
): boolean {
  if (operations.length !== plan.ordered.length
    || new Set(operations.map((operation) => operation.jobId)).size !== operations.length) {
    return false;
  }
  return plan.ordered.every((step, index) =>
    matchesEdgeOperationPlanStep(operations[index], step));
}

function edgeJobId(
  plan: EdgeOperationPlanV1,
  operations: readonly EdgeSyncOperationV1[],
  contextGraphId: string,
  phase: EdgeSyncOperationV1['phase'],
): string | undefined {
  const step = findEdgeOperationPlanStep(plan, contextGraphId, phase);
  if (!step) return undefined;
  const operation = operations[step.sequence];
  return operation?.sequence === step.sequence
    && operation.phase === step.phase
    && operation.contextGraphId === step.contextGraphId
    ? operation.jobId
    : undefined;
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
