// SPDX-License-Identifier: Apache-2.0

import { ErrorFragment, Interface, ethers } from 'ethers';

/**
 * `DKGKnowledgeAssets` reverts `KaIdAlreadyMinted(kaId)` when a publish reuses
 * a packed KA id that is already minted. A named-asset publish whose earlier
 * transaction mined after the node stopped waiting hits it on every retry,
 * at gas estimation and before anything is broadcast.
 */
const KA_ID_ALREADY_MINTED = ErrorFragment.from('error KaIdAlreadyMinted(uint256 kaId)');
const KA_ID_ALREADY_MINTED_INTERFACE = new Interface([KA_ID_ALREADY_MINTED]);

/** Selector plus one ABI word: exactly what the contract emits for this error. */
const KA_ID_ALREADY_MINTED_DATA_BYTES = 4 + 32;

// Where ethers and JSON-RPC providers put revert data: the error itself, the
// provider error it wraps (`info.error`), or a re-thrown cause. Never message
// text, and never `transaction.data`, which is the publish calldata.
const REVERT_DATA_WRAPPER_KEYS = ['error', 'cause', 'info', 'data', 'originalError'] as const;
const MAX_WRAPPER_DEPTH = 5;

export const KA_ID_ALREADY_MINTED_SELECTOR = KA_ID_ALREADY_MINTED.selector;

/**
 * The KA id named by a `KaIdAlreadyMinted` revert, decoded from structured
 * revert data only. Returns `null` when no structured revert data carries this
 * error, or when two pieces of revert data name different ids.
 */
export function kaIdAlreadyMintedFromError(error: unknown): bigint | null {
  const ids = new Set<bigint>();
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): void => {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > MAX_WRAPPER_DEPTH) return;
    seen.add(value);
    const fields = value as Record<string, unknown>;
    for (const raw of [fields.data, fields.errorData]) {
      const kaId = decodeKaIdAlreadyMintedData(raw);
      if (kaId !== null) ids.add(kaId);
    }
    for (const key of REVERT_DATA_WRAPPER_KEYS) visit(fields[key], depth + 1);
  };
  visit(error, 0);
  return ids.size === 1 ? [...ids][0]! : null;
}

function decodeKaIdAlreadyMintedData(raw: unknown): bigint | null {
  const hex = raw instanceof Uint8Array ? ethers.hexlify(raw) : raw;
  if (typeof hex !== 'string' || !ethers.isHexString(hex, KA_ID_ALREADY_MINTED_DATA_BYTES)) return null;
  if (hex.slice(0, 10).toLowerCase() !== KA_ID_ALREADY_MINTED_SELECTOR) return null;
  const [kaId] = KA_ID_ALREADY_MINTED_INTERFACE.decodeErrorResult(KA_ID_ALREADY_MINTED, hex);
  return BigInt(kaId);
}

/**
 * The gas-estimation failure the real adapter surfaces for this revert, for
 * offline adapters that model the contract's re-mint guard.
 */
export function kaIdAlreadyMintedRevert(kaId: bigint): Error {
  const data = KA_ID_ALREADY_MINTED_INTERFACE.encodeErrorResult(KA_ID_ALREADY_MINTED, [kaId]);
  return Object.assign(new Error(`execution reverted: KaIdAlreadyMinted(${kaId})`), {
    code: 'CALL_EXCEPTION',
    action: 'estimateGas',
    reason: null,
    data,
    revert: { name: KA_ID_ALREADY_MINTED.name, signature: KA_ID_ALREADY_MINTED.format(), args: [kaId] },
  });
}
