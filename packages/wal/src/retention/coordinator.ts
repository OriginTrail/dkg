import type { WalControlStore } from '../control/store.js';
import { encodeProtocolTuple } from '../protocol/codec.js';
import type { ProtocolTuple } from '../protocol/schema.js';
import { bytesEqualV1 } from '../rdf/keys.js';
import { walObjectId } from '../reconciliation/ids.js';
import type {
  PackedWalObjectStore,
  PackedWalObjectStoreGcPoint,
  PackedWalObjectStoreGcResult,
} from '../store/packed-store.js';
import { retentionError } from './errors.js';
import { verifySnapshotCustodyForGcV1 } from './custody.js';
import type {
  SnapshotCustodianMembershipDecisionV1,
  VerifiedSnapshotBaselineV1,
  VerifiedSnapshotCustodyV1,
} from './types.js';

/**
 * Durable orchestrator for the already-verified retention policy. It never
 * decides DKG membership, authorization, vector validity, or snapshot state;
 * those inputs come from the current authority/semantic implementations.
 */
export class WalRetentionCoordinatorV1 {
  constructor(private readonly dependencies: {
    readonly control: WalControlStore;
    readonly packed: PackedWalObjectStore;
  }) {}

  /**
   * Install only the output of the complete snapshot verifier. This is the
   * durable below-floor baseline boundary; reconciliation must not request old
   * deltas until this transition succeeds.
   */
  async installVerifiedBaseline(input: {
    readonly verified: VerifiedSnapshotBaselineV1;
    readonly graceStartedAtMs: number;
    readonly retentionGraceMs: number;
    readonly updatedAtMs: number;
  }): Promise<'stored' | 'replay'> {
    if (!Number.isSafeInteger(input.retentionGraceMs) || input.retentionGraceMs < 0) {
      retentionError('WAL_RETENTION_INVALID', 'retentionGraceMs must be a non-negative safe integer');
    }
    const manifest = input.verified.manifest;
    return this.dependencies.control.installRetentionEpoch({
      snapshotObjectId: input.verified.snapshotObjectId,
      namespaceId: manifest[1],
      writerId: manifest[2],
      coveredWriterEpoch: manifest[4],
      newWriterEpoch: manifest[3],
      coveredCheckpointId: input.verified.coveredCheckpointId,
      compactionFloor: manifest[8],
      graceStartedAtMs: input.graceStartedAtMs,
      graceEndsAtMs: input.graceStartedAtMs + input.retentionGraceMs,
      updatedAtMs: input.updatedAtMs,
    });
  }

  async persistCustodyReceipts(
    receipts: readonly ProtocolTuple<'SnapshotCustodyReceiptV1'>[],
    recordedAtMs: number,
  ): Promise<readonly Uint8Array[]> {
    const ids: Uint8Array[] = [];
    for (const receipt of receipts) {
      const persisted = await this.dependencies.control.recordRetentionCustodyReceipt(
        encodeProtocolTuple('SnapshotCustodyReceiptV1', receipt),
        recordedAtMs,
      );
      ids.push(persisted.receiptId);
    }
    return ids;
  }

