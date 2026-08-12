import {
  keccak256,
  SENTINEL_NO_PRIVATE_V10,
  tripleContentV10,
  V10MerkleTree,
} from '@origintrail-official/dkg-core';
import {
  canonicalizeAgentProfileConflictEvidenceV1,
  computeAgentProfileConflictEvidenceDigestV1,
  computeAgentProfileHeadObjectDigestV1,
  computeSystemRecordAppliedStateDigestV1,
  computeSystemRecordStableKeyHashV1,
  EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
  SYSTEM_RECORD_EMPTY_PROJECTION_DIGEST_V1,
  type AgentProfileActiveHeadObjectV1,
  type AgentProfileConflictEvidenceV1,
  type AgentProfileHeadObjectV1,
  type AgentProfileVerifiedAuthoritySummaryV1,
  type Digest32V1,
  type SystemRecordAppliedStatePresentV1,
  type SystemRecordMaterializationReceiptV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import { SYSTEM_RECORD_V1_STATE_GRAPH } from '../../src/internal-graph-policy.js';
import {
  deriveSystemRecordReplacementV1,
  type SystemRecordActiveReplacementReadyV1,
} from '../../src/system-record-next-state-v1-internal.js';
import {
  buildSystemRecordReservedStateQuadsV1,
  systemRecordEpochSubjectV1,
  SYSTEM_RECORD_V1_PREDICATES,
} from '../../src/system-record-rdf-schema-v1-internal.js';
import {
  decodeSystemRecordAppliedSnapshotV1,
  type SystemRecordAppliedSnapshotV1,
} from '../../src/system-record-state-snapshot-v1-internal.js';
import { createSystemRecordVerifiedReplacementRegistryV1 } from '../../src/system-record-verified-replacement-v1-internal.js';
import type { Quad } from '../../src/triple-store.js';

import { buildAgentProfileVerificationClosureV1 } from '@origintrail-official/dkg-core/system-record-v1';

import { agentProfileIdentityProjectionV1 } from './agent-profile-identity-projection-v1.js';
import {
  CORE_CHAIN_V1,
  CORE_CURRENT_HEAD_V1,
  CORE_EQUIVOCATING_TRANSITION_V1,
  CORE_FORK_CONFLICT_HEADS_V1,
  CORE_FORK_RESOLUTION_V1,
} from './authority-verdict-diff-core-heads-v1.js';
import {
  buildSystemRecordClosureArtifactsV1,
  systemRecordClosureResolveOptionsV1,
  SYSTEM_RECORD_FIXTURE_NETWORK,
} from './system-record-active-replacement-fixture.js';
import {
  mintAgentProfileTombstoneClosureV1,
  TERMINAL_FIXTURE_NOW_MS_V1,
} from './system-record-terminal-replacement-fixture.js';

/**
 * THE STORAGE HALF OF THE VERDICT-DIFF SWEEP.
 *
 * Drives storage's authority-advance path through the EXPORTED dispatching entry
 * `deriveSystemRecordReplacementV1` -- never through `deriveSystemRecordActive-
 * ReplacementV1`, `deriveSystemRecordTombstoneReplacementV1` or
 * `quarantineSystemRecordDerivationV1`, which are the components that entry
 * dispatches to (:171-181) and which Phase 3 may delete or re-route. That is the
 * same instrument rule the core half follows, for the same reason: the entry is
 * the contract that survives Phase 3 routing.
 *
 * Facts cannot be fabricated: they come only from the verified-replacement
 * registry, so every evaluation issues through `issuer.issueCandidate` and
 * consumes with the SEVEN-key lane binding. A fresh registry per evaluation,
 * because a handle is single-use and a reservation is WeakSet-branded to the
 * registry that minted it.
 *
 * THIS MODULE IS AN INSTRUMENT, AND AN INSTRUMENT THAT CANNOT MISREAD IS NOT
 * PROVEN, IT IS UNTESTED. Its own refusal ladder is
 * `authority-verdict-diff-storage-driver-v1.test.ts`: swapped projection,
 * mis-bound summary, wrong binding shape, and a snapshot form that must reach
 * the classifier. The two control hooks below exist only for that ladder.
 */

/* ------------------------------------------------------------------ *
 * The lane binding.
 *
 * SEVEN keys -- this is what `consumer.consume` validates against
 * (`SystemRecordVerifiedReplacementLaneBindingV1`, :70-78). The ISSUE object is
 * larger: these seven plus `admittedDeadlineMs` (:80-83) plus head, summary,
 * canonicalProjectionBytes, projectionQuads, ownedSubjectTable (:89-97). Handing
 * the issue object to `consume` is a silent shape error, so the two are built
 * from ONE constant and never conflated.
 *
 * `sessionIdentity` is a single module-level object: the binding check compares
 * it by identity, so issue and consume must be handed the very same reference.
 * ------------------------------------------------------------------ */
export const STORAGE_LANE_BINDING_V1 = Object.freeze({
  networkId: SYSTEM_RECORD_FIXTURE_NETWORK,
  kind: 'agents',
  mode: 'shadow',
  sessionIdentity: Object.freeze(Object.create(null) as object),
  activationGeneration: '1',
  childGeneration: '2',
  materializationEpoch: '2',
});

export const ADMITTED_DEADLINE_MS_V1 = 10_000;

/** The sibling branch a fork-conflict names beside the candidate itself. */
const QUARANTINE_SIBLING_DIGEST_V1 = `0x${'c7'.repeat(32)}` as Digest32V1;

/* ------------------------------------------------------------------ *
 * PROJECTION REBUILD.
 *
 * The fixture keeps `projectionFor`/`canonicalBytesFor` private, so they are
 * reproduced here. THAT REPRODUCTION IS ITSELF A RISK and is not taken on
 * trust: `rebuildProjectionForHeadV1` re-derives the three values the head
 * COMMITS to (byte count, quad count, merkle content digest) and refuses any
 * head whose commitments the rebuild cannot reproduce. A head is the witness
 * for its own projection, so a faithful rebuild is checkable without reaching
 * into the fixture.
 *
 * A ROTATION MOVES THE ROOT SUBJECT, so the projection MUST be rebuilt per
 * head. Reusing the genesis fixture's projection for a rotated head is the
 * quiet failure this whole module is arranged around: both are 790 bytes and
 * both 6 quads, so the issuer's byte-count gate (:677) passes and only a
 * byte-for-byte compare separates them.
 * ------------------------------------------------------------------ */
export function projectionForHeadV1(
  head: Pick<AgentProfileActiveHeadObjectV1,
    'rootSubject' | 'peerId' | 'peerPublicKey' | 'evmIssuer'>,
): readonly Readonly<Quad>[] {
  return [
    {
      subject: head.rootSubject,
      predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
      object: 'https://dkg.network/ontology#Agent',
      graph: '',
    },
    ...agentProfileIdentityProjectionV1(head),
    {
      subject: head.rootSubject,
      predicate: 'https://schema.org/description',
      object: '"b"',
      graph: '',
    },
    { subject: head.rootSubject, predicate: 'https://schema.org/name', object: '"a"', graph: '' },
  ].sort((left, right) => Buffer.compare(
    tripleContentV10(left.subject, left.predicate, left.object),
    tripleContentV10(right.subject, right.predicate, right.object),
  ));
}

export function canonicalBytesForProjectionV1(
  quads: readonly Readonly<{ subject: string; predicate: string; object: string }>[],
): Uint8Array {
  return new TextEncoder().encode(quads.map((quad) =>
    `${new TextDecoder().decode(tripleContentV10(quad.subject, quad.predicate, quad.object))}\n`)
    .join(''));
}

export function contentDigestForProjectionV1(
  quads: readonly Readonly<{ subject: string; predicate: string; object: string }>[],
): string {
  const leaves = quads.map((quad) =>
    keccak256(tripleContentV10(quad.subject, quad.predicate, quad.object)));
  return `0x${Buffer.from(V10MerkleTree.computeKARoot(
    new V10MerkleTree(leaves).root,
    SENTINEL_NO_PRIVATE_V10,
  )).toString('hex')}`;
}

export interface ProjectionRebuildV1 {
  readonly canonicalProjectionBytes: Uint8Array;
  readonly projectionQuads: readonly Readonly<Quad>[];
  readonly ownedSubjectTable: readonly string[];
}

/**
 * Rebuilds the projection a head commits to, and REFUSES to hand back one whose
 * commitments it cannot reproduce.
 *
 * This is the discriminator between "storage refused the state" and "the driver
 * supplied the wrong artifact". Without it a swapped projection reaches the
 * issuer and comes back as a refusal that reads exactly like a finding.
 */
export function rebuildProjectionForHeadV1(
  head: AgentProfileActiveHeadObjectV1,
): ProjectionRebuildV1 {
  const projectionQuads = projectionForHeadV1(head);
  const canonicalProjectionBytes = canonicalBytesForProjectionV1(projectionQuads);
  const mismatches: string[] = [];
  if (String(canonicalProjectionBytes.byteLength) !== head.projectionBytes) {
    mismatches.push(
      `projectionBytes ${canonicalProjectionBytes.byteLength} != committed ${head.projectionBytes}`,
    );
  }
  if (String(projectionQuads.length) !== head.projectionQuads) {
    mismatches.push(
      `projectionQuads ${projectionQuads.length} != committed ${head.projectionQuads}`,
    );
  }
  const contentDigest = contentDigestForProjectionV1(projectionQuads);
  if (contentDigest !== head.contentDigest) {
    mismatches.push(`contentDigest ${contentDigest} != committed ${head.contentDigest}`);
  }
  if (mismatches.length > 0) {
    throw new Error(`driver projection rebuild is unfaithful: ${mismatches.join('; ')}`);
  }
  return {
    canonicalProjectionBytes,
    projectionQuads,
    ownedSubjectTable: [head.rootSubject],
  };
}

/* ------------------------------------------------------------------ *
 * OUTCOMES.
 *
 * The derivation union (:145-160) has SIX variants, three of them carrying a
 * payload, and `root-collision` carries `claimSubjects` -- NOT a reason. Its key
 * shape is structurally different from `deferred` and `capacity-exhausted`, so
 * it gets its own variant here rather than being flattened into a
 * (verdict, reason) pair it cannot fill.
 * ------------------------------------------------------------------ */
export type StorageDriveOutcomeV1 =
  | { readonly kind: 'derivation'; readonly verdict: 'ready' | 'already-applied' | 'stale' }
  | {
      readonly kind: 'derivation';
      readonly verdict: 'deferred' | 'capacity-exhausted';
      readonly reason: string;
    }
  | {
      readonly kind: 'derivation';
      readonly verdict: 'root-collision';
      readonly claimSubjects: readonly string[];
    }
  /** The registry refused to issue or consume: no derivation ever ran. */
  | { readonly kind: 'refused'; readonly stage: 'issue' | 'consume'; readonly message: string }
  /** The driver could not build the snapshot the form names. */
  | { readonly kind: 'snapshot-refused'; readonly message: string }
  /** A throw is NOT a verdict; the entry's contract is to RETURN one. */
  | { readonly kind: 'threw'; readonly message: string };

export type StorageAppliedStatusV1 = 'active' | 'quarantined' | 'tombstone' | 'dirty';

export type StorageSnapshotFormV1 =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly appliedStatus: StorageAppliedStatusV1 };

