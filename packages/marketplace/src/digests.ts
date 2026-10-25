/**
 * OT-RFC-27 marketplace digests. These MUST match `Marketplace.sol`
 * byte-for-byte — both sides hash `abi.encodePacked` preimages with ASCII
 * domain literals and sign/verify under EIP-191 personal-sign over the raw
 * 32-byte digest (`"\x19Ethereum Signed Message:\n32" + digest`), the same
 * pattern as `packages/core/src/crypto/ack.ts`. The fixed vectors in
 * `test/digests.test.ts` pin the exact bytes; the Solidity test suite
 * asserts the same vectors, so any drift on either side breaks loudly.
 */
import { getBytes, keccak256, solidityPackedKeccak256, toUtf8Bytes, verifyMessage } from 'ethers';
import type { AuthorizationFields } from './types.js';

/** Domain-separation literal for the buyer authorization digest. */
export const AUTH_DOMAIN = 'DKG_MKT_AUTH_V1';

/** Domain-separation literal for the seller receipt digest. */
export const RCPT_DOMAIN = 'DKG_MKT_RCPT_V1';

/** Minimal signer surface: `ethers.Wallet` / any EIP-191 personal signer. */
export interface Eip191Signer {
  signMessage(message: Uint8Array): Promise<string>;
}

const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function assertUint(value: bigint, bits: bigint, label: string): void {
  if (value < 0n || value >= 1n << bits) {
    throw new Error(`${label} must fit in uint${bits}, got: ${value}`);
  }
}

function assertBytes32(value: string, label: string): void {
  if (!BYTES32_PATTERN.test(value)) {
    throw new Error(`${label} must be a 0x-prefixed 32-byte hex string, got: ${value}`);
  }
}

/**
 * The authorization digest a buyer session key signs for ONE bounded,
 * seller-specific request:
 *
 *   keccak256(abi.encodePacked(
 *     AUTH_DOMAIN,          // string literal (no length prefix)
 *     chainId,              // uint256
 *     marketplaceAddress,   // address (20)
 *     buyer,                // address (20) — funding wallet, NOT session key
 *     sellerIdentityId,     // uint72 (9 — natural packed width)
 *     offeringId,           // bytes32
 *     callId,               // bytes32 (single-use)
 *     epoch,                // uint256
 *     maxUnits,             // uint64 (8)
 *     askPerUnitWei,        // uint96 (12)
 *     expiry                // uint40 (5)
 *   ))
 *
 * The max receipt value is implicit: `maxUnits * askPerUnitWei`.
 */
export function computeAuthDigest(fields: AuthorizationFields): string {
  assertUint(fields.chainId, 256n, 'chainId');
  assertUint(fields.sellerIdentityId, 72n, 'sellerIdentityId');
  assertBytes32(fields.offeringId, 'offeringId');
  assertBytes32(fields.callId, 'callId');
  assertUint(fields.epoch, 256n, 'epoch');
  assertUint(fields.maxUnits, 64n, 'maxUnits');
  assertUint(fields.askPerUnitWei, 96n, 'askPerUnitWei');
  assertUint(fields.expiry, 40n, 'expiry');
  return solidityPackedKeccak256(
    ['string', 'uint256', 'address', 'address', 'uint72', 'bytes32', 'bytes32', 'uint256', 'uint64', 'uint96', 'uint40'],
    [
      AUTH_DOMAIN,
      fields.chainId,
      fields.marketplaceAddress,
      fields.buyer,
      fields.sellerIdentityId,
      fields.offeringId,
      fields.callId,
      fields.epoch,
      fields.maxUnits,
      fields.askPerUnitWei,
      fields.expiry,
    ],
  );
}

export interface ReceiptDigestFields {
  /** bytes32 hex of the authorization this receipt settles against. */
  authDigest: string;
  /** uint64. */
  servedUnits: bigint;
  /** uint256 — `servedUnits * askPerUnitWei`. */
  receiptValueWei: bigint;
  /** bytes32 hex — sha256 of the raw result bytes. */
  resultCommitment: string;
}

/**
 * The receipt digest the seller's operational wallet signs so the BUYER can
 * verify the receipt off-chain (the contract never checks `sellerSig`; the
 * submitting tx's `msg.sender` IS the seller signature on-chain):
 *
 *   keccak256(abi.encodePacked(
 *     RCPT_DOMAIN,       // string literal
 *     authDigest,        // bytes32
 *     servedUnits,       // uint64 (8)
 *     receiptValueWei,   // uint256
 *     resultCommitment   // bytes32
 *   ))
 */
export function computeReceiptDigest(fields: ReceiptDigestFields): string {
  assertBytes32(fields.authDigest, 'authDigest');
  assertUint(fields.servedUnits, 64n, 'servedUnits');
  assertUint(fields.receiptValueWei, 256n, 'receiptValueWei');
  assertBytes32(fields.resultCommitment, 'resultCommitment');
  return solidityPackedKeccak256(
    ['string', 'bytes32', 'uint64', 'uint256', 'bytes32'],
    [RCPT_DOMAIN, fields.authDigest, fields.servedUnits, fields.receiptValueWei, fields.resultCommitment],
  );
}

/**
 * EIP-191 personal-sign over a raw 32-byte digest. `signMessage(getBytes(d))`
 * hashes `"\x19Ethereum Signed Message:\n32" + d` — exactly what the contract
 * recovers via `ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(d), sig)`
 * and the equivalent of `eip191Hash` in `packages/core/src/crypto/ack.ts`.
 */
export async function eip191SignDigest(signer: Eip191Signer, digest: string): Promise<string> {
  assertBytes32(digest, 'digest');
  return signer.signMessage(getBytes(digest));
}

/** Recover the EIP-191 signer address of a 32-byte digest signature. */
export function eip191RecoverDigest(digest: string, signature: string): string {
  assertBytes32(digest, 'digest');
  return verifyMessage(getBytes(digest), signature);
}

/** Canonical bytes32 offering id for a local offering name: keccak256(utf8). */
export function offeringIdFor(offeringName: string): string {
  return keccak256(toUtf8Bytes(offeringName));
}
