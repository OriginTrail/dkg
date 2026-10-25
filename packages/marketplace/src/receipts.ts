/**
 * Receipt build (seller side) and verification (buyer side). The contract
 * never checks `sellerSig` — the submitting tx's `msg.sender` is the seller
 * signature on-chain — so off-chain verification here is what lets the buyer
 * trust a receipt (and its `resultCommitment`) before settling the meter.
 */
import { getBytes, sha256 } from 'ethers';
import { computeAuthDigest, computeReceiptDigest, eip191RecoverDigest, type Eip191Signer } from './digests.js';
import type { BoundedAuthorization, QueryInferenceReceipt, ReceiptClaimInput } from './types.js';

/** bytes32 hex commitment to the raw result bytes: sha256. */
export function resultCommitmentFor(resultBytes: Uint8Array): string {
  return sha256(resultBytes);
}

/**
 * Build and sign a receipt for one served call (seller side). The signer is
 * the seller's OPERATIONAL wallet; `receiptValueWei` is derived, never passed,
 * so a receipt can only ever claim `servedUnits * askPerUnitWei`.
 */
export async function buildReceipt(args: {
  authDigest: string;
  servedUnits: bigint;
  askPerUnitWei: bigint;
  resultBytes: Uint8Array;
  signer: Eip191Signer;
}): Promise<QueryInferenceReceipt> {
  if (args.servedUnits <= 0n) throw new Error(`servedUnits must be positive, got: ${args.servedUnits}`);
  if (args.askPerUnitWei <= 0n) throw new Error(`askPerUnitWei must be positive, got: ${args.askPerUnitWei}`);
  const receiptValueWei = args.servedUnits * args.askPerUnitWei;
  const resultCommitment = resultCommitmentFor(args.resultBytes);
  const receiptDigest = computeReceiptDigest({
    authDigest: args.authDigest,
    servedUnits: args.servedUnits,
    receiptValueWei,
    resultCommitment,
  });
  const sellerSig = await args.signer.signMessage(getBytes(receiptDigest));
  return { authDigest: args.authDigest, servedUnits: args.servedUnits, receiptValueWei, resultCommitment, sellerSig };
}

export interface ReceiptVerification {
  ok: boolean;
  errors: string[];
}

/**
 * Buyer-side verification of a receipt against the authorization it settles:
 * digest linkage, unit bounds, exact value math, optional result-commitment
 * check, and EIP-191 recovery of `sellerSig` to the expected seller wallet.
 * Collects every failure instead of stopping at the first so callers can log
 * a complete fault picture.
 */
export function verifyReceiptAgainstAuthorization(
  receipt: QueryInferenceReceipt,
  authorization: BoundedAuthorization,
  options: { sellerAddress: string; resultBytes?: Uint8Array },
): ReceiptVerification {
  const errors: string[] = [];
  const expectedAuthDigest = computeAuthDigest(authorization);
  if (authorization.authDigest !== expectedAuthDigest) {
    errors.push(`authorization digest mismatch: carried ${authorization.authDigest}, computed ${expectedAuthDigest}`);
  }
  if (receipt.authDigest !== expectedAuthDigest) {
    errors.push(`receipt settles a different authorization: ${receipt.authDigest}`);
  }
  if (receipt.servedUnits <= 0n) errors.push(`servedUnits must be positive, got: ${receipt.servedUnits}`);
  if (receipt.servedUnits > authorization.maxUnits) {
    errors.push(`servedUnits ${receipt.servedUnits} exceeds authorized maxUnits ${authorization.maxUnits}`);
  }
  const expectedValueWei = receipt.servedUnits * authorization.askPerUnitWei;
  if (receipt.receiptValueWei !== expectedValueWei) {
    errors.push(`receiptValueWei ${receipt.receiptValueWei} != servedUnits * askPerUnitWei ${expectedValueWei}`);
  }
  // Defense in depth: the contract rejects zero-value claims (ZeroClaimValue),
  // so a zero-value receipt can never settle — fail it at verification.
  if (receipt.receiptValueWei <= 0n) {
    errors.push(`receiptValueWei must be positive, got: ${receipt.receiptValueWei}`);
  }
  if (options.resultBytes && resultCommitmentFor(options.resultBytes) !== receipt.resultCommitment) {
    errors.push('resultCommitment does not match the delivered result bytes');
  }
  try {
    const receiptDigest = computeReceiptDigest(receipt);
    const recovered = eip191RecoverDigest(receiptDigest, receipt.sellerSig);
    if (recovered.toLowerCase() !== options.sellerAddress.toLowerCase()) {
      errors.push(`sellerSig recovers to ${recovered}, expected ${options.sellerAddress}`);
    }
  } catch (error) {
    errors.push(`sellerSig unverifiable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Assemble the on-chain claim for one (authorization, receipt) pair — the
 * exact struct `Marketplace.submitReceiptBatch` consumes.
 */
export function receiptToClaimInput(
  authorization: BoundedAuthorization,
  receipt: QueryInferenceReceipt,
): ReceiptClaimInput {
  if (receipt.authDigest !== authorization.authDigest) {
    throw new Error('receipt does not settle this authorization');
  }
  // The contract rejects zero-value claims (ZeroClaimValue); never build one.
  if (receipt.servedUnits * authorization.askPerUnitWei <= 0n) {
    throw new Error(
      `claim value must be positive: servedUnits ${receipt.servedUnits} × askPerUnitWei ${authorization.askPerUnitWei}`,
    );
  }
  return {
    buyer: authorization.buyer,
    epoch: authorization.epoch,
    offeringId: authorization.offeringId,
    callId: authorization.callId,
    maxUnits: authorization.maxUnits,
    askPerUnitWei: authorization.askPerUnitWei,
    expiry: authorization.expiry,
    servedUnits: receipt.servedUnits,
    resultCommitment: receipt.resultCommitment,
    authSignature: authorization.signature,
  };
}
