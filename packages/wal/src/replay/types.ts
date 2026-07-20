import type { ProtocolTuple } from '../protocol/schema.js';

/** Protocol-v1 replay bounds. A signed network policy may lower them. */
export interface WalReplayLimitsV1 {
  readonly maximumObjects: number;
  readonly maximumParentsPerMutation: number;
  readonly maximumTouchedKeysPerMutation: number;
  readonly maximumConflictHeads: number;
  readonly maximumCausalDepth: number;
  readonly maximumRecomputationWork: number;
}

export const WAL_REPLAY_LIMITS_V1: Readonly<WalReplayLimitsV1> = Object.freeze({
  maximumObjects: 1_000_000,
  maximumParentsPerMutation: 64,
  maximumTouchedKeysPerMutation: 4_096,
  maximumConflictHeads: 32,
  maximumCausalDepth: 1_000_000,
  maximumRecomputationWork: 67_108_864,
});

/**
 * An already-admitted DKG mutation extracted from one complete WalObjectV1.
 * Provider identity, arrival time, and wall clock are intentionally absent.
 */
export interface AdmittedWalReplayObjectV1 {
  readonly objectId: Uint8Array;
  readonly namespaceId: Uint8Array;
  readonly writerId: Uint8Array;
  readonly writerEpoch: bigint;
  readonly sequence: bigint;
  readonly mutation: ProtocolTuple<'DkgMutationV1'>;
  /** Exact admitted policy object referenced by mutation.policyObjectId. */
  readonly policy: ProtocolTuple<'RdfPolicyV1'>;
}

export interface WalReplaySemanticStateV1<Projection> {
  readonly stateDigest: Uint8Array;
  /** Opaque shared-core output. packages/wal never inspects it. */
  readonly projection: Projection;
}

export type WalReplaySemanticDecisionV1<Projection> =
  | {
      readonly status: 'accepted';
      readonly state: WalReplaySemanticStateV1<Projection>;
    }
  | {
      readonly status: 'pending';
      readonly reasonCode: string;
    }
  | {
      readonly status: 'rejected';
      readonly reasonCode: string;
    };

export interface WalReplayProtocolCompatibilityV1 {
  readonly compatible: boolean;
  readonly reasons: readonly (
    | 'disjoint-patch-footprints'
    | 'add-only-multi-valued-patch'
    | 'different-policy'
    | 'replace'
    | 'delete-or-resolution'
    | 'tier-or-non-rdf'
    | 'chain-binding-disagreement'
    | 'overlapping-patch-footprints'
  )[];
}

export interface WalReplayTransitionInputV1<Projection> {
  readonly candidate: AdmittedWalReplayObjectV1;
  readonly base: WalReplaySemanticStateV1<Projection>;
  readonly activeBaseHeads: readonly Uint8Array[];
  readonly currentConflictHeads: readonly Uint8Array[];
  readonly resolution: boolean;
}

export interface WalReplayMergeBranchV1<Projection> {
  readonly headId: Uint8Array;
  readonly candidate: AdmittedWalReplayObjectV1;
  readonly state: WalReplaySemanticStateV1<Projection>;
}

export interface WalReplayMergeInputV1<Projection> {
  readonly namespaceId: Uint8Array;
  readonly logicalKey: Uint8Array;
  readonly commonBase: WalReplaySemanticStateV1<Projection>;
  readonly commonBaseHeads: readonly Uint8Array[];
  readonly branches: readonly WalReplayMergeBranchV1<Projection>[];
  readonly compatibility: WalReplayProtocolCompatibilityV1;
}

/**
 * Narrow call boundary implemented by the one DKG semantic core.
 * The replay package supplies schedule/context only and treats every returned
 * projection as opaque.
 */
export interface WalReplaySemanticCoreV1<Projection> {
  initialState(input: {
    readonly namespaceId: Uint8Array;
    readonly logicalKey: Uint8Array;
  }): Promise<WalReplaySemanticStateV1<Projection>>;

  evaluateTransition(
    input: WalReplayTransitionInputV1<Projection>,
  ): Promise<WalReplaySemanticDecisionV1<Projection>>;

  mergeCompatibleBranches(
    input: WalReplayMergeInputV1<Projection>,
  ): Promise<WalReplaySemanticDecisionV1<Projection>>;
}

export interface WalReplayEquivocationEvidenceV1 {
  readonly writerId: Uint8Array;
  readonly writerEpoch: bigint;
  readonly sequence: bigint;
  readonly objectIds: readonly Uint8Array[];
}

export type WalReplayProjectionStatusV1 =
  | 'empty'
  | 'apply'
  | 'merge'
  | 'conflict'
  | 'pending'
  | 'blocked';

export interface WalReplayProjectionV1<Projection> {
  readonly status: WalReplayProjectionStatusV1;
  readonly namespaceId: Uint8Array;
  readonly logicalKey: Uint8Array;
  readonly schedule: readonly Uint8Array[];
  readonly maximalHeads: readonly Uint8Array[];
  readonly activeHeads: readonly Uint8Array[];
  readonly conflictHeads: readonly Uint8Array[];
  readonly pendingHeads: readonly Uint8Array[];
  readonly commonBaseHeads: readonly Uint8Array[];
  readonly activeHeadsDigest: Uint8Array;
  readonly conflictHeadsDigest: Uint8Array;
  readonly state: WalReplaySemanticStateV1<Projection>;
  readonly equivocations: readonly WalReplayEquivocationEvidenceV1[];
}
