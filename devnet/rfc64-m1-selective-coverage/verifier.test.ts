import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  SELECTIVE_COVERAGE_EVIDENCE_SCHEMA,
  canonicalJson,
  createSelectiveCoverageCorpus,
  type GraphObservationV1,
  type GraphSnapshotExpectationV1,
  type ExpectedSelectiveCoverageProvenanceV1,
  type SelectiveCoverageEvidenceV1,
  type SelectiveCoverageGraphV1,
} from './manifest.ts';
import { verifySelectiveCoverage as verifyWithProvenance } from './verifier.ts';

const id = (name: string) => `0x1111111111111111111111111111111111111111/${name}`;
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function snapshot(name: string, wave: 'selected' | 'final'): GraphSnapshotExpectationV1 {
  const offset = wave === 'selected' ? 1 : 2;
  return {
    vm: {
      headDigest: hash(`${name}:${wave}:vm:head`),
      inventoryDigest: hash(`${name}:${wave}:vm:inventory`),
      assetCount: offset,
      dataTripleCount: 100 * offset,
    },
    swm: {
      headDigest: hash(`${name}:${wave}:swm:head`),
      inventoryDigest: hash(`${name}:${wave}:swm:inventory`),
      assetCount: offset,
      dataTripleCount: 80 * offset,
    },
  };
}

const graphs: readonly SelectiveCoverageGraphV1[] = [
  { name: '01-public-open-on-demand', accessPolicy: 0 as const, publishPolicy: 1 as const, edgePolicy: 'on-demand' as const },
  { name: '02-public-curated-always-on', accessPolicy: 0 as const, publishPolicy: 0 as const, edgePolicy: 'always-on' as const },
  { name: '03-public-open-unselected', accessPolicy: 0 as const, publishPolicy: 1 as const, edgePolicy: 'unselected' as const },
  { name: '04-private-open', accessPolicy: 1 as const, publishPolicy: 1 as const, edgePolicy: 'unselected' as const },
  { name: '05-private-curated', accessPolicy: 1 as const, publishPolicy: 0 as const, edgePolicy: 'unselected' as const },
].map((cell) => ({
  contextGraphId: id(cell.name),
  accessPolicy: cell.accessPolicy,
  publishPolicy: cell.publishPolicy,
  edgePolicy: cell.edgePolicy,
  selectedSnapshot: snapshot(cell.name, 'selected'),
  finalSnapshot: snapshot(cell.name, 'final'),
}));

const corpus = createSelectiveCoverageCorpus({
  networkId: 'otp:20430',
  coreAutomaticBatchSize: 2,
  coreCoverageRoundLimit: 2,
  graphs,
});

const PROVENANCE = Object.freeze({
  networkId: corpus.networkId,
  testedHeadCommit: 'a'.repeat(40),
  runtimeManifestDigest: hash('runtime-manifest'),
  publisherPeerId: 'publisher-peer',
  edgePeerId: 'edge-peer',
  corePeerId: 'core-peer',
});
const EXPECTED_PROVENANCE: ExpectedSelectiveCoverageProvenanceV1 = Object.freeze({
  ...PROVENANCE,
  corpusManifestDigest: corpus.manifestDigest,
});

function verifySelectiveCoverage(input: unknown) {
  return verifyWithProvenance(input, EXPECTED_PROVENANCE);
}

function absent(contextGraphId: string): GraphObservationV1 {
  const plane = {
    reportedComplete: false,
    headDigest: null,
    inventoryDigest: null,
    assetCount: 0,
    metadataTripleCount: 0,
    dataTripleCount: 0,
  } as const;
  return { contextGraphId, vm: { ...plane }, swm: { ...plane } };
}

function exact(
  graph: SelectiveCoverageGraphV1,
  expected: GraphSnapshotExpectationV1,
): GraphObservationV1 {
  const plane = (value: GraphSnapshotExpectationV1['vm']) => ({
    reportedComplete: true,
    headDigest: value.headDigest,
    inventoryDigest: value.inventoryDigest,
    assetCount: value.assetCount,
    metadataTripleCount: 5,
    dataTripleCount: value.dataTripleCount,
  });
  return {
    contextGraphId: graph.contextGraphId,
    vm: plane(expected.vm),
    swm: plane(expected.swm),
  };
}

