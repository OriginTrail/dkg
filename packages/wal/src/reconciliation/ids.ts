import { WAL_OBJECT_ID_LENGTH, assertLength, copyBytes } from './bytes.js';
import { ReconciliationError } from './errors.js';

declare const WAL_OBJECT_ID_BRAND: unique symbol;
declare const RECONCILIATION_SEED_BRAND: unique symbol;
declare const SET_ROOT_BRAND: unique symbol;
declare const HEAD_ID_BRAND: unique symbol;

export type WalObjectId = Uint8Array & { readonly [WAL_OBJECT_ID_BRAND]: 'WalObjectId' };
export type ReconciliationSeed = Uint8Array & { readonly [RECONCILIATION_SEED_BRAND]: 'ReconciliationSeed' };
export type SetCommitmentRoot = Uint8Array & { readonly [SET_ROOT_BRAND]: 'SetCommitmentRoot' };
export type ReconciliationHeadId = Uint8Array & { readonly [HEAD_ID_BRAND]: 'ReconciliationHeadId' };

function brandedCopy<T extends Uint8Array>(value: Uint8Array, label: string): T {
  assertLength(value, WAL_OBJECT_ID_LENGTH, label);
  return copyBytes(value) as T;
}

export function walObjectId(value: Uint8Array): WalObjectId {
  try {
    return brandedCopy<WalObjectId>(value, 'WalObjectId');
  } catch (error) {
    throw new ReconciliationError('INVALID_WAL_OBJECT_ID', 'WalObjectId must be exactly 32 bytes');
  }
}

export function reconciliationSeed(value: Uint8Array): ReconciliationSeed {
  return brandedCopy<ReconciliationSeed>(value, 'reconciliationSeed');
}

export function setCommitmentRoot(value: Uint8Array): SetCommitmentRoot {
  return brandedCopy<SetCommitmentRoot>(value, 'setCommitmentRoot');
}

export function reconciliationHeadId(value: Uint8Array): ReconciliationHeadId {
  return brandedCopy<ReconciliationHeadId>(value, 'reconciliationHeadId');
}