export type StorageOperationV1 = 'active' | 'quarantine' | 'tombstone';

export interface StorageDriveInputV1 {
  /** The candidate head, exactly as the shared head builder produced it. */
  readonly candidate: AgentProfileHeadObjectV1;
  /** Its minted verified authority summary; a factory-only capability. */
  readonly summary: AgentProfileVerifiedAuthoritySummaryV1;
  readonly operation: StorageOperationV1;
  readonly snapshotForm: StorageSnapshotFormV1;
  /**
   * CONTROL HOOK. Overrides the rebuilt projection artifacts. Production cells
   * never set it; it exists so a control can prove that a swapped projection is
   * caught, and by WHAT.
   */
  readonly projectionOverride?: ProjectionRebuildV1;
  /**
   * CONTROL HOOK. Replaces the observed root-claim rows. Production cells never
   * set it; it exists so the `root-collision` and `root-state-changed` arms of
   * the outcome mapping can be shown LIVE rather than merely unobserved.
   */
  readonly observedRootClaimQuadsOverride?: readonly Readonly<Quad>[];
}

/* ------------------------------------------------------------------ *
 * THE CURRENT ROW.
 *
 * Every 'present' snapshot is the materialisation of the accepted CURRENT head,
 * derived cold against an absent snapshot through the same exported entry. It is
 * built ONCE: it is the referent axes B, D, E, F and G are measured against, and
 * rebuilding it per cell would let the referent drift between rows.
 * ------------------------------------------------------------------ */