function edgeAbsent(contextGraphId: string) {
  return {
    ...absent(contextGraphId),
    runtimeSyncMode: null,
    producingJobId: null,
  } as const;
}

function edgeExact(
  graph: SelectiveCoverageGraphV1,
  expected: GraphSnapshotExpectationV1,
  producingJobId: string,
) {
  return {
    ...exact(graph, expected),
    runtimeSyncMode: graph.edgePolicy as 'on-demand' | 'always-on',
    producingJobId,
  };
}

function journalReference(
  entry: Record<string, unknown>,
  processStartedAt: number,
) {
  const sequence = entry.sequence as number;
  return {
    sequence,
    snapshot: {
      schemaVersion: 1,
      processStartedAt,
      waveId: entry.waveId,
      capacity: 256,
      nextSequence: sequence + 1,
      droppedBeforeSequence: 0,
      entries: [entry],
    },
  };
}

function coreJournal(
  round: number,
  jobId: string,
  contextGraphIds: readonly string[],
  configuredBatchSize = 2,
) {
  return journalReference({
    kind: 'core-automatic-round',
    sequence: round + 1,
    waveId: 'core-wave',
    jobId,
    planningLane: 'publisher-peer',
    source: 'automatic-core-public',
    trigger: 'peer-sync',
    configuredBatchSize,
    effectiveBatchSize: configuredBatchSize,
    explicitSelectedContextGraphIds: [],
    explicitSelectedContextGraphCount: 0,
    automaticContextGraphIds: contextGraphIds,
    automaticContextGraphCount: contextGraphIds.length,
    evidenceTruncated: false,
    state: 'complete',
    startedAt: 20 + round,
    finishedAt: 21 + round,
    completions: contextGraphIds.map((contextGraphId) => ({
      jobId,
      contextGraphId,
      state: 'complete',
      verified: { metadata: true, durable: true, sharedMemory: true },
      finishedAt: 21 + round,
    })),
  }, 2);
}

