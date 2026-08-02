import {
  type CoreAutomaticRoundV1,
  type CoreFinalObservationV1,
  type EdgeGraphObservationV1,
  type EdgeSyncOperationV1,
  type ExpectedSelectiveCoverageProvenanceV1,
  type GraphObservationV1,
  type SelectiveCoverageCorpusV1,
  type SelectiveCoverageEvidenceV1,
  SELECTIVE_COVERAGE_EVIDENCE_SCHEMA,
  MAX_SYNC_COVERAGE_IDS_PER_JOURNAL_ENTRY,
  computeSelectiveCoverageCorpusDigest,
} from './manifest.ts';
import { verifySelectiveCoverage } from './verifier.ts';
import { buildEdgeOperationPlan } from './edge-operation-plan.ts';
import {
  assertCoreAutomaticRoundJournalV1,
  assertEdgeReconcilerJournalV1,
  type SyncCoverageJournalReferenceV1,
} from './sync-coverage-journal.ts';

export const SELECTIVE_COVERAGE_RUNTIME_PROTOCOL =
  'dkg-rfc64-m1-selective-coverage-runtime-v1' as const;

export type SelectiveCoverageRuntimeRole = 'publisher' | 'edge' | 'core';

export interface SelectiveCoverageRuntimeReadyV1 {
  readonly protocol: typeof SELECTIVE_COVERAGE_RUNTIME_PROTOCOL;
  readonly role: SelectiveCoverageRuntimeRole;
  /** Stable identity for the OS host that owns this process namespace. */
  readonly hostIdentity: string;
  readonly pid: number;
  readonly peerId: string;
  readonly networkId: string;
  readonly testedHeadCommit: string;
  readonly runtimeManifestDigest: string;
  /** Node process-start epoch milliseconds, sourced from performance.timeOrigin. */
  readonly processStartedAt: number;
  /** Per-process unguessable instance identity, not the stable DKG peer ID. */
  readonly processInstanceId: string;
  /** Stable identity for the durable directory reused across an Edge restart. */
  readonly dataDirectoryIdentity: string;
  /** Process-local sync evidence wave emitted by the node journal. */
  readonly evidenceWaveId: string;
}

export interface SelectiveCoverageEdgeRestartReceiptV1 {
  readonly previous: {
    readonly hostIdentity: string;
    readonly pid: number;
    readonly processInstanceId: string;
    readonly exitedAt: number;
  };
  readonly current: SelectiveCoverageRuntimeReadyV1;
}

export interface SelectiveCoverageRuntimeV1 {
  start(role: SelectiveCoverageRuntimeRole): Promise<SelectiveCoverageRuntimeReadyV1>;
  stop(role: SelectiveCoverageRuntimeRole): Promise<void>;
  publishWave(wave: 'selected' | 'final'): Promise<readonly GraphObservationV1[]>;
  observeEdge(
    checkpoint: 'before-selection' | 'after-selection' | 'after-restart'
      | 'after-second-on-demand',
  ): Promise<readonly EdgeGraphObservationV1[]>;
  synchronizeEdge(input: {
    readonly contextGraphId: string;
    readonly phase: 'selection' | 'post-restart-explicit';
    readonly syncMode: 'always-on' | 'on-demand';
    readonly wave: EdgeSyncOperationV1['completedWave'];
  }): Promise<{
    readonly operation: Omit<EdgeSyncOperationV1, 'sequence'>;
    /** Required only for post-restart automatic reconciler work. */
    readonly journal?: SyncCoverageJournalReferenceV1;
  }>;
  restartEdge(): Promise<SelectiveCoverageEdgeRestartReceiptV1>;
  waitForEdgeReconciler(input: {
    readonly contextGraphId: string;
  }): Promise<{
    readonly operation: Omit<EdgeSyncOperationV1, 'sequence'>;
    readonly journal: SyncCoverageJournalReferenceV1;
  }>;
  runCoreAutomaticRound(round: number): Promise<{
    readonly round: CoreAutomaticRoundV1;
    readonly journal: SyncCoverageJournalReferenceV1;
  }>;
  observeCoreFinal(): Promise<readonly CoreFinalObservationV1[]>;
}

/**
 * Run the user-visible M1 sequence without deriving expectations from a receiver.
 *
 * The corpus and provenance are immutable operator inputs. Runtime observations
 * can satisfy them, but can never redefine them. The final verifier is invoked
 * before evidence is returned, so callers cannot accidentally publish a
 * metadata-only or otherwise incomplete artifact as a passing run.
 */