export interface StorageDriverV1 {
  readonly currentReady: SystemRecordActiveReplacementReadyV1;
  readonly currentSummary: AgentProfileVerifiedAuthoritySummaryV1;
  readonly stableKeyHash: string;
  buildSnapshot(form: StorageSnapshotFormV1): {
    readonly snapshot: SystemRecordAppliedSnapshotV1;
    readonly observedRootClaimQuads: readonly Readonly<Quad>[];
  };
  drive(input: StorageDriveInputV1): StorageDriveOutcomeV1;
}

/**
 * THE ANCESTRY AND TRANSITIONS EVERY MINT IN THIS DRIVER RESOLVES AGAINST.
 *
 * Shared CONSTANTS, not copied literals, and that is what makes the two halves
 * of the diff comparable. A summary carries the transition lineage and the root
 * history that every axis-D and axis-G verdict is measured against, so a driver
 * that walked a DIFFERENT graph would produce a diff between two different
 * questions while every row still looked well formed. The core half's minter is
 * module-private, so the walk is reproduced -- but it is reproduced over
 * `CORE_CHAIN_V1`, `CORE_CURRENT_HEAD_V1`, `CORE_FORK_CONFLICT_HEADS_V1`,
 * `CORE_EQUIVOCATING_TRANSITION_V1` and `CORE_FORK_RESOLUTION_V1`, which are the
 * very objects the core half walks. Nothing here is a second copy of the data.
 */