function fixture(): SelectiveCoverageEvidenceV1 {
  return {
    schema: SELECTIVE_COVERAGE_EVIDENCE_SCHEMA,
    provenance: PROVENANCE,
    automaticJournalEvidence: {
      edgeProcess: { processStartedAt: 1, evidenceWaveId: 'edge-wave' },
      edgeReconciler: [journalReference({
        kind: 'edge-reconciler-job',
        sequence: 1,
        waveId: 'edge-wave',
        jobId: 'edge-auto-always-on',
        contextGraphId: graphs[1]!.contextGraphId,
        source: 'reconciler',
        trigger: 'periodic-reconciler',
        syncMode: 'always-on',
        rehydratedSelectionCount: 1,
        evidenceTruncated: false,
        state: 'complete',
        verified: { metadata: true, durable: true, sharedMemory: true },
        startedAt: 10,
        finishedAt: 11,
      }, 1)],
      coreProcess: { processStartedAt: 2, evidenceWaveId: 'core-wave' },
      coreRounds: [
        coreJournal(0, 'core-auto-0', [graphs[0]!.contextGraphId, graphs[1]!.contextGraphId]),
        coreJournal(1, 'core-auto-1', [graphs[2]!.contextGraphId]),
      ],
    },
    corpus,
    publisher: {
      selected: corpus.graphs.map((graph) => exact(graph, graph.selectedSnapshot)),
      final: corpus.graphs.map((graph) => exact(graph, graph.finalSnapshot)),
    },
    edge: {
      beforeSelection: corpus.graphs.map((graph) => edgeAbsent(graph.contextGraphId)),
      afterSelection: corpus.graphs.map((graph) =>
        graph.accessPolicy === 0 && graph.edgePolicy !== 'unselected'
          ? edgeExact(
              graph,
              graph.selectedSnapshot,
              graph.edgePolicy === 'on-demand'
                ? 'edge-select-on-demand'
                : 'edge-select-always-on',
            )
          : edgeAbsent(graph.contextGraphId)),
      afterRestart: corpus.graphs.map((graph) => {
        if (graph.accessPolicy !== 0 || graph.edgePolicy === 'unselected') {
          return edgeAbsent(graph.contextGraphId);
        }
        const alwaysOn = graph.edgePolicy === 'always-on';
        const observed = edgeExact(
          graph,
          alwaysOn ? graph.finalSnapshot : graph.selectedSnapshot,
          alwaysOn ? 'edge-auto-always-on' : 'edge-select-on-demand',
        );
        return alwaysOn ? observed : { ...observed, runtimeSyncMode: null };
      }),
      afterSecondOnDemand: corpus.graphs.map((graph) =>
        graph.accessPolicy === 0 && graph.edgePolicy !== 'unselected'
          ? edgeExact(
              graph,
              graph.finalSnapshot,
              graph.edgePolicy === 'on-demand'
                ? 'edge-second-on-demand'
                : 'edge-auto-always-on',
            )
          : edgeAbsent(graph.contextGraphId)),
      operations: [
        {
          sequence: 0,
          phase: 'selection',
          source: 'user',
          syncMode: 'on-demand',
          contextGraphId: graphs[0]!.contextGraphId,
          jobId: 'edge-select-on-demand',
          completedWave: 'selected',
          completedSnapshot: graphs[0]!.selectedSnapshot,
        },
        {
          sequence: 1,
          phase: 'selection',
          source: 'user',
          syncMode: 'always-on',
          contextGraphId: graphs[1]!.contextGraphId,
          jobId: 'edge-select-always-on',
          completedWave: 'selected',
          completedSnapshot: graphs[1]!.selectedSnapshot,
        },
        {
          sequence: 2,
          phase: 'post-restart-auto',
          source: 'reconciler',
          syncMode: 'always-on',
          contextGraphId: graphs[1]!.contextGraphId,
          jobId: 'edge-auto-always-on',
          completedWave: 'final',
          completedSnapshot: graphs[1]!.finalSnapshot,
        },
        {
          sequence: 3,
          phase: 'post-restart-explicit',
          source: 'user',
          syncMode: 'on-demand',
          contextGraphId: graphs[0]!.contextGraphId,
          jobId: 'edge-second-on-demand',
          completedWave: 'final',
          completedSnapshot: graphs[0]!.finalSnapshot,
        },
      ],
    },
    core: {
      automaticBatchSize: 2,
      rounds: [
        {
          round: 0,
          jobId: 'core-auto-0',
          planningLane: 'publisher-peer',
          source: 'automatic-core-public',
          configuredBatchSize: 2,
          explicitSelectedContextGraphIds: [],
          contextGraphIds: [graphs[0]!.contextGraphId, graphs[1]!.contextGraphId],
          completions: [graphs[0]!, graphs[1]!].map((graph) => ({
            contextGraphId: graph.contextGraphId,
            completedWave: 'final' as const,
            completedSnapshot: graph.finalSnapshot,
          })),
        },
        {
          round: 1,
          jobId: 'core-auto-1',
          planningLane: 'publisher-peer',
          source: 'automatic-core-public',
          configuredBatchSize: 2,
          explicitSelectedContextGraphIds: [],
          contextGraphIds: [graphs[2]!.contextGraphId],
          completions: [{
            contextGraphId: graphs[2]!.contextGraphId,
            completedWave: 'final',
            completedSnapshot: graphs[2]!.finalSnapshot,
          }],
        },
      ],
      final: corpus.graphs.map((graph, index) => ({
        ...(graph.accessPolicy === 0
          ? exact(graph, graph.finalSnapshot)
          : absent(graph.contextGraphId)),
        automaticJobIds: graph.accessPolicy === 0
          ? [index < 2 ? 'core-auto-0' : 'core-auto-1']
          : [],
      })),
    },
  };
}

function clone(): any {
  return JSON.parse(JSON.stringify(fixture()));
}

test('accepts exact Edge selection and bounded Core public convergence evidence', () => {
  const verdict = verifySelectiveCoverage(fixture());
  assert.equal(verdict.pass, true);
  assert.deepEqual(verdict.rejectReasons, []);
  assert.deepEqual(verdict.missingCoreContextGraphIds, []);
  for (const [name, value] of Object.entries(verdict.checks)) {
    assert.equal(value, true, name);
  }
});

