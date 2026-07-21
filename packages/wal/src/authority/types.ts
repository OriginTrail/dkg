import type { ProtocolTuple } from '../protocol/schema.js';

export type WalAuthorityReadiness =
  | 'complete'
  | 'known-incomplete'
  | 'unknown-freshness'
  | 'blocked';

export type WalAuthorityReason =
  | 'COMPLETE'
  | 'NO_MEMBERSHIP'
  | 'NO_VECTOR'
  | 'AUTHORITY_EXPIRED'
  | 'AUTHORITY_REVOKED'
  | 'AUTHORITY_FORK'
  | 'VECTOR_EXPIRED'
  | 'VECTOR_FORK'
  | 'ROLLBACK_GUARD_UNAVAILABLE'
  | 'WRONG_COLLECTION'
  | 'WRONG_VIEW'
  | 'WRONG_POLICY_EPOCH'
  | 'WRONG_KEY_EPOCH'
  | 'MISSING_POLICY_OBJECT'
  | 'MISSING_CHECKPOINTS'
  | 'CHECKPOINT_EQUIVOCATION'
  | 'VECTOR_MEMBERSHIP_MISMATCH';

export interface WalAuthorityCompleteness {
  status: WalAuthorityReadiness;
  reason: WalAuthorityReason;
  collectionId: Uint8Array;
  namespaceId: Uint8Array;
  membershipCheckpointId?: Uint8Array;
  vectorId?: Uint8Array;
  missingCheckpointIds: readonly Uint8Array[];
  privateMetadataAllowed: boolean;
}

export interface WalAuthorityView {
  collectionKey: ProtocolTuple<'ReplicationCollectionKeyV1'>;
  viewKey: ProtocolTuple<'ReplicationViewKeyV1'>;
}

export interface AcceptAuthorCheckpointInput {
  collectionId: Uint8Array;
  canonicalBytes: Uint8Array;
  objectIds: readonly Uint8Array[];
  acceptedAtMs?: number;
}

export interface PrivateDisclosureRequest {
  view: WalAuthorityView;
  requesterAgentAddress: Uint8Array;
  transportPeerId: Uint8Array;
  delegation?: unknown;
}

export interface DkgMembershipValidation {
  membershipCheckpointId: Uint8Array;
  membership: ProtocolTuple<'MembershipCheckpointV1'>;
}

export interface DkgOpenAuthorValidation {
  collectionId: Uint8Array;
  namespaceId: Uint8Array;
  writerId: Uint8Array;
  checkpoint: ProtocolTuple<'AuthorCheckpointV1'>;
  finalizedChainFrontier: ProtocolTuple<'ChainFrontierV1'> | null;
}

export interface DkgEpochSnapshotValidation {
  collectionId: Uint8Array;
  checkpoint: ProtocolTuple<'AuthorCheckpointV1'>;
  baselineSnapshotObjectId: Uint8Array;
}

export interface DkgPrivateDisclosureValidation {
  collectionId: Uint8Array;
  namespaceId: Uint8Array;
  membershipCheckpointId: Uint8Array;
  memberAgentAddress: Uint8Array;
  transportPeerId: Uint8Array;
  delegation?: unknown;
  nowMs: number;
}

/**
 * Adapter boundary to current DKG authority. Generic WAL code never derives
 * membership, delegation, chain authorization, or policy authority itself.
 */
export interface DkgWalAuthorityAdapter {
  validateMembership(input: DkgMembershipValidation): boolean | Promise<boolean>;
  validateOpenAuthor(input: DkgOpenAuthorValidation): boolean | Promise<boolean>;
  validateEpochSnapshot(input: DkgEpochSnapshotValidation): boolean | Promise<boolean>;
  authorizePrivateDisclosure(input: DkgPrivateDisclosureValidation): boolean | Promise<boolean>;
  isWalObjectAdmitted(objectId: Uint8Array): boolean | Promise<boolean>;
}

export interface RollbackCohortMinimum {
  collectionId: Uint8Array;
  vectorEpoch: bigint;
  vectorNumber: bigint;
  vectorId: Uint8Array;
}

export interface WalAuthorityLifecycleOptions {
  networkId: string;
  genesisCuratorAuthoritySetId: Uint8Array;
  genesisNetworkAuthoritySetId: Uint8Array;
  root: string;
  rollbackStore: {
    rollbackProtectionStatus(): { state: 'available' | 'blocked'; reason?: string };
    getRollbackHighWater(collectionId: Uint8Array): {
      collectionId: Uint8Array;
      vectorEpoch: bigint;
      vectorNumber: bigint;
      vectorId: Uint8Array;
      updatedAtMs: number;
    } | null;
    setRollbackHighWater(input: {
      collectionId: Uint8Array;
      vectorEpoch: bigint;
      vectorNumber: bigint;
      vectorId: Uint8Array;
      updatedAtMs: number;
    }): 'advanced' | 'unchanged';
    installVerifiedRollbackRecovery(input: {
      collectionId: Uint8Array;
      vectorEpoch: bigint;
      vectorNumber: bigint;
      vectorId: Uint8Array;
      updatedAtMs: number;
    }): void;
  };
  adapter: DkgWalAuthorityAdapter;
  clockSkewMs?: number;
  maximumAuthorsPerVector?: number;
  now?: () => number;
}
