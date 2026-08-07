import {
  hashBytes,
  reconciliationHeadId,
  walObjectId,
  type ReconciliationHeadId,
  type WalObjectId
} from '@origintrail-official/dkg-wal/reconciliation';

const encoder = new TextEncoder();

export function deterministicId(label: string): WalObjectId {
  return walObjectId(hashBytes(encoder.encode(`wal-iblt-lab-id-v1\0${label}`)));
}

export function deterministicSet(prefix: string, count: number): WalObjectId[] {
  return Array.from({ length: count }, (_, index) => deterministicId(`${prefix}:${index}`));
}

export function deterministicHeadId(label: string): ReconciliationHeadId {
  return reconciliationHeadId(hashBytes(encoder.encode(`wal-iblt-lab-head-v1\0${label}`)));
}
