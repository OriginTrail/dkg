// SPDX-License-Identifier: Apache-2.0

import type { KnowledgeAssetUpdateContext } from './chain-adapter.js';

type UpdateContextField = keyof KnowledgeAssetUpdateContext;

type RawKnowledgeAssetUpdateContext = {
  [K in UpdateContextField]?: unknown;
} & readonly unknown[];

const UPDATE_CONTEXT_FIELDS = {
  merkleRootsCount: 0,
  minted: 1,
  byteSize: 2,
  endEpoch: 3,
  tokenAmount: 4,
  isImmutable: 5,
  merkleLeafCount: 6,
} as const satisfies Record<UpdateContextField, number>;

function asRawUpdateContext(value: unknown): RawKnowledgeAssetUpdateContext {
  if ((typeof value !== 'object' && !Array.isArray(value)) || value === null) {
    return [] as unknown as RawKnowledgeAssetUpdateContext;
  }
  return value as RawKnowledgeAssetUpdateContext;
}

function requireUpdateContextField(
  context: RawKnowledgeAssetUpdateContext,
  name: UpdateContextField,
  kaId: bigint,
): unknown {
  const value = context[name] ?? context[UPDATE_CONTEXT_FIELDS[name]];
  if (value === undefined) {
    throw new Error(`Missing ${name} in update context for KA ${kaId}`);
  }
  return value;
}

function decodeBigIntField(
  context: RawKnowledgeAssetUpdateContext,
  name: Exclude<UpdateContextField, 'isImmutable' | 'merkleLeafCount'>,
  kaId: bigint,
): bigint {
  return BigInt(requireUpdateContextField(context, name, kaId) as
    string | number | bigint | boolean);
}

function decodeBooleanField(
  context: RawKnowledgeAssetUpdateContext,
  name: 'isImmutable',
  kaId: bigint,
): boolean {
  const value = requireUpdateContextField(context, name, kaId);
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid ${name} in update context for KA ${kaId}`);
  }
  return value;
}

function decodeSafeNumberField(
  context: RawKnowledgeAssetUpdateContext,
  name: 'merkleLeafCount',
  kaId: bigint,
): number {
  const value = Number(BigInt(requireUpdateContextField(context, name, kaId) as
    string | number | bigint | boolean));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${name} in update context for KA ${kaId}`);
  }
  return value;
}

/**
 * Decode the sole ABI boundary for
 * `DKGKnowledgeAssets.getKnowledgeAssetUpdateContext(uint256)`.
 *
 * Ethers Results expose both named properties and positional tuple entries;
 * named values take precedence while positional values keep older fixtures
 * and ABI decoders compatible.
 */
export function decodeKnowledgeAssetUpdateContext(
  value: unknown,
  kaId: bigint,
): KnowledgeAssetUpdateContext {
  const context = asRawUpdateContext(value);
  return {
    merkleRootsCount: decodeBigIntField(context, 'merkleRootsCount', kaId),
    minted: decodeBigIntField(context, 'minted', kaId),
    byteSize: decodeBigIntField(context, 'byteSize', kaId),
    endEpoch: decodeBigIntField(context, 'endEpoch', kaId),
    tokenAmount: decodeBigIntField(context, 'tokenAmount', kaId),
    isImmutable: decodeBooleanField(context, 'isImmutable', kaId),
    merkleLeafCount: decodeSafeNumberField(context, 'merkleLeafCount', kaId),
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
  const context = asRawUpdateContext(value);
  const rawCount = context.merkleRootsCount ?? context[UPDATE_CONTEXT_FIELDS.merkleRootsCount];
  if (rawCount === undefined) {
    throw new Error(`Missing Merkle-root count for KA ${kaId}`);
  }
  return BigInt(rawCount as string | number | bigint | boolean);
}
