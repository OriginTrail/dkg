import { blake3 } from '@noble/hashes/blake3.js';
import {
  RECONCILIATION_NONCE_LENGTH,
  WAL_OBJECT_ID_LENGTH,
  assertLength,
  concatBytes,
  readU64le
} from './bytes.js';
import {
  reconciliationSeed as toReconciliationSeed,
  type ReconciliationHeadId,
  type ReconciliationSeed,
  type WalObjectId
} from './ids.js';

const encoder = new TextEncoder();

export const DOMAIN = Object.freeze({
  seed: encoder.encode('dkg-wal-iblt-seed-v1\0'),
  mapping: encoder.encode('dkg-wal-iblt-map-v1\0'),
  checksum: encoder.encode('dkg-wal-iblt-check-v1\0'),
  setEmpty: encoder.encode('dkg-wal-set-empty-v1\0'),
  setLeaf: encoder.encode('dkg-wal-set-leaf-v1\0'),
  setBranch: encoder.encode('dkg-wal-set-branch-v1\0')
});

export function hashBytes(...values: Uint8Array[]): Uint8Array {
  return blake3(concatBytes(...values));
}

export function deriveReconciliationSeed(
  requesterHeadId: ReconciliationHeadId,
  providerHeadId: ReconciliationHeadId,
  requesterNonce: Uint8Array
): ReconciliationSeed {
  assertLength(requesterHeadId, WAL_OBJECT_ID_LENGTH, 'requesterHeadId');
  assertLength(providerHeadId, WAL_OBJECT_ID_LENGTH, 'providerHeadId');
  assertLength(requesterNonce, RECONCILIATION_NONCE_LENGTH, 'requesterNonce');
  return toReconciliationSeed(hashBytes(DOMAIN.seed, requesterHeadId, providerHeadId, requesterNonce));
}

export function idChecksum(reconciliationSeed: ReconciliationSeed, walObjectId: WalObjectId): Uint8Array {
  assertLength(reconciliationSeed, 32, 'reconciliationSeed');
  assertLength(walObjectId, WAL_OBJECT_ID_LENGTH, 'walObjectId');
  return hashBytes(DOMAIN.checksum, reconciliationSeed, walObjectId);
}

export function idMappingSeed(reconciliationSeed: ReconciliationSeed, walObjectId: WalObjectId): bigint {
  assertLength(reconciliationSeed, 32, 'reconciliationSeed');
  assertLength(walObjectId, WAL_OBJECT_ID_LENGTH, 'walObjectId');
  return readU64le(hashBytes(DOMAIN.mapping, reconciliationSeed, walObjectId).subarray(0, 8));
}