function mintAncestryV1(): readonly AgentProfileHeadObjectV1[] {
  return [
    CORE_CURRENT_HEAD_V1,
    CORE_CHAIN_V1.base,
    ...CORE_CHAIN_V1.ancestors,
    ...CORE_FORK_CONFLICT_HEADS_V1,
  ];
}

/**
 * Mints the verified authority summary for one head, or refuses with the
 * closure builder's OWN message.
 *
 * The refusal is a construction result, never a swallowed skip: where the
 * builder will not close over a head there is no storage verdict to compare, and
 * the join records that as a NAMED non-comparability rather than as a gap.
 */
export async function mintStorageSummaryForHeadV1(
  candidate: AgentProfileHeadObjectV1,
): Promise<
  | { readonly minted: true; readonly summary: AgentProfileVerifiedAuthoritySummaryV1 }
  | { readonly minted: false; readonly message: string }
> {
  const ancestry = mintAncestryV1();
  const transitions = [...CORE_CHAIN_V1.transitions, CORE_EQUIVOCATING_TRANSITION_V1];
  try {
    if ((candidate as { state: string }).state === 'tombstone') {
      const closure = await mintAgentProfileTombstoneClosureV1({
        tombstone: candidate,
        predecessor: CORE_CURRENT_HEAD_V1,
        ownedSubjectTable: [CORE_CURRENT_HEAD_V1.rootSubject],
        ancestors: ancestry,
        transitions,
      } as never);
      return {
        minted: true,
        summary: closure.authoritySummary as AgentProfileVerifiedAuthoritySummaryV1,
      };
    }
    const artifacts = buildSystemRecordClosureArtifactsV1(
      [candidate, ...ancestry],
      CORE_FORK_RESOLUTION_V1,
      transitions,
    );
    const closure = await buildAgentProfileVerificationClosureV1(
      computeAgentProfileHeadObjectDigestV1(candidate as never),
      systemRecordClosureResolveOptionsV1(artifacts, TERMINAL_FIXTURE_NOW_MS_V1) as never,
    );
    return {
      minted: true,
      summary: closure.authoritySummary as AgentProfileVerifiedAuthoritySummaryV1,
    };
  } catch (error) {
    return { minted: false, message: messageOf(error) };
  }
}

