import { encodeProtocolTuple } from '../protocol/codec.js';
import { protocolTupleId } from '../protocol/hashes.js';
import { verifySingleSignedProtocolTuple } from '../protocol/signatures.js';
import type { ProtocolTuple } from '../protocol/schema.js';
import { bytesEqualV1 } from '../rdf/keys.js';
import { retentionError } from './errors.js';
import type {
  SnapshotCustodianMembershipDecisionV1,
  VerifiedSnapshotCustodyV1,
} from './types.js';

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

/**
 * Fail-closed GC gate. Receipts are control evidence, never reconciliation
 * atoms. Current membership is re-evaluated for every call so removal,
 * revocation, expiry, or a changed peer binding immediately closes the gate.
 */
export async function verifySnapshotCustodyForGcV1(input: {
  readonly snapshotObjectId: Uint8Array;
  readonly authorAddress: Uint8Array;
  readonly currentMembershipCheckpointId: Uint8Array;
  readonly receipts: readonly ProtocolTuple<'SnapshotCustodyReceiptV1'>[];
  readonly minimumAdditionalCustodians?: number;
  readonly graceStartedAtMs: bigint;
  readonly retentionGraceMs: bigint;
  readonly evaluatedAtMs: bigint;
  readonly newEpochCheckpointVectorBound: boolean;
  readonly validateCurrentCustodian: (
    receipt: ProtocolTuple<'SnapshotCustodyReceiptV1'>,
  ) => SnapshotCustodianMembershipDecisionV1 | Promise<SnapshotCustodianMembershipDecisionV1>;
}): Promise<VerifiedSnapshotCustodyV1> {
  const minimum = input.minimumAdditionalCustodians ?? 2;
  if (!Number.isSafeInteger(minimum) || minimum < 1) {
    retentionError('WAL_RETENTION_INVALID', 'minimumAdditionalCustodians must be a positive safe integer');
  }
  if (input.retentionGraceMs < 0n || input.graceStartedAtMs < 0n || input.evaluatedAtMs < 0n) {
    retentionError('WAL_RETENTION_INVALID', 'retention times must be non-negative');
  }
  if (!input.newEpochCheckpointVectorBound) {
    retentionError('WAL_RETENTION_VECTOR_REQUIRED', 'a valid current curator vector must reference the new epoch');
  }
  const graceEndsAtMs = input.graceStartedAtMs + input.retentionGraceMs;
  if (input.evaluatedAtMs < graceEndsAtMs) {
    retentionError('WAL_RETENTION_GRACE_ACTIVE', 'snapshot retention grace has not elapsed');
  }
  const receiptIds: Uint8Array[] = [];
  const agents = new Set<string>();
  const peers = new Set<string>();
  for (const receipt of input.receipts) {
    try {
      encodeProtocolTuple('SnapshotCustodyReceiptV1', receipt);
      verifySingleSignedProtocolTuple('SnapshotCustodyReceiptV1', receipt);
    } catch (error) {
      retentionError('WAL_RETENTION_CUSTODY_INVALID', 'custody receipt signature or encoding is invalid', error);
    }
    if (
      !bytesEqualV1(receipt[1], input.snapshotObjectId)
      || !bytesEqualV1(receipt[4], input.currentMembershipCheckpointId)
      || bytesEqualV1(receipt[2], input.authorAddress)
      || receipt[5] > input.evaluatedAtMs
      || receipt[6] < input.evaluatedAtMs
      || receipt[6] < graceEndsAtMs
      || receipt[6] <= receipt[5]
    ) {
      retentionError(
        'WAL_RETENTION_CUSTODY_INVALID',
        'custody receipt has wrong snapshot/member/author binding or does not cover the grace interval',
      );
    }
    const membership = await input.validateCurrentCustodian(receipt);
    if (
      !membership.current
      || !membership.authorized
      || !membership.peerMatchesAgent
      || membership.removedOrRevoked
    ) {
      retentionError('WAL_RETENTION_CUSTODY_INVALID', 'custodian is not a current authorized matching member');
    }
    const agent = hex(receipt[2]);
    const peer = hex(receipt[3]);
    if (agents.has(agent) || peers.has(peer)) {
      retentionError('WAL_RETENTION_CUSTODY_INVALID', 'custody receipts must identify distinct agents and peers');
    }
    agents.add(agent);
    peers.add(peer);
    receiptIds.push(protocolTupleId('SnapshotCustodyReceiptV1', receipt));
  }
  if (receiptIds.length < minimum) {
    retentionError(
      'WAL_RETENTION_CUSTODY_INSUFFICIENT',
      `snapshot requires ${minimum} additional current custodians`,
    );
  }
  return {
    receiptIds,
    custodianAgentAddresses: input.receipts.map(receipt => new Uint8Array(receipt[2])),
    graceEndsAtMs,
  };
}
