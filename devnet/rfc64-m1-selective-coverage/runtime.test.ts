import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  canonicalJson,
  createSelectiveCoverageCorpus,
  type CoreAutomaticRoundV1,
  type CoreFinalObservationV1,
  type EdgeGraphObservationV1,
  type EdgeSyncOperationV1,
  type ExpectedSelectiveCoverageProvenanceV1,
  type GraphObservationV1,
  type GraphSnapshotExpectationV1,
  type SelectiveCoverageGraphV1,
} from './manifest.ts';
import {
  collectSelectiveCoverageEvidenceV1,
  SELECTIVE_COVERAGE_RUNTIME_PROTOCOL,
  type SelectiveCoverageEdgeRestartReceiptV1,
  type SelectiveCoverageRuntimeReadyV1,
  type SelectiveCoverageRuntimeRole,
  type SelectiveCoverageRuntimeV1,
} from './runtime.ts';
import type { SyncCoverageJournalReferenceV1 } from './sync-coverage-journal.ts';
import { runSelectiveCoverageLiveV1 } from './live-runner.ts';

const digest = (value: string) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
const graphId = (name: string) => `0x1111111111111111111111111111111111111111/${name}`;

function snapshot(name: string, wave: 'selected' | 'final'): GraphSnapshotExpectationV1 {
  const count = wave === 'selected' ? 1 : 2;
  return {
    vm: {
      headDigest: digest(`${name}:${wave}:vm:head`),
      inventoryDigest: digest(`${name}:${wave}:vm:inventory`),
      assetCount: count,
      dataTripleCount: count * 20,
    },
    swm: {
      headDigest: digest(`${name}:${wave}:swm:head`),
      inventoryDigest: digest(`${name}:${wave}:swm:inventory`),
      assetCount: count,
      dataTripleCount: count * 15,
    },
  };
}

const graphInputs = [
  ['01-public-open-on-demand', 0, 1, 'on-demand'],
  ['02-public-curated-always-on', 0, 0, 'always-on'],
  ['03-public-open-unselected', 0, 1, 'unselected'],
  ['04-private-open', 1, 1, 'unselected'],
  ['05-private-curated', 1, 0, 'unselected'],
] as const;
const graphs: readonly SelectiveCoverageGraphV1[] = graphInputs.map((row) => ({
  contextGraphId: graphId(row[0]),
  accessPolicy: row[1],
  publishPolicy: row[2],
  edgePolicy: row[3],
  selectedSnapshot: snapshot(row[0], 'selected'),
  finalSnapshot: snapshot(row[0], 'final'),
}));
const corpus = createSelectiveCoverageCorpus({
  networkId: 'otp:20430',
  coreAutomaticBatchSize: 2,
  coreCoverageRoundLimit: 2,
  graphs,
});
const expected: ExpectedSelectiveCoverageProvenanceV1 = {
  networkId: corpus.networkId,
  testedHeadCommit: 'a'.repeat(40),
  runtimeManifestDigest: digest('runtime'),
  corpusManifestDigest: corpus.manifestDigest,
  publisherPeerId: 'publisher-peer',
  edgePeerId: 'edge-peer',
  corePeerId: 'core-peer',
};

function exactObservation(
  graph: SelectiveCoverageGraphV1,
  expectedSnapshot: GraphSnapshotExpectationV1,
): GraphObservationV1 {
  const plane = (expectedPlane: GraphSnapshotExpectationV1['vm']) => ({
    reportedComplete: true,
    headDigest: expectedPlane.headDigest,
    inventoryDigest: expectedPlane.inventoryDigest,
    assetCount: expectedPlane.assetCount,
    metadataTripleCount: 4,
    dataTripleCount: expectedPlane.dataTripleCount,
  });
  return {
    contextGraphId: graph.contextGraphId,
    vm: plane(expectedSnapshot.vm),
    swm: plane(expectedSnapshot.swm),
  };
}

