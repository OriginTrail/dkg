import type {
  WalDeleteAuthorizationDecisionV1,
  WalDeleteAuthorizationInputV1,
  WalRetentionSemanticCoreV1,
  WalSnapshotConflictValidationInputV1,
  WalSnapshotEntryValidationInputV1,
} from '@origintrail-official/dkg-wal/retention';
import {
  verifySnapshotBaselineV1,
  type VerifySnapshotBaselineInputV1,
} from '@origintrail-official/dkg-wal/retention';
import { bytesEqualV1 } from '@origintrail-official/dkg-wal/rdf';
import type { DkgEpochSnapshotValidation } from '@origintrail-official/dkg-wal/authority';
import {
  dkgSemanticCore,
  type DkgSemanticCore,
  type DkgSemanticDriver,
} from '../semantic/dkg-semantic-core.js';

type RetentionDriver = Extract<DkgSemanticDriver, 'legacy-sync' | 'wal-sync'>;

export interface DkgWalRetentionSemanticAdapterOptionsV1 {
  /** Existing semantic implementation shared with the legacy sync driver. */
  readonly implementation: WalRetentionSemanticCoreV1;
  readonly driver: RetentionDriver;
  readonly semanticCore?: DkgSemanticCore;
}

/**
 * Thin observability bridge. It forwards every decision to the same DKG
 * semantic implementation and contains no WAL-specific deletion, expiry,
 * snapshot, SWM/VM, verified-memory, or cryptographic behavior.
 */
export class DkgWalRetentionSemanticAdapterV1 implements WalRetentionSemanticCoreV1 {
  private readonly semanticCore: DkgSemanticCore;

  constructor(private readonly options: DkgWalRetentionSemanticAdapterOptionsV1) {
    this.semanticCore = options.semanticCore ?? dkgSemanticCore;
  }

  authorizeDelete(
    input: WalDeleteAuthorizationInputV1,
  ): Promise<WalDeleteAuthorizationDecisionV1> {
    return this.semanticCore.invokeWalRetentionSemanticEntryPoint(
      this.options.driver,
      'wal-delete-expiry-authorization',
      () => this.options.implementation.authorizeDelete(input),
    );
  }

  validateSnapshotEntry(input: WalSnapshotEntryValidationInputV1): Promise<boolean> {
    return this.semanticCore.invokeWalRetentionSemanticEntryPoint(
      this.options.driver,
      'wal-snapshot-baseline-entry-validation',
      () => this.options.implementation.validateSnapshotEntry(input),
    );
  }

  validateSnapshotConflict(input: WalSnapshotConflictValidationInputV1): Promise<boolean> {
    return this.semanticCore.invokeWalRetentionSemanticEntryPoint(
      this.options.driver,
      'wal-snapshot-baseline-conflict-validation',
      () => this.options.implementation.validateSnapshotConflict(input),
    );
  }
}

export function createDkgWalRetentionSemanticAdapterV1(
  options: DkgWalRetentionSemanticAdapterOptionsV1,
): DkgWalRetentionSemanticAdapterV1 {
  return new DkgWalRetentionSemanticAdapterV1(options);
}

export interface DkgWalEpochSnapshotValidatorOptionsV1 {
  readonly semanticCore: WalRetentionSemanticCoreV1;
  /** Resolve only local complete bytes and current authenticated DKG context. */
  readonly resolve: (
    input: DkgEpochSnapshotValidation,
  ) => Promise<Omit<VerifySnapshotBaselineInputV1, 'semanticCore'>>;
}

/**
 * Concrete CurrentDkgWalAuthorityAdapter.validateEpochSnapshot callback. It
 * binds the authority checkpoint to the complete snapshot verifier and fails
 * closed; the shared semantic core still validates every entry/conflict.
 */
export function createDkgWalEpochSnapshotValidatorV1(
  options: DkgWalEpochSnapshotValidatorOptionsV1,
): (input: DkgEpochSnapshotValidation) => Promise<boolean> {
  return async input => {
    try {
      const verified = await verifySnapshotBaselineV1({
        ...await options.resolve(input),
        semanticCore: options.semanticCore,
      });
      const checkpoint = input.checkpoint;
      const manifest = verified.manifest;
      return bytesEqualV1(verified.snapshotObjectId, input.baselineSnapshotObjectId)
        && checkpoint[10] !== null
        && bytesEqualV1(checkpoint[10], verified.snapshotObjectId)
        && bytesEqualV1(checkpoint[1], manifest[1])
        && bytesEqualV1(checkpoint[2], manifest[2])
        && checkpoint[3] === manifest[3]
        && checkpoint[4] === 0n
        && checkpoint[7] === 1n
        && checkpoint[8] === 0n
        && checkpoint[9] === null
        && checkpoint[11] === manifest[8];
    } catch {
      return false;
    }
  };
}