test('published artifact must retain matching automatic journal proof', () => {
  const missing = clone();
  delete missing.automaticJournalEvidence;
  assert.equal(verifySelectiveCoverage(missing).checks.schemaWellFormed, false);

  const relabelled = clone();
  relabelled.edge.operations[2].jobId = 'synthetic-reconciler-job';
  relabelled.edge.afterRestart[1].producingJobId = 'synthetic-reconciler-job';
  relabelled.edge.afterSecondOnDemand[1].producingJobId = 'synthetic-reconciler-job';
  const edgeVerdict = verifySelectiveCoverage(relabelled);
  assert.equal(edgeVerdict.checks.edgeOperationProvenance, false);

  const syntheticCore = clone();
  syntheticCore.core.rounds[0].jobId = 'synthetic-core-round';
  syntheticCore.core.final[0].automaticJobIds = ['synthetic-core-round'];
  syntheticCore.core.final[1].automaticJobIds = ['synthetic-core-round'];
  const coreVerdict = verifySelectiveCoverage(syntheticCore);
  assert.equal(coreVerdict.checks.coreAutomaticProvenance, false);
});

test('supports 33 public graphs through multiple bounded journal rounds', () => {
  const extra = Array.from({ length: 30 }, (_, index): SelectiveCoverageGraphV1 => {
    const name = `03-public-unselected-${String(index).padStart(2, '0')}`;
    return {
      contextGraphId: id(name),
      accessPolicy: 0,
      publishPolicy: 1,
      edgePolicy: 'unselected',
      selectedSnapshot: snapshot(name, 'selected'),
      finalSnapshot: snapshot(name, 'final'),
    };
  });
  const largeCorpus = createSelectiveCoverageCorpus({
    networkId: corpus.networkId,
    coreAutomaticBatchSize: 32,
    coreCoverageRoundLimit: 2,
    graphs: [...graphs, ...extra],
  });
  const evidence = clone();
  evidence.corpus = largeCorpus;
  evidence.publisher.selected = largeCorpus.graphs.map((graph) =>
    exact(graph, graph.selectedSnapshot));
  evidence.publisher.final = largeCorpus.graphs.map((graph) => exact(graph, graph.finalSnapshot));
  evidence.edge.beforeSelection = largeCorpus.graphs.map((graph) => edgeAbsent(graph.contextGraphId));
  evidence.edge.afterSelection = largeCorpus.graphs.map((graph) => {
    if (graph.contextGraphId === graphs[0]!.contextGraphId) {
      return edgeExact(graph, graph.selectedSnapshot, 'edge-select-on-demand');
    }
    if (graph.contextGraphId === graphs[1]!.contextGraphId) {
      return edgeExact(graph, graph.selectedSnapshot, 'edge-select-always-on');
    }
    return edgeAbsent(graph.contextGraphId);
  });
  evidence.edge.afterRestart = largeCorpus.graphs.map((graph) => {
    if (graph.contextGraphId === graphs[0]!.contextGraphId) {
      return {
        ...edgeExact(graph, graph.selectedSnapshot, 'edge-select-on-demand'),
        runtimeSyncMode: null,
      };
    }
    if (graph.contextGraphId === graphs[1]!.contextGraphId) {
      return edgeExact(graph, graph.finalSnapshot, 'edge-auto-always-on');
    }
    return edgeAbsent(graph.contextGraphId);
  });
  evidence.edge.afterSecondOnDemand = largeCorpus.graphs.map((graph) => {
    if (graph.contextGraphId === graphs[0]!.contextGraphId) {
      return edgeExact(graph, graph.finalSnapshot, 'edge-second-on-demand');
    }
    if (graph.contextGraphId === graphs[1]!.contextGraphId) {
      return edgeExact(graph, graph.finalSnapshot, 'edge-auto-always-on');
    }
    return edgeAbsent(graph.contextGraphId);
  });
  const publicGraphs = largeCorpus.graphs.filter((graph) => graph.accessPolicy === 0);
  const chunks = [publicGraphs.slice(0, 32), publicGraphs.slice(32)];
  evidence.core.automaticBatchSize = 32;
  evidence.core.rounds = chunks.map((chunk, round) => ({
    round,
    jobId: `core-large-${round}`,
    planningLane: 'publisher-peer',
    source: 'automatic-core-public',
    configuredBatchSize: 32,
    explicitSelectedContextGraphIds: [],
    contextGraphIds: chunk.map((graph) => graph.contextGraphId),
    completions: chunk.map((graph) => ({
      contextGraphId: graph.contextGraphId,
      completedWave: 'final',
      completedSnapshot: graph.finalSnapshot,
    })),
  }));
  evidence.automaticJournalEvidence.coreRounds = chunks.map((chunk, round) =>
    coreJournal(
      round,
      `core-large-${round}`,
      chunk.map((graph) => graph.contextGraphId),
      32,
    ));
  const jobByGraph = new Map(chunks.flatMap((chunk, round) =>
    chunk.map((graph) => [graph.contextGraphId, `core-large-${round}`] as const)));
  evidence.core.final = largeCorpus.graphs.map((graph) => ({
    ...(graph.accessPolicy === 0 ? exact(graph, graph.finalSnapshot) : absent(graph.contextGraphId)),
    automaticJobIds: graph.accessPolicy === 0 ? [jobByGraph.get(graph.contextGraphId)!] : [],
  }));

  const verdict = verifyWithProvenance(evidence, {
    ...EXPECTED_PROVENANCE,
    corpusManifestDigest: largeCorpus.manifestDigest,
  });
  assert.equal(verdict.pass, true, verdict.rejectReasons.join('; '));
});