/** The same mint, for a head the caller has already established will close. */
export async function requireStorageSummaryForHeadV1(
  candidate: AgentProfileHeadObjectV1,
): Promise<AgentProfileVerifiedAuthoritySummaryV1> {
  const mint = await mintStorageSummaryForHeadV1(candidate);
  if (!mint.minted) {
    throw new Error(`no verified authority summary for this head: ${mint.message}`);
  }
  return mint.summary;
}

/** The conflict evidence a quarantine issue must carry for THIS candidate. */
export function quarantineEvidenceForHeadV1(
  head: AgentProfileActiveHeadObjectV1,
): AgentProfileConflictEvidenceV1 {
  // The issuer (:783-788) demands a fork entry naming the candidate's OWN
  // authority sequence, its OWN version and its OWN digest. Anything else is
  // refused as evidence that does not bind the frontier -- a refusal the driver
  // would have manufactured.
  const digests = Object.freeze([
    computeAgentProfileHeadObjectDigestV1(head),
    QUARANTINE_SIBLING_DIGEST_V1,
  ].sort()) as readonly Digest32V1[];
  return Object.freeze({
    objectType: 'conflict-evidence',
    kind: 'agents',
    networkId: head.networkId,
    peerId: head.peerId,
    entries: Object.freeze([Object.freeze({
      type: 'fork',
      authoritySequence: head.authoritySequence,
      version: head.version,
      objectDigests: digests,
    })]),
  }) as AgentProfileConflictEvidenceV1;
}

const EPOCH_QUAD_V1 = Object.freeze({
  subject: systemRecordEpochSubjectV1(SYSTEM_RECORD_FIXTURE_NETWORK),
  predicate: SYSTEM_RECORD_V1_PREDICATES.materializationEpoch,
  object: `"${STORAGE_LANE_BINDING_V1.materializationEpoch}"`,
  graph: SYSTEM_RECORD_V1_STATE_GRAPH,
});

/**
 * Builds the driver: mints the current head's summary, materialises the current
 * row, and returns the closure that evaluates cells against it.
 */
