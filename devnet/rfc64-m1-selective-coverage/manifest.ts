import { createHash } from 'node:crypto';
import { stableJson } from '../rfc64-persistence-lifecycle/evidence.ts';

export const SELECTIVE_COVERAGE_CORPUS_SCHEMA =
  'dkg-rfc64-m1-selective-coverage-corpus-v1' as const;
export const SELECTIVE_COVERAGE_EVIDENCE_SCHEMA =
  'dkg-rfc64-m1-selective-coverage-evidence-v1' as const;
export const SELECTIVE_COVERAGE_VERDICT_SCHEMA =
  'dkg-rfc64-m1-selective-coverage-verdict-v1' as const;

export const MAX_SELECTIVE_COVERAGE_GRAPHS = 64;
export const MAX_SELECTIVE_COVERAGE_ROUNDS = 256;
/** Matches the bounded producer journal; larger corpora span multiple rounds. */
export const MAX_SYNC_COVERAGE_IDS_PER_JOURNAL_ENTRY = 32;

export type EdgeCoveragePolicy = 'always-on' | 'on-demand' | 'unselected';

export interface PlaneExpectationV1 {
  readonly headDigest: string;
  readonly inventoryDigest: string;
  readonly assetCount: number;
  readonly dataTripleCount: number;
}

export interface GraphSnapshotExpectationV1 {
  readonly vm: PlaneExpectationV1;
  readonly swm: PlaneExpectationV1;
}

export interface SelectiveCoverageGraphV1 {
  readonly contextGraphId: string;
  readonly accessPolicy: 0 | 1;
  readonly publishPolicy: 0 | 1;
  readonly edgePolicy: EdgeCoveragePolicy;
  /** Snapshot present when the Edge selection is first exercised. */
  readonly selectedSnapshot: GraphSnapshotExpectationV1;
  /** Snapshot after a second publication wave and an Edge restart. */
  readonly finalSnapshot: GraphSnapshotExpectationV1;
}

export interface SelectiveCoverageCorpusV1 {
  readonly schema: typeof SELECTIVE_COVERAGE_CORPUS_SCHEMA;
  readonly networkId: string;
  readonly coreAutomaticBatchSize: number;
  /** Maximum automatic rounds allowed before every public graph is first admitted. */
  readonly coreCoverageRoundLimit: number;
  /** Lexicographically ordered by contextGraphId. */
  readonly graphs: readonly SelectiveCoverageGraphV1[];
  /** SHA-256 of the closed corpus payload, excluding this field. */
  readonly manifestDigest: string;
}

export interface PlaneObservationV1 {
  readonly reportedComplete: boolean;
  readonly headDigest: string | null;
  readonly inventoryDigest: string | null;
  readonly assetCount: number;
  readonly metadataTripleCount: number;
  readonly dataTripleCount: number;
}

export interface GraphObservationV1 {
  readonly contextGraphId: string;
  readonly vm: PlaneObservationV1;
  readonly swm: PlaneObservationV1;
}

export interface EdgeGraphObservationV1 extends GraphObservationV1 {
  /** Mode read from the running Edge, not copied from the corpus manifest. */
  readonly runtimeSyncMode: 'always-on' | 'on-demand' | null;
  /** Operation that produced the observed payload; null when payload is absent. */
  readonly producingJobId: string | null;
}

export interface EdgeSyncOperationV1 {
  readonly sequence: number;
  readonly phase: 'selection' | 'post-restart-auto' | 'post-restart-explicit';
  readonly source: 'reconciler' | 'user';
  readonly syncMode: 'always-on' | 'on-demand';
  readonly contextGraphId: string;
  readonly jobId: string;
  readonly completedWave: 'selected' | 'final';
  readonly completedSnapshot: GraphSnapshotExpectationV1;
}

export interface CoreAutomaticCompletionV1 {
  readonly contextGraphId: string;
  readonly completedWave: 'final';
  readonly completedSnapshot: GraphSnapshotExpectationV1;
}

export interface CoreAutomaticRoundV1 {
  readonly round: number;
  readonly jobId: string;
  readonly planningLane: string;
  readonly source: 'automatic-core-public';
  readonly configuredBatchSize: number;
  /** Must remain empty: selected Core work is outside automatic coverage evidence. */
  readonly explicitSelectedContextGraphIds: readonly string[];
  /** Automatic coverage only. Explicit selections are deliberately outside this cap. */
  readonly contextGraphIds: readonly string[];
  /** Exact terminal states produced by this automatic job after the final wave. */
  readonly completions: readonly CoreAutomaticCompletionV1[];
}

export interface CoreFinalObservationV1 extends GraphObservationV1 {
  /** Scheduler-issued automatic job IDs that produced this graph's final state. */
  readonly automaticJobIds: readonly string[];
}

/** Bounded raw node-admin journal response retained in the published artifact. */
export interface SyncCoverageJournalReferenceV1 {
  readonly snapshot: unknown;
  readonly sequence: number;
}

export interface SyncCoverageJournalProcessIdentityV1 {
  readonly processStartedAt: number;
  readonly evidenceWaveId: string;
}

export interface SelectiveCoverageAutomaticJournalEvidenceV1 {
  readonly edgeProcess: SyncCoverageJournalProcessIdentityV1;
  /** Ordered exactly like post-restart automatic Edge operations. */
  readonly edgeReconciler: readonly SyncCoverageJournalReferenceV1[];
  readonly coreProcess: SyncCoverageJournalProcessIdentityV1;
  /** Ordered exactly like Core automatic rounds. */
  readonly coreRounds: readonly SyncCoverageJournalReferenceV1[];
}