test('rejects a batch that cannot fit one untruncated journal entry', () => {
  assert.throws(() => createSelectiveCoverageCorpus({
    networkId: corpus.networkId,
    coreAutomaticBatchSize: 33,
    coreCoverageRoundLimit: 1,
    graphs,
  }), /exceeds one bounded journal entry/);
});

test('scheduled Core IDs require exact same-round terminal completions', () => {
  const evidence = clone();
  evidence.core.rounds[0].completions.pop();
  evidence.automaticJournalEvidence.coreRounds[0].snapshot.entries[0].completions.pop();

  const deferred = graphs[1]!;
  evidence.core.rounds[1].contextGraphIds.unshift(deferred.contextGraphId);
  evidence.core.rounds[1].completions.unshift({
    contextGraphId: deferred.contextGraphId,
    completedWave: 'final',
    completedSnapshot: deferred.finalSnapshot,
  });
  const later = evidence.automaticJournalEvidence.coreRounds[1].snapshot.entries[0];
  later.automaticContextGraphIds.unshift(deferred.contextGraphId);
  later.automaticContextGraphCount += 1;
  later.completions.unshift({
    jobId: 'core-auto-1',
    contextGraphId: deferred.contextGraphId,
    state: 'complete',
    verified: { metadata: true, durable: true, sharedMemory: true },
    finishedAt: 22,
  });
  evidence.core.final[1].automaticJobIds = ['core-auto-1'];

  const verdict = verifySelectiveCoverage(evidence);
  assert.equal(verdict.checks.coreAutomaticProvenance, false);
  assert.equal(verdict.pass, false);
});

test('corpus and evidence serialization is deterministic', () => {
  assert.equal(
    canonicalJson({ z: { second: 2, first: 1 }, a: ['@', ':', '/'] }),
    canonicalJson({ a: ['@', ':', '/'], z: { first: 1, second: 2 } }),
  );
  const rebuilt = createSelectiveCoverageCorpus({
    networkId: corpus.networkId,
    coreAutomaticBatchSize: corpus.coreAutomaticBatchSize,
    coreCoverageRoundLimit: corpus.coreCoverageRoundLimit,
    graphs: [...graphs].reverse(),
  });
  assert.equal(rebuilt.manifestDigest, corpus.manifestDigest);
  assert.equal(canonicalJson(rebuilt), canonicalJson(corpus));
});

test('corpus, runtime, network, and peer roles require an external trust anchor', () => {
  const substituted = clone();
  substituted.corpus.graphs[0].finalSnapshot.vm.assetCount += 1;
  substituted.corpus = createSelectiveCoverageCorpus({
    networkId: substituted.corpus.networkId,
    coreAutomaticBatchSize: substituted.corpus.coreAutomaticBatchSize,
    coreCoverageRoundLimit: substituted.corpus.coreCoverageRoundLimit,
    graphs: substituted.corpus.graphs,
  });
  let verdict = verifyWithProvenance(substituted, EXPECTED_PROVENANCE);
  assert.equal(verdict.checks.corpusDigestMatches, true);
  assert.equal(verdict.checks.provenanceMatches, false);

  const wrongRole = clone();
  wrongRole.provenance.corePeerId = 'manual-receiver-peer';
  verdict = verifyWithProvenance(wrongRole, EXPECTED_PROVENANCE);
  assert.equal(verdict.checks.provenanceMatches, false);
});

