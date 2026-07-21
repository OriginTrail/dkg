import { hashBytes } from '../../src/reconciliation/hash.js';
import { deriveReconciliationSeed } from '../../src/reconciliation/hash.js';
import { headForSet, type ReconciliationHead } from '../../src/reconciliation/head.js';
import {
  reconciliationHeadId,
  walObjectId,
  type ReconciliationHeadId,
  type ReconciliationSeed,
  type WalObjectId
} from '../../src/reconciliation/ids.js';

const encoder = new TextEncoder();

export function deterministicId(label: string): WalObjectId {
  return walObjectId(hashBytes(encoder.encode(`wal-iblt-test-id-v1\0${label}`)));
}

export function deterministicSet(prefix: string, count: number): WalObjectId[] {
  return Array.from({ length: count }, (_, index) => deterministicId(`${prefix}:${index}`));
}

export function deterministicHeadId(label: string): ReconciliationHeadId {
  return reconciliationHeadId(hashBytes(encoder.encode(`wal-iblt-test-head-v1\0${label}`)));
}

export function deterministicSeed(label: string): ReconciliationSeed {
  return deriveReconciliationSeed(
    deterministicHeadId(`requester:${label}`),
    deterministicHeadId(`provider:${label}`),
    deterministicId(`nonce:${label}`)
  );
}

export function deterministicHead(label: string, ids: readonly WalObjectId[]): ReconciliationHead {
  return headForSet(deterministicHeadId(label), ids);
}