export interface SelectiveCoverageProvenanceV1 {
  readonly networkId: string;
  readonly testedHeadCommit: string;
  readonly runtimeManifestDigest: string;
  readonly publisherPeerId: string;
  readonly edgePeerId: string;
  readonly corePeerId: string;
}

export interface ExpectedSelectiveCoverageProvenanceV1
  extends SelectiveCoverageProvenanceV1 {
  readonly corpusManifestDigest: string;
}

export interface SelectiveCoverageEvidenceV1 {
  readonly schema: typeof SELECTIVE_COVERAGE_EVIDENCE_SCHEMA;
  readonly provenance: SelectiveCoverageProvenanceV1;
  /** Raw automatic-work proof required for independent artifact verification. */
  readonly automaticJournalEvidence: SelectiveCoverageAutomaticJournalEvidenceV1;
  readonly corpus: SelectiveCoverageCorpusV1;
  /** Publisher-owned source snapshots; receivers cannot define their expectations. */
  readonly publisher: {
    readonly selected: readonly GraphObservationV1[];
    readonly final: readonly GraphObservationV1[];
  };
  readonly edge: {
    readonly beforeSelection: readonly EdgeGraphObservationV1[];
    readonly afterSelection: readonly EdgeGraphObservationV1[];
    readonly afterRestart: readonly EdgeGraphObservationV1[];
    readonly afterSecondOnDemand: readonly EdgeGraphObservationV1[];
    readonly operations: readonly EdgeSyncOperationV1[];
  };
  readonly core: {
    readonly automaticBatchSize: number;
    readonly rounds: readonly CoreAutomaticRoundV1[];
    readonly final: readonly CoreFinalObservationV1[];
  };
}

export interface SelectiveCoverageChecksV1 {
  readonly schemaWellFormed: boolean;
  readonly provenanceMatches: boolean;
  readonly corpusDigestMatches: boolean;
  readonly corpusCanonicalOrder: boolean;
  readonly requiredPolicyCellsPresent: boolean;
  readonly publisherSnapshotsExact: boolean;
  readonly publicSecondWaveAdvances: boolean;
  readonly edgePassiveBeforeSelection: boolean;
  readonly edgeSelectedSnapshotsExact: boolean;
  readonly edgeOnDemandRemainsPointInTime: boolean;
  readonly edgeAlwaysOnRefreshesAfterRestart: boolean;
  readonly edgeOperationProvenance: boolean;
  readonly edgeSecondOnDemandConverges: boolean;
  readonly edgeUnselectedExcluded: boolean;
  readonly edgePrivateExcluded: boolean;
  readonly coreBatchMatchesManifest: boolean;
  readonly coreBatchWithinBound: boolean;
  readonly coreRoundsPublicOnly: boolean;
  readonly coreAutomaticProvenance: boolean;
  readonly coreEveryPublicScheduled: boolean;
  readonly coreCoverageWithinWindow: boolean;
  readonly coreFinalPublicExact: boolean;
  readonly corePrivateExcluded: boolean;
  readonly noMetadataOnlyCompletion: boolean;
}

export interface SelectiveCoverageVerdictV1 {
  readonly schema: typeof SELECTIVE_COVERAGE_VERDICT_SCHEMA;
  readonly pass: boolean;
  readonly checks: SelectiveCoverageChecksV1;
  readonly missingCoreContextGraphIds: readonly string[];
  readonly rejectReasons: readonly string[];
  readonly recomputedCorpusDigest: string;
}

type CorpusPayload = Omit<SelectiveCoverageCorpusV1, 'manifestDigest'>;

/** Construct a byte-deterministic manifest and normalize graph order once. */
export function createSelectiveCoverageCorpus(input: {
  networkId: string;
  coreAutomaticBatchSize: number;
  coreCoverageRoundLimit: number;
  graphs: readonly SelectiveCoverageGraphV1[];
}): SelectiveCoverageCorpusV1 {
  if (!Number.isSafeInteger(input.coreAutomaticBatchSize)
    || input.coreAutomaticBatchSize < 1
    || input.coreAutomaticBatchSize > MAX_SYNC_COVERAGE_IDS_PER_JOURNAL_ENTRY) {
    throw new RangeError('Core automatic batch exceeds one bounded journal entry');
  }
  const payload: CorpusPayload = {
    schema: SELECTIVE_COVERAGE_CORPUS_SCHEMA,
    networkId: input.networkId,
    coreAutomaticBatchSize: input.coreAutomaticBatchSize,
    coreCoverageRoundLimit: input.coreCoverageRoundLimit,
    graphs: [...input.graphs].sort((left, right) =>
      compareCodeUnits(left.contextGraphId, right.contextGraphId)),
  };
  return Object.freeze({
    ...payload,
    manifestDigest: computeSelectiveCoverageCorpusDigest(payload),
  });
}

export function computeSelectiveCoverageCorpusDigest(
  corpus: CorpusPayload | SelectiveCoverageCorpusV1,
): string {
  const { manifestDigest: _ignored, ...payload } = corpus as SelectiveCoverageCorpusV1;
  return `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`;
}

/** Stable JSON is also used by the future process launcher when publishing artifacts. */
export function canonicalJson(value: unknown): string {
  return stableJson(value, {
    format: 'compact',
    trailingLf: false,
    numbers: 'safe-integer',
  });
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