test('every public graph must have a real larger second publication wave', () => {
  const noOp = clone();
  const graph = noOp.corpus.graphs[2];
  graph.finalSnapshot = structuredClone(graph.selectedSnapshot);
  noOp.corpus = createSelectiveCoverageCorpus({
    networkId: noOp.corpus.networkId,
    coreAutomaticBatchSize: noOp.corpus.coreAutomaticBatchSize,
    coreCoverageRoundLimit: noOp.corpus.coreCoverageRoundLimit,
    graphs: noOp.corpus.graphs,
  });
  noOp.publisher.final[2] = exact(graph, graph.selectedSnapshot);
  noOp.core.final[2] = {
    ...exact(graph, graph.selectedSnapshot),
    automaticJobIds: ['core-auto-1'],
  };
  noOp.core.rounds[1].completions[0].completedSnapshot = graph.selectedSnapshot;
  const verdict = verifyWithProvenance(noOp, {
    ...EXPECTED_PROVENANCE,
    corpusManifestDigest: noOp.corpus.manifestDigest,
  });
  assert.equal(verdict.checks.publisherSnapshotsExact, true);
  assert.equal(verdict.checks.coreFinalPublicExact, true);
  assert.equal(verdict.checks.coreAutomaticProvenance, true);
  assert.equal(verdict.checks.publicSecondWaveAdvances, false);
});

test('metadata-only responses cannot claim Edge or Core completion', () => {
  const edgeMetadataOnly = clone();
  edgeMetadataOnly.edge.afterSelection[0].vm.reportedComplete = true;
  edgeMetadataOnly.edge.afterSelection[0].vm.assetCount = 0;
  edgeMetadataOnly.edge.afterSelection[0].vm.dataTripleCount = 0;
  let verdict = verifySelectiveCoverage(edgeMetadataOnly);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.checks.edgeSelectedSnapshotsExact, false);
  assert.equal(verdict.checks.noMetadataOnlyCompletion, false);

  const coreMetadataOnly = clone();
  coreMetadataOnly.core.final[2].swm.reportedComplete = true;
  coreMetadataOnly.core.final[2].swm.assetCount = 0;
  coreMetadataOnly.core.final[2].swm.dataTripleCount = 0;
  verdict = verifySelectiveCoverage(coreMetadataOnly);
  assert.equal(verdict.checks.coreFinalPublicExact, false);
  assert.equal(verdict.checks.noMetadataOnlyCompletion, false);
});

test('private graphs are excluded from Core rounds and final payload', () => {
  const scheduledPrivate = clone();
  scheduledPrivate.core.rounds[1].contextGraphIds.push(graphs[3]!.contextGraphId);
  let verdict = verifySelectiveCoverage(scheduledPrivate);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.checks.coreRoundsPublicOnly, false);
  assert.equal(verdict.checks.corePrivateExcluded, false);

  const acquiredPrivate = clone();
  acquiredPrivate.core.final[3] = {
    ...exact(graphs[3]!, graphs[3]!.finalSnapshot),
    automaticJobIds: ['core-auto-1'],
  };
  verdict = verifySelectiveCoverage(acquiredPrivate);
  assert.equal(verdict.checks.corePrivateExcluded, false);
});

test('automatic Core batch overflow fails even when final convergence is exact', () => {
  const raw = clone();
  raw.core.rounds[0].contextGraphIds.push(graphs[2]!.contextGraphId);
  const verdict = verifySelectiveCoverage(raw);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.checks.coreBatchWithinBound, false);
  assert.equal(verdict.checks.coreFinalPublicExact, true);
});

test('VM or SWM digest mismatch fails exact convergence', () => {
  const edgeMismatch = clone();
  edgeMismatch.edge.afterRestart[1].swm.inventoryDigest = hash('wrong-edge-swm');
  let verdict = verifySelectiveCoverage(edgeMismatch);
  assert.equal(verdict.checks.edgeAlwaysOnRefreshesAfterRestart, false);
  assert.equal(verdict.checks.noMetadataOnlyCompletion, false);

  const coreMismatch = clone();
  coreMismatch.core.final[2].vm.headDigest = hash('wrong-core-vm');
  verdict = verifySelectiveCoverage(coreMismatch);
  assert.equal(verdict.checks.coreFinalPublicExact, false);
});

