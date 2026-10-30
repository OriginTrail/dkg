// SPDX-License-Identifier: Apache-2.0
import { ethers, type JsonRpcProvider } from 'ethers';
import { numericChainIdOf } from './configured-chain-id.js';
import { resolveEvmFinalityAnchorBlockV1 } from './evm-finality-anchor.js';

/**
 * GH#2270 PR-3 r2 — does this error mean "that ERC-721 token does not exist"?
 *
 * Deliberately narrow. A `false` from the caller authorises a resend, so only the shapes OpenZeppelin
 * and ethers produce for a nonexistent token qualify: the typed `ERC721NonexistentToken` custom
 * error, or the classic `ERC721: invalid token ID` / `owner query for nonexistent token` strings.
 * Every other CALL_EXCEPTION — a paused contract, a decode failure, an endpoint returning garbage —
 * is left to the caller's `null`, which holds.
 */
const NONEXISTENT_TOKEN_LEGACY_REASONS = new Set([
  'erc721: invalid token id',
  'erc721: owner query for nonexistent token',
]);

function isNonexistentTokenRevert(err: unknown): boolean {
  const e = err as {
    code?: unknown;
    reason?: unknown;
    revert?: { name?: unknown } | null;
  };
  if (e?.code !== 'CALL_EXCEPTION') return false;
  // r21 (🔴 3816664734) — EXACT identification only. This classifier guards the one path
  // allowed to resend a held create, so "probably absent" is not good enough: a substring scan
  // over the joined reason/shortMessage/message accepted unrelated reverts that merely CONTAIN a
  // recognized phrase — `paused: nonexistent token checks unavailable` matched — and with the
  // nonce consumed that fabricated the absence conjunction and authorized a second publish.
  // The decoded custom-error NAME is authoritative; the two legacy strings are matched whole, as
  // reasons, never as substrings of a longer message. Everything else falls through to the
  // caller's `null`, which holds the job.
  if (typeof e.revert?.name === 'string' && e.revert.name === 'ERC721NonexistentToken') return true;
  return typeof e.reason === 'string'
    && NONEXISTENT_TOKEN_LEGACY_REASONS.has(e.reason.trim().toLowerCase());
}

/**
 * The chain-proof snapshot's own fail-closed anchor verdict.
 *
 * Distinguishes "this endpoint cannot give me a usable anchor" — an EMPTY VIEW
 * that must fail over — from a transport error or an abort, which the retry
 * machinery classifies itself.
 */
class ChainProofAnchorUnavailableError extends Error {
  override readonly name = 'ChainProofAnchorUnavailableError';
}

/** One endpoint and finality anchor own all mint-state and caller-specific proof facts.
 * Returning null asks the caller to retry the entire snapshot on another endpoint.
 */
export async function readPinnedMintState<T extends object>(provider: JsonRpcProvider, input: {
  chainId: string;
  finalityConfirmations: number;
  kaId: bigint;
  readOwner?: (kaId: bigint, blockTag: number) => Promise<string>;
}, readContext: (blockNumber: number) => Promise<T>): Promise<({ blockNumber: number; blockHash: string; kaMinted: boolean | null } & T) | null> {
  const expectedChainId = numericChainIdOf(input.chainId);
  if (expectedChainId !== undefined && BigInt((await provider.getNetwork()).chainId) !== expectedChainId) return null;
  const block = await resolveEvmFinalityAnchorBlockV1({
    finalityConfirmations: input.finalityConfirmations,
    readHead: () => provider.getBlock('latest'),
    readBlockAt: number => provider.getBlock(number),
    unavailable: detail => new ChainProofAnchorUnavailableError(`chain-proof snapshot anchor: ${detail}`),
  }).catch((error: unknown) => {
    if (error instanceof ChainProofAnchorUnavailableError) return null;
    throw error;
  });
  if (block === null) return null;
  const context = await readContext(block.number);
  let kaMinted: boolean | null = null;
  if (input.readOwner) {
    try {
      const owner = ethers.getAddress(await input.readOwner(input.kaId, block.number));
      kaMinted = owner === ethers.ZeroAddress ? null : true;
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (code !== 'CALL_EXCEPTION' && code !== 'BAD_DATA') throw error;
      kaMinted = isNonexistentTokenRevert(error) ? false : null;
    }
  }
  return { ...context, blockNumber: block.number, blockHash: block.hash, kaMinted };
}