export async function prepareStorageDriverV1(): Promise<StorageDriverV1> {
  const currentSummary = await requireStorageSummaryForHeadV1(CORE_CURRENT_HEAD_V1);
  const stableKeyHash = computeSystemRecordStableKeyHashV1(
    SYSTEM_RECORD_FIXTURE_NETWORK,
    CORE_CURRENT_HEAD_V1.peerId,
  );
  const absent = decodeSystemRecordAppliedSnapshotV1({
    networkId: SYSTEM_RECORD_FIXTURE_NETWORK,
    stableKeyHash,
    materializationEpoch: STORAGE_LANE_BINDING_V1.materializationEpoch,
    quads: [EPOCH_QUAD_V1],
  });

  const registry = createSystemRecordVerifiedReplacementRegistryV1();
  const rebuilt = rebuildProjectionForHeadV1(CORE_CURRENT_HEAD_V1);
  const facts = registry.consumer.consume(
    registry.issuer.issueCandidate({
      operation: 'active',
      ...STORAGE_LANE_BINDING_V1,
      admittedDeadlineMs: ADMITTED_DEADLINE_MS_V1,
      head: structuredClone(CORE_CURRENT_HEAD_V1) as never,
      verifiedAuthoritySummary: currentSummary,
      canonicalProjectionBytes: new Uint8Array(rebuilt.canonicalProjectionBytes),
      projectionQuads: structuredClone(rebuilt.projectionQuads) as never,
      ownedSubjectTable: [...rebuilt.ownedSubjectTable] as never,
    } as never),
    STORAGE_LANE_BINDING_V1 as never,
  );
  const derived = deriveSystemRecordReplacementV1({
    facts,
    snapshot: absent,
    observedRootClaimQuads: [],
  });
  registry.consumer.release(facts);
  if (derived.outcome !== 'ready') {
    // The referent every present-snapshot cell is measured against. If it did
    // not materialise, every such cell would be measured against nothing.
    throw new Error(`current row did not materialise: ${JSON.stringify(derived)}`);
  }
  const currentReady = derived;

  function buildSnapshot(form: StorageSnapshotFormV1) {
    if (form.kind === 'absent') {
      return { snapshot: absent, observedRootClaimQuads: Object.freeze([]) };
    }
    const base = currentReady.plan.next.appliedState;
    let appliedState: SystemRecordAppliedStatePresentV1;
    let ownedSubjectTable = currentReady.plan.next.ownedSubjectTable;
    let capacityState = currentReady.plan.next.capacityState;
    if (form.appliedStatus === 'active') {
      appliedState = base;
    } else if (form.appliedStatus === 'quarantined') {
      appliedState = {
        ...base,
        status: 'quarantined',
        conflictSidecarIntentOperation: 'deferred',
        conflictSidecarIntentEvidenceDigest: `0x${'ee'.repeat(32)}`,
        conflictSidecarIntentStateRevision: base.stateRevision,
      } as SystemRecordAppliedStatePresentV1;
    } else if (form.appliedStatus === 'dirty') {
      appliedState = { ...base, status: 'dirty' } as SystemRecordAppliedStatePresentV1;
    } else {
      // A TOMBSTONE ROW COMMITS THE CANONICAL EMPTY PROJECTION AND TABLE.
      // Inheriting the active plan's nonempty table (:338-340) would build a row
      // the applied-state codec refuses -- a snapshot failure the driver would
      // have caused, wearing the shape of a storage refusal.
      ownedSubjectTable = Object.freeze([]) as never;
      appliedState = {
        ...base,
        status: 'tombstone',
        projectionDigest: SYSTEM_RECORD_EMPTY_PROJECTION_DIGEST_V1,
        projectionBytes: '0',
        projectionQuads: '0',
        ownedSubjectTableDigest: EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
        ownedSubjectCount: '0',
        ownedSubjectTableBytes: '0',
        accountedBytes: '65536',
      } as SystemRecordAppliedStatePresentV1;
      // The three counters are branded decimal-u64 strings, so the zeroes are
      // cast at the object rather than field by field. The cast asserts a
      // FORMAT the codec re-validates on decode, not a value it will trust.
      capacityState = {
        ...capacityState, tableBytes: '0', projectionBytes: '0', projectionQuads: '0',
      } as typeof capacityState;
    }
    const appliedStateDigest = computeSystemRecordAppliedStateDigestV1(appliedState);
    const receipt: SystemRecordMaterializationReceiptV1 = {
      ...currentReady.plan.next.receipt,
      appliedStateDigest,
      headDigest: appliedState.headDigest,
      stateRevision: appliedState.stateRevision,
    };
    const quads = buildSystemRecordReservedStateQuadsV1({
      appliedState,
      headVersion: currentReady.plan.next.headVersion,
      ownedSubjectTable,
      rootClaimSet: currentReady.plan.next.rootClaimSet,
      capacityState,
      receipt,
    });
    return {
      snapshot: decodeSystemRecordAppliedSnapshotV1({
        networkId: SYSTEM_RECORD_FIXTURE_NETWORK,
        stableKeyHash,
        materializationEpoch: STORAGE_LANE_BINDING_V1.materializationEpoch,
        // The root-claim rows are DELIBERATELY excluded: the decoder rebuilds
        // `expectedRootClaimQuads` from the record rows, and the derivation
        // compares that to `observedRootClaimQuads` supplied separately.
        quads: [...quads.record, ...quads.capacity, ...quads.epoch, ...quads.receipt],
      }),
      observedRootClaimQuads: currentReady.plan.next.rootClaimQuads,
    };
  }

  function drive(input: StorageDriveInputV1): StorageDriveOutcomeV1 {
    let snapshot: SystemRecordAppliedSnapshotV1;
    let observedRootClaimQuads: readonly Readonly<Quad>[];
    try {
      const built = buildSnapshot(input.snapshotForm);
      snapshot = built.snapshot;
      observedRootClaimQuads = input.observedRootClaimQuadsOverride
        ?? built.observedRootClaimQuads;
    } catch (error) {
      return { kind: 'snapshot-refused', message: messageOf(error) };
    }

    // FRESH REGISTRY PER EVALUATION. A handle is single-use and facts are
    // WeakSet-branded to their registry; sharing one would couple cells.
    const registry = createSystemRecordVerifiedReplacementRegistryV1();
    let facts: ReturnType<typeof registry.consumer.consume> | undefined;
    let handle: unknown;
    try {
      handle = registry.issuer.issueCandidate(buildIssueV1(input) as never);
    } catch (error) {
      return { kind: 'refused', stage: 'issue', message: messageOf(error) };
    }
    try {
      // SEVEN-key lane binding, never the larger issue object.
      facts = registry.consumer.consume(handle, STORAGE_LANE_BINDING_V1 as never);
    } catch (error) {
      return { kind: 'refused', stage: 'consume', message: messageOf(error) };
    }
    try {
      const derived = deriveSystemRecordReplacementV1({
        facts,
        snapshot,
        observedRootClaimQuads,
      });
      switch (derived.outcome) {
        case 'ready':
        case 'already-applied':
        case 'stale':
          return { kind: 'derivation', verdict: derived.outcome };
        case 'root-collision':
          return {
            kind: 'derivation',
            verdict: 'root-collision',
            claimSubjects: derived.claimSubjects,
          };
        default:
          return { kind: 'derivation', verdict: derived.outcome, reason: derived.reason };
      }
    } catch (error) {
      return { kind: 'threw', message: messageOf(error) };
    } finally {
      try {
        if (facts !== undefined) registry.consumer.release(facts);
      } catch { /* a released reservation is not a measurement */ }
    }
  }

  return { currentReady, currentSummary, stableKeyHash, buildSnapshot, drive };
}