test('on-demand does not refresh automatically while always-on must refresh after restart', () => {
  const onDemandAdvanced = clone();
  onDemandAdvanced.edge.afterRestart[0] = edgeExact(
    graphs[0]!,
    graphs[0]!.finalSnapshot,
    'edge-select-on-demand',
  );
  assert.equal(
    verifySelectiveCoverage(onDemandAdvanced).checks.edgeOnDemandRemainsPointInTime,
    false,
  );

  const incorrectlyPersistedOnDemand = clone();
  incorrectlyPersistedOnDemand.edge.afterRestart[0].runtimeSyncMode = 'on-demand';
  assert.equal(
    verifySelectiveCoverage(incorrectlyPersistedOnDemand).checks.edgeOnDemandRemainsPointInTime,
    false,
  );

  const alwaysOnStale = clone();
  alwaysOnStale.edge.afterRestart[1] = edgeExact(
    graphs[1]!,
    graphs[1]!.selectedSnapshot,
    'edge-auto-always-on',
  );
  assert.equal(
    verifySelectiveCoverage(alwaysOnStale).checks.edgeAlwaysOnRefreshesAfterRestart,
    false,
  );

  const manualAlwaysOn = clone();
  manualAlwaysOn.edge.operations[2].source = 'user';
  assert.equal(
    verifySelectiveCoverage(manualAlwaysOn).checks.edgeOperationProvenance,
    false,
  );

  const hiddenOnDemandRefresh = clone();
  hiddenOnDemandRefresh.edge.operations[2] = {
    ...hiddenOnDemandRefresh.edge.operations[2],
    contextGraphId: graphs[0]!.contextGraphId,
    syncMode: 'on-demand',
  };
  assert.equal(
    verifySelectiveCoverage(hiddenOnDemandRefresh).checks.edgeOperationProvenance,
    false,
  );
});

test('unselected Edge public payload and missing Core scheduling fail independently', () => {
  const edgeLeak = clone();
  edgeLeak.edge.afterRestart[2] = {
    ...exact(graphs[2]!, graphs[2]!.finalSnapshot),
    runtimeSyncMode: null,
    producingJobId: null,
  };
  assert.equal(verifySelectiveCoverage(edgeLeak).checks.edgeUnselectedExcluded, false);

  const missingCore = clone();
  missingCore.core.rounds.splice(1, 1);
  const verdict = verifySelectiveCoverage(missingCore);
  assert.equal(verdict.checks.coreEveryPublicScheduled, false);
  assert.deepEqual(verdict.missingCoreContextGraphIds, [graphs[2]!.contextGraphId]);

  const leakedSubscription = clone();
  leakedSubscription.edge.afterRestart[2].runtimeSyncMode = 'always-on';
  assert.equal(
    verifySelectiveCoverage(leakedSubscription).checks.edgeUnselectedExcluded,
    false,
  );

  const leakedPrivateSubscription = clone();
  leakedPrivateSubscription.edge.afterRestart[3].runtimeSyncMode = 'always-on';
  assert.equal(
    verifySelectiveCoverage(leakedPrivateSubscription).checks.edgePrivateExcluded,
    false,
  );
});

test('Core convergence must bind to automatic jobs with no explicit selections', () => {
  const explicit = clone();
  explicit.core.rounds[0].explicitSelectedContextGraphIds = [graphs[0]!.contextGraphId];
  let verdict = verifySelectiveCoverage(explicit);
  assert.equal(verdict.checks.coreAutomaticProvenance, false);

  const wrongJob = clone();
  wrongJob.core.final[2].automaticJobIds = ['core-auto-0'];
  verdict = verifySelectiveCoverage(wrongJob);
  assert.equal(verdict.checks.coreAutomaticProvenance, false);
  assert.equal(verdict.checks.coreFinalPublicExact, true);

  const staleCompletion = clone();
  staleCompletion.core.rounds[1].completions[0].completedSnapshot =
    graphs[2]!.selectedSnapshot;
  verdict = verifySelectiveCoverage(staleCompletion);
  assert.equal(verdict.checks.coreAutomaticProvenance, false);
  assert.equal(verdict.checks.coreFinalPublicExact, true);
});