export async function collectSelectiveCoverageEvidenceV1(input: {
  readonly corpus: SelectiveCoverageCorpusV1;
  readonly expectedProvenance: ExpectedSelectiveCoverageProvenanceV1;
  readonly runtime: SelectiveCoverageRuntimeV1;
}): Promise<SelectiveCoverageEvidenceV1> {
  assertAnchoredCorpus(input.corpus, input.expectedProvenance);
  const edgePlan = buildEdgeOperationPlan(input.corpus);
  const attempted = new Set<SelectiveCoverageRuntimeRole>();
  let primaryFailure: unknown;
  try {
    attempted.add('publisher');
    const publisher = await input.runtime.start('publisher');
    assertReady(publisher, 'publisher', input.expectedProvenance);

    attempted.add('edge');
    const edgeBeforeRestart = await input.runtime.start('edge');
    assertReady(edgeBeforeRestart, 'edge', input.expectedProvenance);
    assertDistinctProcesses([publisher, edgeBeforeRestart]);

    const publisherSelected = canonicalGraphObservations(
      await input.runtime.publishWave('selected'),
      input.corpus,
      'Publisher selected wave',
    );
    const edgeBeforeSelection = canonicalEdgeObservations(
      await input.runtime.observeEdge('before-selection'),
      input.corpus,
      'Edge before selection',
    );

    const edgeOperations: EdgeSyncOperationV1[] = [];
    const edgeReconcilerJournals: SyncCoverageJournalReferenceV1[] = [];
    for (const step of edgePlan.selection) {
      const result = await input.runtime.synchronizeEdge({
        contextGraphId: step.contextGraphId,
        phase: step.phase,
        syncMode: step.syncMode,
        wave: step.completedWave,
      });
      edgeOperations.push(withSequence(result.operation, edgeOperations.length));
    }
    const edgeAfterSelection = canonicalEdgeObservations(
      await input.runtime.observeEdge('after-selection'),
      input.corpus,
      'Edge after selection',
    );

    const publisherFinal = canonicalGraphObservations(
      await input.runtime.publishWave('final'),
      input.corpus,
      'Publisher final wave',
    );

    const edgeRestart = await input.runtime.restartEdge();
    assertEdgeRestartReceipt(edgeRestart, edgeBeforeRestart);
    const edgeAfterRestartReady = edgeRestart.current;
    assertReady(edgeAfterRestartReady, 'edge', input.expectedProvenance);
    assertDistinctProcesses([publisher, edgeBeforeRestart, edgeAfterRestartReady]);

    for (const step of edgePlan.postRestartAutomatic) {
      const result = await input.runtime.waitForEdgeReconciler({
        contextGraphId: step.contextGraphId,
      });
      assertEdgeReconcilerJournalV1(
        result.journal,
        result.operation,
        edgeAfterRestartReady,
      );
      edgeReconcilerJournals.push(result.journal);
      edgeOperations.push(withSequence(result.operation, edgeOperations.length));
    }
    const edgeAfterRestart = canonicalEdgeObservations(
      await input.runtime.observeEdge('after-restart'),
      input.corpus,
      'Edge after restart',
    );

    for (const step of edgePlan.postRestartExplicit) {
      const result = await input.runtime.synchronizeEdge({
        contextGraphId: step.contextGraphId,
        phase: step.phase,
        syncMode: step.syncMode,
        wave: step.completedWave,
      });
      edgeOperations.push(withSequence(result.operation, edgeOperations.length));
    }
    const edgeAfterSecondOnDemand = canonicalEdgeObservations(
      await input.runtime.observeEdge('after-second-on-demand'),
      input.corpus,
      'Edge after second on-demand request',
    );

    attempted.add('core');
    const core = await input.runtime.start('core');
    assertReady(core, 'core', input.expectedProvenance);
    assertDistinctProcesses([publisher, edgeAfterRestartReady, core]);

    const rounds: CoreAutomaticRoundV1[] = [];
    const coreRoundJournals: SyncCoverageJournalReferenceV1[] = [];
    const scheduled = new Set<string>();
    const publicIds = new Set(
      input.corpus.graphs
        .filter((graph) => graph.accessPolicy === 0)
        .map((graph) => graph.contextGraphId),
    );
    for (let round = 0; round < input.corpus.coreCoverageRoundLimit; round += 1) {
      const result = await input.runtime.runCoreAutomaticRound(round);
      const observed = result.round;
      assertCoreRoundEnvelope(observed, round, input.corpus, publisher.peerId);
      assertCoreAutomaticRoundJournalV1(result.journal, observed, core);
      rounds.push(observed);
      coreRoundJournals.push(result.journal);
      for (const contextGraphId of observed.contextGraphIds) scheduled.add(contextGraphId);
      if ([...publicIds].every((contextGraphId) => scheduled.has(contextGraphId))) break;
    }
    const coreFinal = canonicalCoreObservations(
      await input.runtime.observeCoreFinal(),
      input.corpus,
      'Core final',
    );

    const evidence: SelectiveCoverageEvidenceV1 = {
      schema: SELECTIVE_COVERAGE_EVIDENCE_SCHEMA,
      provenance: {
        networkId: publisher.networkId,
        testedHeadCommit: publisher.testedHeadCommit,
        runtimeManifestDigest: publisher.runtimeManifestDigest,
        publisherPeerId: publisher.peerId,
        edgePeerId: edgeAfterRestartReady.peerId,
        corePeerId: core.peerId,
      },
      automaticJournalEvidence: {
        edgeProcess: {
          processStartedAt: edgeAfterRestartReady.processStartedAt,
          evidenceWaveId: edgeAfterRestartReady.evidenceWaveId,
        },
        edgeReconciler: Object.freeze(edgeReconcilerJournals),
        coreProcess: {
          processStartedAt: core.processStartedAt,
          evidenceWaveId: core.evidenceWaveId,
        },
        coreRounds: Object.freeze(coreRoundJournals),
      },
      corpus: input.corpus,
      publisher: {
        selected: publisherSelected,
        final: publisherFinal,
      },
      edge: {
        beforeSelection: edgeBeforeSelection,
        afterSelection: edgeAfterSelection,
        afterRestart: edgeAfterRestart,
        afterSecondOnDemand: edgeAfterSecondOnDemand,
        operations: Object.freeze(edgeOperations),
      },
      core: {
        automaticBatchSize: input.corpus.coreAutomaticBatchSize,
        rounds: Object.freeze(rounds),
        final: coreFinal,
      },
    };
    const detachedEvidence = detachJsonEvidence(evidence);
    const verdict = verifySelectiveCoverage(detachedEvidence, input.expectedProvenance);
    if (!verdict.pass) {
      throw new Error(
        `M1 runtime evidence failed closed: ${verdict.rejectReasons.join('; ')}`,
      );
    }
    return detachedEvidence;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    for (const role of [...attempted].reverse()) {
      try {
        await input.runtime.stop(role);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (primaryFailure === undefined && cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, 'M1 runtime cleanup failed');
    }
  }
}

function assertEdgeRestartReceipt(
  receipt: SelectiveCoverageEdgeRestartReceiptV1,
  previous: SelectiveCoverageRuntimeReadyV1,
): void {
  if (receipt.previous.pid !== previous.pid
    || receipt.previous.hostIdentity !== previous.hostIdentity
    || receipt.previous.processInstanceId !== previous.processInstanceId
    || !Number.isSafeInteger(receipt.previous.exitedAt)
    || receipt.previous.exitedAt < previous.processStartedAt
    || receipt.current.processStartedAt < receipt.previous.exitedAt
    || receipt.current.hostIdentity !== previous.hostIdentity
    || receipt.current.pid === previous.pid
    || receipt.current.processInstanceId === previous.processInstanceId
    || receipt.current.dataDirectoryIdentity !== previous.dataDirectoryIdentity) {
    throw new Error('Edge restart receipt does not prove old-process exit and durable reuse');
  }
}

function detachJsonEvidence(
  evidence: SelectiveCoverageEvidenceV1,
): SelectiveCoverageEvidenceV1 {
  try {
    // Runtime responses cross JSON in production. Detaching here gives an
    // injected/in-process adapter the same boundary and prevents shared object
    // identities from making the final canonical artifact ambiguous.
    return JSON.parse(JSON.stringify(evidence)) as SelectiveCoverageEvidenceV1;
  } catch (error) {
    throw new Error('M1 runtime evidence is not lossless JSON', { cause: error });
  }
}

function withSequence(
  operation: Omit<EdgeSyncOperationV1, 'sequence'>,
  sequence: number,
): EdgeSyncOperationV1 {
  return { sequence, ...operation };
}

function assertAnchoredCorpus(
  corpus: SelectiveCoverageCorpusV1,
  expected: ExpectedSelectiveCoverageProvenanceV1,
): void {
  if (computeSelectiveCoverageCorpusDigest(corpus) !== corpus.manifestDigest) {
    throw new Error('M1 corpus manifest digest does not match its payload');
  }
  if (corpus.manifestDigest !== expected.corpusManifestDigest) {
    throw new Error('M1 corpus differs from the external trust anchor');
  }
  if (corpus.networkId !== expected.networkId) {
    throw new Error('M1 corpus network differs from the external trust anchor');
  }
  if (corpus.coreAutomaticBatchSize > MAX_SYNC_COVERAGE_IDS_PER_JOURNAL_ENTRY) {
    throw new Error('M1 Core batch exceeds the bounded journal entry capacity');
  }
  for (const graph of corpus.graphs) {
    if (graph.accessPolicy === 1 && graph.edgePolicy !== 'unselected') {
      throw new Error('M1 private graphs must remain unselected in the Edge slice');
    }
  }
}

function assertReady(
  actual: SelectiveCoverageRuntimeReadyV1,
  role: SelectiveCoverageRuntimeRole,
  expected: ExpectedSelectiveCoverageProvenanceV1,
): void {
  const expectedPeerId = role === 'publisher'
    ? expected.publisherPeerId
    : role === 'edge'
      ? expected.edgePeerId
      : expected.corePeerId;
  if (actual.protocol !== SELECTIVE_COVERAGE_RUNTIME_PROTOCOL
    || actual.role !== role
    || !Number.isSafeInteger(actual.pid)
    || actual.pid <= 0
    || actual.peerId !== expectedPeerId
    || actual.networkId !== expected.networkId
    || actual.testedHeadCommit !== expected.testedHeadCommit
    || actual.runtimeManifestDigest !== expected.runtimeManifestDigest) {
    throw new Error(`${role} runtime identity differs from the external trust anchor`);
  }
  for (const [label, value] of [
    ['hostIdentity', actual.hostIdentity],
    ['processInstanceId', actual.processInstanceId],
    ['dataDirectoryIdentity', actual.dataDirectoryIdentity],
    ['evidenceWaveId', actual.evidenceWaveId],
  ] as const) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
      throw new Error(`${role} runtime ${label} is invalid`);
    }
  }
  if (!Number.isSafeInteger(actual.processStartedAt) || actual.processStartedAt < 0) {
    throw new Error(`${role} runtime processStartedAt is invalid`);
  }
}

