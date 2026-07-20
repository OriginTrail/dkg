import type { ProtocolTuple } from '../protocol/schema.js';

export const SNAPSHOT_MANIFEST_MEDIA_TYPE_V1 =
  'application/vnd.origintrail.wal-snapshot-manifest+cbor';

export interface WalDeleteAuthorizationInputV1 {
  readonly namespaceId: Uint8Array;
  readonly writerId: Uint8Array;
  readonly mutation: ProtocolTuple<'DkgMutationV1'>;
  readonly policy: ProtocolTuple<'RdfPolicyV1'>;
}

export type WalDeleteAuthorizationDecisionV1 =
  | {
      readonly status: 'accepted';
      readonly evidence: { readonly kind: 'owner' };
    }
  | {
      readonly status: 'accepted';
      readonly evidence: {
        readonly kind: 'curator-vector';
        readonly vectorId: Uint8Array;
        /** Authenticated issuedAtMs from the signed vector. */
        readonly issuedAtMs: bigint;
      };
    }
  | {
      readonly status: 'accepted';
      readonly evidence: {
        readonly kind: 'finalized-chain-frontier';
        readonly frontier: ProtocolTuple<'ChainFrontierV1'>;
        /** Authenticated block timestamp for the finalized block. */
        readonly blockTimestampMs: bigint;
      };
    }
  | { readonly status: 'pending'; readonly reasonCode: string }
  | { readonly status: 'rejected'; readonly reasonCode: string };

export interface WalSnapshotEntryValidationInputV1 {
  readonly namespaceId: Uint8Array;
  readonly writerId: Uint8Array;
  readonly coveredWriterEpoch: bigint;
  readonly entry: ProtocolTuple<'SnapshotEntryV1'>;
  readonly policyObjectId: Uint8Array;
  readonly adapterVersion: bigint;
  readonly chainFrontier: ProtocolTuple<'ChainFrontierV1'> | null;
}

export interface WalSnapshotConflictValidationInputV1 {
  readonly namespaceId: Uint8Array;
  readonly writerId: Uint8Array;
  readonly coveredWriterEpoch: bigint;
  readonly conflict: ProtocolTuple<'SnapshotConflictV1'>;
  readonly policyObjectId: Uint8Array;
  readonly adapterVersion: bigint;
  readonly chainFrontier: ProtocolTuple<'ChainFrontierV1'> | null;
}

/**
 * Existing DKG semantic implementation used by both synchronization drivers.
 * Generic WAL code supplies authenticated inputs and never implements these
 * authorization, tombstone, conflict, SWM/VM, or verified-memory decisions.
 */
export interface WalRetentionSemanticCoreV1 {
  authorizeDelete(
    input: WalDeleteAuthorizationInputV1,
  ): Promise<WalDeleteAuthorizationDecisionV1>;

  validateSnapshotEntry(input: WalSnapshotEntryValidationInputV1): Promise<boolean>;

  validateSnapshotConflict(input: WalSnapshotConflictValidationInputV1): Promise<boolean>;
}

export interface VerifiedSnapshotBaselineV1 {
  readonly snapshotObjectId: Uint8Array;
  readonly snapshotObject: ProtocolTuple<'WalObjectV1'>;
  readonly manifest: ProtocolTuple<'SnapshotManifestV1'>;
  readonly coveredCheckpointId: Uint8Array;
  readonly coveredCheckpoint: ProtocolTuple<'AuthorCheckpointV1'>;
  readonly coveredObjectIds: readonly Uint8Array[];
}

export interface SnapshotCustodianMembershipDecisionV1 {
  readonly current: boolean;
  readonly authorized: boolean;
  readonly peerMatchesAgent: boolean;
  readonly removedOrRevoked: boolean;
}

export interface VerifiedSnapshotCustodyV1 {
  readonly receiptIds: readonly Uint8Array[];
  readonly custodianAgentAddresses: readonly Uint8Array[];
  readonly graceEndsAtMs: bigint;
}

export type BaselineSelectionV1 =
  | { readonly action: 'install-baseline'; readonly snapshotObjectId: Uint8Array }
  | { readonly action: 'reconcile-delta' };