test('Edge checkpoints bind their exact state to the operation that produced it', () => {
  const wrongSelectionJob = clone();
  wrongSelectionJob.edge.afterSelection[0].producingJobId = 'edge-auto-always-on';
  let verdict = verifySelectiveCoverage(wrongSelectionJob);
  assert.equal(verdict.checks.edgeOperationProvenance, true);
  assert.equal(verdict.checks.edgeSelectedSnapshotsExact, false);

  const falseAutomaticCompletion = clone();
  falseAutomaticCompletion.edge.operations[2].completedSnapshot =
    graphs[1]!.selectedSnapshot;
  verdict = verifySelectiveCoverage(falseAutomaticCompletion);
  assert.equal(verdict.checks.edgeAlwaysOnRefreshesAfterRestart, true);
  assert.equal(verdict.checks.edgeOperationProvenance, false);
});

test('late eventual coverage fails the deterministic first-admission window', () => {
  const starved = clone();
  starved.core.rounds = [
    {
      ...starved.core.rounds[0],
      contextGraphIds: [graphs[0]!.contextGraphId],
      completions: [starved.core.rounds[0].completions[0]],
    },
    {
      ...starved.core.rounds[1],
      contextGraphIds: [graphs[0]!.contextGraphId],
      completions: [{
        contextGraphId: graphs[0]!.contextGraphId,
        completedWave: 'final',
        completedSnapshot: graphs[0]!.finalSnapshot,
      }],
    },
    {
      ...starved.core.rounds[1],
      round: 2,
      jobId: 'core-auto-2',
      contextGraphIds: [graphs[1]!.contextGraphId, graphs[2]!.contextGraphId],
      completions: [graphs[1]!, graphs[2]!].map((graph) => ({
        contextGraphId: graph.contextGraphId,
        completedWave: 'final',
        completedSnapshot: graph.finalSnapshot,
      })),
    },
  ];
  starved.core.final[0].automaticJobIds = ['core-auto-0'];
  starved.core.final[1].automaticJobIds = ['core-auto-2'];
  starved.core.final[2].automaticJobIds = ['core-auto-2'];
  const verdict = verifySelectiveCoverage(starved);
  assert.equal(verdict.checks.coreEveryPublicScheduled, true);
  assert.equal(verdict.checks.coreCoverageWithinWindow, false);
  assert.equal(verdict.checks.coreBatchWithinBound, true);
});

test('unknown keys, duplicate rows, and stale manifest digest fail closed', () => {
  const extra = clone();
  extra.edge.afterSelection[0].unverified = true;
  assert.equal(verifySelectiveCoverage(extra).checks.schemaWellFormed, false);

  const duplicate = clone();
  duplicate.edge.afterRestart[1].contextGraphId = duplicate.edge.afterRestart[0].contextGraphId;
  assert.equal(verifySelectiveCoverage(duplicate).checks.corpusCanonicalOrder, false);

  const staleDigest = clone();
  staleDigest.corpus.graphs[0].finalSnapshot.vm.assetCount += 1;
  assert.equal(verifySelectiveCoverage(staleDigest).checks.corpusDigestMatches, false);
});

test('non-JSON object topology fails closed without throwing', () => {
  const hidden = clone();
  Object.defineProperty(hidden.core, 'hidden', { value: true, enumerable: false });
  assert.equal(verifySelectiveCoverage(hidden).checks.schemaWellFormed, false);

  const extendedArray = clone();
  extendedArray.core.rounds.unverified = true;
  assert.equal(verifySelectiveCoverage(extendedArray).checks.schemaWellFormed, false);

  const proxy = Proxy.revocable(fixture(), {});
  proxy.revoke();
  assert.doesNotThrow(() => verifySelectiveCoverage(proxy.proxy));
  assert.equal(verifySelectiveCoverage(proxy.proxy).checks.schemaWellFormed, false);
});

test('canonical JSON rejects ambiguous or lossy JavaScript values', () => {
  const sparse = new Array(1);
  const extended: unknown[] & { extra?: boolean } = [1];
  extended.extra = true;
  const symbolKeyed = { visible: true } as Record<PropertyKey, unknown>;
  symbolKeyed[Symbol('hidden')] = true;
  const hidden = { visible: true };
  Object.defineProperty(hidden, 'hidden', { value: true, enumerable: false });
  const accessor = {};
  Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 1 });
  const shared = { value: true };
  for (const value of [
    sparse,
    extended,
    symbolKeyed,
    hidden,
    accessor,
    [shared, shared],
    Number.MAX_SAFE_INTEGER + 1,
    -0,
  ]) {
    assert.throws(() => canonicalJson(value));
  }
});