function absentObservation(contextGraphId: string): GraphObservationV1 {
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

class ScriptedRuntime implements SelectiveCoverageRuntimeV1 {
  readonly calls: string[] = [];
  readonly stopped: SelectiveCoverageRuntimeRole[] = [];
  readyMutation?: (ready: SelectiveCoverageRuntimeReadyV1) => SelectiveCoverageRuntimeReadyV1;
  selectedPublisherMutation?: (rows: GraphObservationV1[]) => GraphObservationV1[];
  operationMutation?: (
    operation: Omit<EdgeSyncOperationV1, 'sequence'>,
  ) => Omit<EdgeSyncOperationV1, 'sequence'>;
  coreRoundMutation?: (round: CoreAutomaticRoundV1) => CoreAutomaticRoundV1;
  edgeJournalMutation?: (
    journal: SyncCoverageJournalReferenceV1,
  ) => SyncCoverageJournalReferenceV1;
  coreJournalMutation?: (
    journal: SyncCoverageJournalReferenceV1,
  ) => SyncCoverageJournalReferenceV1;
  restartReceiptMutation?: (
    receipt: SelectiveCoverageEdgeRestartReceiptV1,
  ) => SelectiveCoverageEdgeRestartReceiptV1;

  async start(role: SelectiveCoverageRuntimeRole): Promise<SelectiveCoverageRuntimeReadyV1> {
    this.calls.push(`start:${role}`);
    const pid = role === 'publisher' ? 101 : role === 'edge' ? 102 : 104;
    const peerId = role === 'publisher'
      ? expected.publisherPeerId
      : role === 'edge'
        ? expected.edgePeerId
        : expected.corePeerId;
    const ready: SelectiveCoverageRuntimeReadyV1 = {
      protocol: SELECTIVE_COVERAGE_RUNTIME_PROTOCOL,
      role,
      pid,
      peerId,
      networkId: expected.networkId,
      testedHeadCommit: expected.testedHeadCommit,
      runtimeManifestDigest: expected.runtimeManifestDigest,
      processStartedAt: role === 'edge' ? 0 : 1,
      processInstanceId: `${role}-instance-before`,
      dataDirectoryIdentity: `${role}-data`,
      evidenceWaveId: role === 'core' ? 'core-wave' : `${role}-wave-before`,
    };
    return this.readyMutation?.(ready) ?? ready;
  }

  async stop(role: SelectiveCoverageRuntimeRole): Promise<void> {
    this.calls.push(`stop:${role}`);
    this.stopped.push(role);
  }

  async publishWave(wave: 'selected' | 'final'): Promise<readonly GraphObservationV1[]> {
    this.calls.push(`publish:${wave}`);
    const rows = corpus.graphs.map((graph) =>
      exactObservation(graph, wave === 'selected' ? graph.selectedSnapshot : graph.finalSnapshot));
    return wave === 'selected' ? this.selectedPublisherMutation?.(rows) ?? rows : rows;
  }

  async observeEdge(
    checkpoint: 'before-selection' | 'after-selection' | 'after-restart'
      | 'after-second-on-demand',
  ): Promise<readonly EdgeGraphObservationV1[]> {
    this.calls.push(`observe-edge:${checkpoint}`);
    return corpus.graphs.map((graph): EdgeGraphObservationV1 => {
      if (checkpoint === 'before-selection'
        || graph.accessPolicy !== 0
        || graph.edgePolicy === 'unselected') {
        return {
          ...absentObservation(graph.contextGraphId),
          runtimeSyncMode: null,
          producingJobId: null,
        };
      }
      const alwaysOn = graph.edgePolicy === 'always-on';
      const afterFinal = checkpoint === 'after-second-on-demand'
        || (checkpoint === 'after-restart' && alwaysOn);
      const selectionJob = alwaysOn ? 'edge-select-always-on' : 'edge-select-on-demand';
      const producingJobId = afterFinal
        ? (alwaysOn ? 'edge-auto-always-on' : 'edge-second-on-demand')
        : selectionJob;
      return {
        ...exactObservation(
          graph,
          afterFinal ? graph.finalSnapshot : graph.selectedSnapshot,
        ),
        runtimeSyncMode: checkpoint === 'after-restart' && !alwaysOn
          ? null
          : graph.edgePolicy,
        producingJobId,
      };
    });
  }

  async synchronizeEdge(input: {
    readonly contextGraphId: string;
    readonly phase: 'selection' | 'post-restart-explicit';
    readonly syncMode: 'always-on' | 'on-demand';
    readonly wave: EdgeSyncOperationV1['completedWave'];
  }): Promise<{
    readonly operation: Omit<EdgeSyncOperationV1, 'sequence'>;
    readonly journal?: SyncCoverageJournalReferenceV1;
  }> {
    this.calls.push(`edge-sync:${input.phase}:${input.contextGraphId}`);
    const graph = corpus.graphs.find((candidate) =>
      candidate.contextGraphId === input.contextGraphId)!;
    const jobId = input.phase === 'post-restart-explicit'
        ? 'edge-second-on-demand'
        : input.syncMode === 'always-on'
          ? 'edge-select-always-on'
          : 'edge-select-on-demand';
    const operation: Omit<EdgeSyncOperationV1, 'sequence'> = {
      phase: input.phase,
      source: 'user',
      syncMode: input.syncMode,
      contextGraphId: input.contextGraphId,
      jobId,
      completedWave: input.wave,
      completedSnapshot: input.wave === 'selected'
        ? graph.selectedSnapshot
        : graph.finalSnapshot,
    };
    const result = this.operationMutation?.(operation) ?? operation;
    return { operation: result };
  }

  async restartEdge(): Promise<SelectiveCoverageEdgeRestartReceiptV1> {
    this.calls.push('restart:edge');
    const ready: SelectiveCoverageRuntimeReadyV1 = {
      protocol: SELECTIVE_COVERAGE_RUNTIME_PROTOCOL,
      role: 'edge',
      pid: 103,
      peerId: expected.edgePeerId,
      networkId: expected.networkId,
      testedHeadCommit: expected.testedHeadCommit,
      runtimeManifestDigest: expected.runtimeManifestDigest,
      processStartedAt: 1,
      processInstanceId: 'edge-instance-after',
      dataDirectoryIdentity: 'edge-data',
      evidenceWaveId: 'edge-wave',
    };
    const receipt: SelectiveCoverageEdgeRestartReceiptV1 = {
      previous: {
        pid: 102,
        processInstanceId: 'edge-instance-before',
        exitedAt: 1,
      },
      current: this.readyMutation?.(ready) ?? ready,
    };
    return this.restartReceiptMutation?.(receipt) ?? receipt;
  }

  async waitForEdgeReconciler(input: {
    readonly contextGraphId: string;
  }): Promise<{
    readonly operation: Omit<EdgeSyncOperationV1, 'sequence'>;
    readonly journal: SyncCoverageJournalReferenceV1;
  }> {
    this.calls.push(`edge-sync:post-restart-auto:${input.contextGraphId}`);
    const graph = corpus.graphs.find((candidate) =>
      candidate.contextGraphId === input.contextGraphId)!;
    const base: Omit<EdgeSyncOperationV1, 'sequence'> = {
      phase: 'post-restart-auto',
      source: 'reconciler',
      syncMode: 'always-on',
      contextGraphId: input.contextGraphId,
      jobId: 'edge-auto-always-on',
      completedWave: 'final',
      completedSnapshot: graph.finalSnapshot,
    };
    const operation = this.operationMutation?.(base) ?? base;
    const journal = journalReference({
      kind: 'edge-reconciler-job',
      sequence: 1,
      waveId: 'edge-wave',
      jobId: operation.jobId,
      contextGraphId: operation.contextGraphId,
      source: 'reconciler',
      trigger: 'periodic-reconciler',
      syncMode: 'always-on',
      rehydratedSelectionCount: 1,
      evidenceTruncated: false,
      state: 'complete',
      verified: { metadata: true, durable: true, sharedMemory: true },
      startedAt: 10,
      finishedAt: 11,
    });
    return {
      operation,
      journal: this.edgeJournalMutation?.(journal) ?? journal,
    };
  }

  async runCoreAutomaticRound(round: number): Promise<{
    readonly round: CoreAutomaticRoundV1;
    readonly journal: SyncCoverageJournalReferenceV1;
  }> {
    this.calls.push(`core-round:${round}`);
    const publicGraphs = corpus.graphs.filter((graph) => graph.accessPolicy === 0);
    const selected = round === 0 ? publicGraphs.slice(0, 2) : publicGraphs.slice(2);
    const result: CoreAutomaticRoundV1 = {
      round,
      jobId: `core-auto-${round}`,
      planningLane: expected.publisherPeerId,
      source: 'automatic-core-public',
      configuredBatchSize: corpus.coreAutomaticBatchSize,
      explicitSelectedContextGraphIds: [],
      contextGraphIds: selected.map((graph) => graph.contextGraphId),
      completions: selected.map((graph) => ({
        contextGraphId: graph.contextGraphId,
        completedWave: 'final',
        completedSnapshot: graph.finalSnapshot,
      })),
    };
    const observed = this.coreRoundMutation?.(result) ?? result;
    return {
      round: observed,
      journal: this.coreJournalMutation?.(journalReference({
        kind: 'core-automatic-round',
        sequence: round + 1,
        waveId: 'core-wave',
        jobId: observed.jobId,
        planningLane: observed.planningLane,
        source: 'automatic-core-public',
        trigger: 'peer-sync',
        configuredBatchSize: observed.configuredBatchSize,
        effectiveBatchSize: observed.configuredBatchSize,
        explicitSelectedContextGraphIds: observed.explicitSelectedContextGraphIds,
        explicitSelectedContextGraphCount: observed.explicitSelectedContextGraphIds.length,
        automaticContextGraphIds: observed.contextGraphIds,
        automaticContextGraphCount: observed.contextGraphIds.length,
        evidenceTruncated: false,
        state: 'complete',
        startedAt: 20 + round,
        finishedAt: 21 + round,
        completions: observed.completions.map((completion) => ({
          jobId: observed.jobId,
          contextGraphId: completion.contextGraphId,
          state: 'complete',
          verified: { metadata: true, durable: true, sharedMemory: true },
          finishedAt: 21 + round,
        })),
      })) ?? journalReference({
        kind: 'core-automatic-round',
        sequence: round + 1,
        waveId: 'core-wave',
        jobId: observed.jobId,
        planningLane: observed.planningLane,
        source: 'automatic-core-public',
        trigger: 'peer-sync',
        configuredBatchSize: observed.configuredBatchSize,
        effectiveBatchSize: observed.configuredBatchSize,
        explicitSelectedContextGraphIds: observed.explicitSelectedContextGraphIds,
        explicitSelectedContextGraphCount: observed.explicitSelectedContextGraphIds.length,
        automaticContextGraphIds: observed.contextGraphIds,
        automaticContextGraphCount: observed.contextGraphIds.length,
        evidenceTruncated: false,
        state: 'complete',
        startedAt: 20 + round,
        finishedAt: 21 + round,
        completions: observed.completions.map((completion) => ({
          jobId: observed.jobId,
          contextGraphId: completion.contextGraphId,
          state: 'complete',
          verified: { metadata: true, durable: true, sharedMemory: true },
          finishedAt: 21 + round,
        })),
      }),
    };
  }

  async observeCoreFinal(): Promise<readonly CoreFinalObservationV1[]> {
    this.calls.push('observe-core-final');
    return corpus.graphs.map((graph, index) => ({
      ...(graph.accessPolicy === 0
        ? exactObservation(graph, graph.finalSnapshot)
        : absentObservation(graph.contextGraphId)),
      automaticJobIds: graph.accessPolicy === 0
        ? [index < 2 ? 'core-auto-0' : 'core-auto-1']
        : [],
    }));
  }
}

function journalReference(
  entry: Record<string, unknown>,
): SyncCoverageJournalReferenceV1 {
  const sequence = entry['sequence'] as number;
  return {
    sequence,
    snapshot: {
      schemaVersion: 1,
      processStartedAt: 1,
      waveId: entry['waveId'],
      capacity: 256,
      nextSequence: sequence + 1,
      droppedBeforeSequence: 0,
      entries: [entry],
    },
  };
}

test('collects the anchored three-process Edge/Core sequence and cleans up', async () => {
  const runtime = new ScriptedRuntime();
  const evidence = await collectSelectiveCoverageEvidenceV1({ corpus, expectedProvenance: expected, runtime });

  assert.equal(evidence.provenance.edgePeerId, expected.edgePeerId);
  assert.doesNotThrow(() => canonicalJson(evidence));
  assert.deepEqual(evidence.core.rounds.map((round) => round.contextGraphIds.length), [2, 1]);
  assert.deepEqual(runtime.stopped, ['core', 'edge', 'publisher']);
  assert.ok(
    runtime.calls.indexOf('publish:final') < runtime.calls.indexOf('start:core'),
    'Core must join cold after final publication',
  );
  assert.ok(
    runtime.calls.indexOf('observe-edge:after-restart')
      < runtime.calls.findIndex((call) => call.startsWith('edge-sync:post-restart-explicit')),
    'on-demand state must be observed stale before the second user request',
  );
});

test('rejects metadata-only runtime output and does not skip cleanup', async () => {
  const runtime = new ScriptedRuntime();
  runtime.selectedPublisherMutation = (rows) => {
    rows[0] = {
      ...rows[0]!,
      vm: {
        ...rows[0]!.vm,
        assetCount: 0,
        dataTripleCount: 0,
      },
    };
    return rows;
  };
  await assert.rejects(
    collectSelectiveCoverageEvidenceV1({ corpus, expectedProvenance: expected, runtime }),
    /failed closed/,
  );
  assert.deepEqual(runtime.stopped, ['core', 'edge', 'publisher']);
});

test('rejects a runtime identity that is not externally anchored', async () => {
  const runtime = new ScriptedRuntime();
  runtime.readyMutation = (ready) => ready.role === 'edge'
    ? { ...ready, peerId: 'unexpected-edge' }
    : ready;
  await assert.rejects(
    collectSelectiveCoverageEvidenceV1({ corpus, expectedProvenance: expected, runtime }),
    /edge runtime identity differs/,
  );
  assert.deepEqual(runtime.stopped, ['edge', 'publisher']);
  assert.equal(runtime.calls.includes('publish:selected'), false);
});

test('rejects relabelled Edge reconciler work', async () => {
  const runtime = new ScriptedRuntime();
  runtime.operationMutation = (operation) => operation.phase === 'post-restart-auto'
    ? { ...operation, source: 'user' }
    : operation;
  await assert.rejects(
    collectSelectiveCoverageEvidenceV1({ corpus, expectedProvenance: expected, runtime }),
    /failed closed/,
  );
});

test('rejects truncated automatic Edge journal evidence', async () => {
  const runtime = new ScriptedRuntime();
  runtime.edgeJournalMutation = (journal) => {
    const copy = structuredClone(journal) as any;
    copy.snapshot.entries[0].evidenceTruncated = true;
    return copy;
  };
  await assert.rejects(
    collectSelectiveCoverageEvidenceV1({ corpus, expectedProvenance: expected, runtime }),
    /missing, truncated, or incomplete/,
  );
});

test('rejects Core work that is not an automatic scheduler round', async () => {
  const runtime = new ScriptedRuntime();
  runtime.coreRoundMutation = (round) => ({
    ...round,
    explicitSelectedContextGraphIds: [graphs[0]!.contextGraphId],
  });
  await assert.rejects(
    collectSelectiveCoverageEvidenceV1({ corpus, expectedProvenance: expected, runtime }),
    /not scheduler-issued automatic coverage/,
  );
});

test('rejects a Core journal entry overwritten before collection', async () => {
  const runtime = new ScriptedRuntime();
  runtime.coreJournalMutation = (journal) => {
    const copy = structuredClone(journal) as any;
    copy.snapshot.droppedBeforeSequence = journal.sequence + 1;
    return copy;
  };
  await assert.rejects(
    collectSelectiveCoverageEvidenceV1({ corpus, expectedProvenance: expected, runtime }),
    /no longer retains/,
  );
});

test('binds every Core completion to the actual scheduler round job ID', async () => {
  const runtime = new ScriptedRuntime();
  runtime.coreJournalMutation = (journal) => {
    const copy = structuredClone(journal) as any;
    copy.snapshot.entries[0].completions[0].jobId = 'unbound-child-job';
    return copy;
  };
  await assert.rejects(
    collectSelectiveCoverageEvidenceV1({ corpus, expectedProvenance: expected, runtime }),
    /lacks a terminal verified completion/,
  );
});

test('requires the exact runtime journal capacity from the node-admin contract', async () => {
  const runtime = new ScriptedRuntime();
  runtime.coreJournalMutation = (journal) => {
    const copy = structuredClone(journal) as any;
    copy.snapshot.capacity = 257;
    return copy;
  };
  await assert.rejects(
    collectSelectiveCoverageEvidenceV1({ corpus, expectedProvenance: expected, runtime }),
    /journal snapshot is malformed/,
  );
});

test('accepts the truthful Node process-start epoch used by the runtime journal', async () => {
  const runtime = new ScriptedRuntime();
  const processStartedAt = 1_753_000_000_123;
  runtime.readyMutation = (ready) => ready.role === 'core'
    ? { ...ready, processStartedAt }
    : ready;
  runtime.coreJournalMutation = (journal) => {
    const copy = structuredClone(journal) as any;
    copy.snapshot.processStartedAt = processStartedAt;
    return copy;
  };
  await assert.doesNotReject(
    collectSelectiveCoverageEvidenceV1({ corpus, expectedProvenance: expected, runtime }),
  );
});

test('requires restart to cross an OS process boundary', async () => {
  const runtime = new ScriptedRuntime();
  runtime.readyMutation = (ready) => ready.role === 'edge' && ready.pid === 103
    ? { ...ready, pid: 102 }
    : ready;
  await assert.rejects(
    collectSelectiveCoverageEvidenceV1({ corpus, expectedProvenance: expected, runtime }),
    /does not prove old-process exit/,
  );
});

test('requires positive proof that the previous Edge process exited', async () => {
  const runtime = new ScriptedRuntime();
  runtime.restartReceiptMutation = (receipt) => ({
    ...receipt,
    previous: { ...receipt.previous, exitedAt: -1 },
  });
  await assert.rejects(
    collectSelectiveCoverageEvidenceV1({ corpus, expectedProvenance: expected, runtime }),
    /does not prove old-process exit/,
  );
});

test('requires the replacement Edge process to start after the prior exit', async () => {
  const runtime = new ScriptedRuntime();
  runtime.restartReceiptMutation = (receipt) => ({
    ...receipt,
    previous: { ...receipt.previous, exitedAt: receipt.current.processStartedAt + 1 },
  });
  await assert.rejects(
    collectSelectiveCoverageEvidenceV1({ corpus, expectedProvenance: expected, runtime }),
    /does not prove old-process exit/,
  );
});

test('does not publish a PASS artifact when controller shutdown fails', async () => {
  let published = false;
  await assert.rejects(
    runSelectiveCoverageLiveV1({
      collect: async () => ({ pass: true }),
      close: async () => {
        throw new Error('shutdown timeout');
      },
      publish: async () => {
        published = true;
      },
    }),
    /shutdown timeout/,
  );
  assert.equal(published, false);
});
