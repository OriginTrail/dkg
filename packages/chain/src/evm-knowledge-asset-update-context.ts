// SPDX-License-Identifier: Apache-2.0

import type { KnowledgeAssetUpdateContext } from './chain-adapter.js';

function normalizeTuple(value: unknown, kaId: bigint): unknown[] {
  if (value === null || typeof value !== 'object') {
    throw new Error(`Invalid update context tuple for KA ${kaId}`);
  }
  const length = Reflect.get(value, 'length');
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error(`Invalid update context tuple for KA ${kaId}`);
  }
  return Array.from(value as ArrayLike<unknown>);
}

function decodeUint(value: unknown, name: string, kaId: bigint): bigint {
  if (value === undefined) {
    throw new Error(`Missing ${name} in update context for KA ${kaId}`);
  }
  if (
    typeof value !== 'bigint' &&
    typeof value !== 'number' &&
    typeof value !== 'string'
  ) {
    throw new Error(`Invalid ${name} in update context for KA ${kaId}`);
  }
  if (
    (typeof value === 'number' && !Number.isSafeInteger(value)) ||
    (typeof value === 'string' && value.trim() === '')
  ) {
    throw new Error(`Invalid ${name} in update context for KA ${kaId}`);
  }
  try {
    const decoded = BigInt(value);
    if (decoded < 0n) {
      throw new Error('negative uint');
    }
    return decoded;
  } catch {
    throw new Error(`Invalid ${name} in update context for KA ${kaId}`);
  }
}

function decodeBoolean(value: unknown, name: string, kaId: bigint): boolean {
  if (value === undefined) {
    throw new Error(`Missing ${name} in update context for KA ${kaId}`);
  }
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid ${name} in update context for KA ${kaId}`);
  }
  return value;
}

function decodeSafeNumber(value: unknown, name: string, kaId: bigint): number {
  const decoded = decodeUint(value, name, kaId);
  if (decoded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Invalid ${name} in update context for KA ${kaId}`);
  }
  return Number(decoded);
}

/**
 * Decode the sole ABI boundary for
 * `DKGKnowledgeAssets.getKnowledgeAssetUpdateContext(uint256)`.
 *
 * Ethers Results are array-like and always carry the ABI tuple positions.
 * Normalize those positions once and deliberately ignore optional named
 * properties so a fixture property cannot override the contract wire shape.
 */
export function decodeKnowledgeAssetUpdateContext(
  value: unknown,
  kaId: bigint,
): KnowledgeAssetUpdateContext {
  const [
    merkleRootsCount,
    minted,
    byteSize,
    endEpoch,
    tokenAmount,
    isImmutable,
    merkleLeafCount,
  ] = normalizeTuple(value, kaId);
  return {
    merkleRootsCount: decodeUint(merkleRootsCount, 'merkleRootsCount', kaId),
    minted: decodeUint(minted, 'minted', kaId),
    byteSize: decodeUint(byteSize, 'byteSize', kaId),
    endEpoch: decodeUint(endEpoch, 'endEpoch', kaId),
    tokenAmount: decodeUint(tokenAmount, 'tokenAmount', kaId),
    isImmutable: decodeBoolean(isImmutable, 'isImmutable', kaId),
    merkleLeafCount: decodeSafeNumber(merkleLeafCount, 'merkleLeafCount', kaId),
  };
}

/**
 * Narrow compatibility decoder for callers and fixtures that intentionally
 * request only tuple field zero instead of the complete update descriptor.
 */
export function decodeKnowledgeAssetMerkleRootCount(
  value: unknown,
  kaId: bigint,
): bigint {
  const rawCount = value !== null && typeof value === 'object'
    ? (
      Number.isSafeInteger(Reflect.get(value, 'length'))
        ? Reflect.get(value, '0')
        : Reflect.get(value, 'merkleRootsCount')
    )
    : undefined;
  if (rawCount === undefined) {
    throw new Error(`Missing Merkle-root count for KA ${kaId}`);
  }
  try {
    return decodeUint(rawCount, 'Merkle-root count', kaId);
  } catch {
    throw new Error(`Invalid Merkle-root count for KA ${kaId}`);
  }
}