function assertDistinctProcesses(
  processes: readonly SelectiveCoverageRuntimeReadyV1[],
): void {
  const osProcessIdentities = processes.map((entry) => `${entry.hostIdentity}\0${entry.pid}`);
  if (new Set(osProcessIdentities).size !== processes.length
    || new Set(processes.map((entry) => entry.processInstanceId)).size !== processes.length) {
    throw new Error('M1 roles did not cross distinct OS process boundaries');
  }
  const peerByRole = new Map<SelectiveCoverageRuntimeRole, string>();
  for (const process of processes) peerByRole.set(process.role, process.peerId);
  if (new Set(peerByRole.values()).size !== peerByRole.size) {
    throw new Error('M1 roles did not use distinct DKG peer identities');
  }
}

function canonicalGraphObservations<T extends GraphObservationV1>(
  observations: readonly T[],
  corpus: SelectiveCoverageCorpusV1,
  label: string,
): readonly T[] {
  const expectedIds = corpus.graphs.map((graph) => graph.contextGraphId);
  const byId = new Map(observations.map((row) => [row.contextGraphId, row]));
  if (observations.length !== expectedIds.length || byId.size !== expectedIds.length) {
    throw new Error(`${label} did not return exactly one row per anchored graph`);
  }
  const canonical = expectedIds.map((contextGraphId) => byId.get(contextGraphId));
  if (canonical.some((row) => row === undefined)) {
    throw new Error(`${label} omitted an anchored graph`);
  }
  return Object.freeze(canonical as T[]);
}

function canonicalEdgeObservations(
  observations: readonly EdgeGraphObservationV1[],
  corpus: SelectiveCoverageCorpusV1,
  label: string,
): readonly EdgeGraphObservationV1[] {
  return canonicalGraphObservations(observations, corpus, label);
}

function canonicalCoreObservations(
  observations: readonly CoreFinalObservationV1[],
  corpus: SelectiveCoverageCorpusV1,
  label: string,
): readonly CoreFinalObservationV1[] {
  return canonicalGraphObservations(observations, corpus, label);
}

function assertCoreRoundEnvelope(
  observed: CoreAutomaticRoundV1,
  round: number,
  corpus: SelectiveCoverageCorpusV1,
  publisherPeerId: string,
): void {
  if (observed.round !== round
    || observed.source !== 'automatic-core-public'
    || observed.planningLane !== publisherPeerId
    || observed.configuredBatchSize !== corpus.coreAutomaticBatchSize
    || observed.explicitSelectedContextGraphIds.length !== 0) {
    throw new Error(`Core round ${round} is not scheduler-issued automatic coverage`);
  }
}