  /** Freshly re-evaluate receipts and atomically authorize the exact floor. */
  async authorizeServingGc(input: {
    readonly snapshotObjectId: Uint8Array;
    readonly authorAddress: Uint8Array;
    readonly currentMembershipCheckpointId: Uint8Array;
    readonly receipts: readonly ProtocolTuple<'SnapshotCustodyReceiptV1'>[];
    readonly minimumAdditionalCustodians?: number;
    readonly graceStartedAtMs: bigint;
    readonly retentionGraceMs: bigint;
    readonly evaluatedAtMs: number;
    readonly currentVectorId: Uint8Array;
    readonly coveredObjectIds: readonly Uint8Array[];
    readonly validateCurrentVectorBinding: (input: {
      readonly snapshotObjectId: Uint8Array;
      readonly vectorId: Uint8Array;
      readonly namespaceId: Uint8Array;
      readonly writerId: Uint8Array;
      readonly newWriterEpoch: bigint;
    }) => boolean | Promise<boolean>;
    readonly validateCurrentCustodian: (
      receipt: ProtocolTuple<'SnapshotCustodyReceiptV1'>,
    ) => SnapshotCustodianMembershipDecisionV1 | Promise<SnapshotCustodianMembershipDecisionV1>;
  }): Promise<VerifiedSnapshotCustodyV1> {
    const epoch = this.dependencies.control.getRetentionEpoch(input.snapshotObjectId);
    if (
      epoch === null
      || epoch.vectorId === null
      || !bytesEqualV1(epoch.vectorId, input.currentVectorId)
      || !await input.validateCurrentVectorBinding({
        snapshotObjectId: input.snapshotObjectId,
        vectorId: epoch.vectorId,
        namespaceId: epoch.namespaceId,
        writerId: epoch.writerId,
        newWriterEpoch: epoch.newWriterEpoch,
      })
    ) {
      retentionError(
        'WAL_RETENTION_VECTOR_REQUIRED',
        'the current authenticated curator vector must exactly reference the new epoch checkpoint',
      );
    }
    const verified = await verifySnapshotCustodyForGcV1({
      snapshotObjectId: input.snapshotObjectId,
      authorAddress: input.authorAddress,
      currentMembershipCheckpointId: input.currentMembershipCheckpointId,
      receipts: input.receipts,
      minimumAdditionalCustodians: input.minimumAdditionalCustodians,
      graceStartedAtMs: input.graceStartedAtMs,
      retentionGraceMs: input.retentionGraceMs,
      evaluatedAtMs: BigInt(input.evaluatedAtMs),
      newEpochCheckpointVectorBound: true,
      validateCurrentCustodian: input.validateCurrentCustodian,
    });
    const persisted = new Set(
      this.dependencies.control
        .listRetentionCustodyReceipts(input.snapshotObjectId)
        .map(value => Buffer.from(value.receiptId).toString('hex')),
    );
    if (verified.receiptIds.some(value => !persisted.has(Buffer.from(value).toString('hex')))) {
      retentionError(
        'WAL_RETENTION_GC_NOT_AUTHORIZED',
        'freshly verified custody evidence must be durable before floor advance',
      );
    }
    await this.dependencies.control.markRetentionGcEligible({
      snapshotObjectId: input.snapshotObjectId,
      verifiedReceiptIds: verified.receiptIds,
      coveredObjectIds: input.coveredObjectIds,
      evaluatedAtMs: input.evaluatedAtMs,
    });
    return verified;
  }

  /**
   * Retire only the exact durable eligible IDs. Crash after the packed commit
   * is recovered idempotently before the control journal reaches GC_COMPLETE.
   */
  async collectAuthorizedServingGc(input: {
    readonly snapshotObjectId: Uint8Array;
    readonly completedAtMs: number;
    readonly hook?: (point: PackedWalObjectStoreGcPoint) => void | Promise<void>;
  }): Promise<PackedWalObjectStoreGcResult> {
    const epoch = this.dependencies.control.getRetentionEpoch(input.snapshotObjectId);
    if (epoch === null || (epoch.state !== 'GC_ELIGIBLE' && epoch.state !== 'GC_COMPLETE')) {
      retentionError('WAL_RETENTION_GC_NOT_AUTHORIZED', 'snapshot floor has not been authorized for serving GC');
    }
    const objects = this.dependencies.control.listRetentionGcObjects(input.snapshotObjectId);
    if (BigInt(objects.length) !== epoch.compactionFloor) {
      retentionError('WAL_RETENTION_GC_NOT_AUTHORIZED', 'durable GC set does not match the compaction floor');
    }
    const result = await this.dependencies.packed.collectGarbage(
      objects.map(value => walObjectId(value.objectId)),
      input.completedAtMs,
      input.hook,
    );
    await this.dependencies.control.completeRetentionGc({
      snapshotObjectId: input.snapshotObjectId,
      completedAtMs: input.completedAtMs,
    });
    return result;
  }
}