/**
 * The issue object `issueCandidate` takes. MEASURED key counts, not assumed:
 * 14 for 'active' (the 13-key `SystemRecordActiveReplacementIssueV1` plus the
 * `operation` tag), 17 for 'quarantine' (+ conflictEvidenceDigest,
 * canonicalConflictEvidenceBytes, terminalTransitionConflict), 12 for
 * 'tombstone' (7 lane keys + admittedDeadlineMs + summary + operation + head +
 * deletionOwnedSubjectTable).
 *
 * The projection travels with the HEAD, rebuilt from it, never inherited from
 * another head.
 */
export function buildStorageIssueV1(input: StorageDriveInputV1): Record<string, unknown> {
  return buildIssueV1(input);
}

function buildIssueV1(input: StorageDriveInputV1): Record<string, unknown> {
  const common = {
    ...STORAGE_LANE_BINDING_V1,
    admittedDeadlineMs: ADMITTED_DEADLINE_MS_V1,
    verifiedAuthoritySummary: input.summary,
  };
  if (input.operation === 'tombstone') {
    const predecessor = (input.summary as {
      tombstonePredecessor?: { ownedSubjectTableDigest: string; rootSubject: string };
    }).tombstonePredecessor;
    return {
      operation: 'tombstone',
      ...common,
      head: structuredClone(input.candidate),
      // The deletion table must reproduce the PREDECESSOR's committed table
      // digest (:857-860), not the tombstone's own -- a tombstone commits the
      // empty one.
      deletionOwnedSubjectTable: predecessor === undefined ? [] : [predecessor.rootSubject],
    };
  }
  const head = input.candidate as AgentProfileActiveHeadObjectV1;
  const projection = input.projectionOverride ?? rebuildProjectionForHeadV1(head);
  const active = {
    ...common,
    head: structuredClone(head),
    canonicalProjectionBytes: new Uint8Array(projection.canonicalProjectionBytes),
    projectionQuads: structuredClone(projection.projectionQuads),
    ownedSubjectTable: [...projection.ownedSubjectTable],
  };
  if (input.operation === 'active') return { operation: 'active', ...active };
  const evidence = quarantineEvidenceForHeadV1(head);
  return {
    operation: 'quarantine',
    ...active,
    conflictEvidenceDigest: computeAgentProfileConflictEvidenceDigestV1(evidence),
    canonicalConflictEvidenceBytes: canonicalizeAgentProfileConflictEvidenceV1(evidence),
    terminalTransitionConflict: false,
  };
}

function messageOf(error: unknown): string {
  return String((error as { message?: string } | undefined)?.message ?? error);
}
