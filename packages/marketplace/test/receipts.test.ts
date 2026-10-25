import { toUtf8Bytes, Wallet } from 'ethers';
import { describe, expect, it } from 'vitest';
import {
  buildReceipt,
  createSessionKey,
  receiptToClaimInput,
  resultCommitmentFor,
  signAuthorization,
  verifyReceiptAgainstAuthorization,
} from '../src/index.js';
import type { AuthorizationFields, BoundedAuthorization, QueryInferenceReceipt } from '../src/index.js';

const SELLER_WALLET = new Wallet('0x0202020202020202020202020202020202020202020202020202020202020202');
const RESULT_BYTES = toUtf8Bytes('marketplace result');

const FIELDS: AuthorizationFields = {
  chainId: 31337n,
  marketplaceAddress: '0x1111111111111111111111111111111111111111',
  buyer: '0x2222222222222222222222222222222222222222',
  sellerIdentityId: 7n,
  offeringId: '0x71bca9a6544a949e1b23e90662484d852a552be7d60ac61cb2abc96966d78780',
  callId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  epoch: 42n,
  maxUnits: 1000n,
  askPerUnitWei: 500_000_000_000n,
  expiry: 1_793_577_600n,
};

async function fixture(): Promise<{ authorization: BoundedAuthorization; receipt: QueryInferenceReceipt }> {
  const authorization = await signAuthorization(createSessionKey(() => 0), FIELDS);
  const receipt = await buildReceipt({
    authDigest: authorization.authDigest,
    servedUnits: 640n,
    askPerUnitWei: authorization.askPerUnitWei,
    resultBytes: RESULT_BYTES,
    signer: SELLER_WALLET,
  });
  return { authorization, receipt };
}

describe('buildReceipt', () => {
  it('derives value and commitment; value math is exact bigint', async () => {
    const { receipt } = await fixture();
    expect(receipt.servedUnits).toBe(640n);
    expect(receipt.receiptValueWei).toBe(640n * 500_000_000_000n);
    expect(receipt.resultCommitment).toBe(resultCommitmentFor(RESULT_BYTES));
    expect(receipt.resultCommitment).toBe('0x0a4293eeaaafe0f1899e6884e58ecf36beb958adbae7f25787e01f536aacb89d');
  });

  it('refuses zero served units', async () => {
    const { authorization } = await fixture();
    await expect(
      buildReceipt({
        authDigest: authorization.authDigest,
        servedUnits: 0n,
        askPerUnitWei: authorization.askPerUnitWei,
        resultBytes: RESULT_BYTES,
        signer: SELLER_WALLET,
      }),
    ).rejects.toThrow('must be positive');
  });
});

describe('verifyReceiptAgainstAuthorization', () => {
  it('accepts an honest receipt round trip (with and without result bytes)', async () => {
    const { authorization, receipt } = await fixture();
    expect(
      verifyReceiptAgainstAuthorization(receipt, authorization, {
        sellerAddress: SELLER_WALLET.address,
        resultBytes: RESULT_BYTES,
      }),
    ).toEqual({ ok: true, errors: [] });
    expect(
      verifyReceiptAgainstAuthorization(receipt, authorization, { sellerAddress: SELLER_WALLET.address }).ok,
    ).toBe(true);
  });

  it('flags units over the authorized maximum and broken value math', async () => {
    const { authorization, receipt } = await fixture();
    const overserved = { ...receipt, servedUnits: 1001n };
    const result = verifyReceiptAgainstAuthorization(overserved, authorization, {
      sellerAddress: SELLER_WALLET.address,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('exceeds authorized maxUnits');
    expect(result.errors.join('\n')).toContain('servedUnits * askPerUnitWei');
  });

  it('flags a receipt bound to a different authorization', async () => {
    const { authorization } = await fixture();
    const otherReceipt = await buildReceipt({
      authDigest: '0x' + 'dd'.repeat(32),
      servedUnits: 1n,
      askPerUnitWei: authorization.askPerUnitWei,
      resultBytes: RESULT_BYTES,
      signer: SELLER_WALLET,
    });
    const result = verifyReceiptAgainstAuthorization(otherReceipt, authorization, {
      sellerAddress: SELLER_WALLET.address,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('different authorization');
  });

  it('flags a tampered result and a signature from the wrong seller wallet', async () => {
    const { authorization, receipt } = await fixture();
    const tamperedResult = verifyReceiptAgainstAuthorization(receipt, authorization, {
      sellerAddress: SELLER_WALLET.address,
      resultBytes: toUtf8Bytes('tampered result'),
    });
    expect(tamperedResult.ok).toBe(false);
    expect(tamperedResult.errors.join('\n')).toContain('resultCommitment');

    const wrongSeller = verifyReceiptAgainstAuthorization(receipt, authorization, {
      sellerAddress: '0x4444444444444444444444444444444444444444',
    });
    expect(wrongSeller.ok).toBe(false);
    expect(wrongSeller.errors.join('\n')).toContain('sellerSig recovers to');
  });

  it('flags a forged value: re-signing cannot help without the seller key', async () => {
    const { authorization, receipt } = await fixture();
    const inflated = { ...receipt, receiptValueWei: receipt.receiptValueWei + 1n };
    const result = verifyReceiptAgainstAuthorization(inflated, authorization, {
      sellerAddress: SELLER_WALLET.address,
    });
    expect(result.ok).toBe(false);
    // Both the value equation AND the signature break (digest covers value).
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('flags an authorization whose carried digest was tampered with', async () => {
    const { authorization, receipt } = await fixture();
    const tampered = { ...authorization, maxUnits: 2000n };
    const result = verifyReceiptAgainstAuthorization(receipt, tampered, {
      sellerAddress: SELLER_WALLET.address,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('authorization digest mismatch');
  });

  it('reports an unverifiable signature instead of throwing', async () => {
    const { authorization, receipt } = await fixture();
    const broken = { ...receipt, sellerSig: '0x1234' };
    const result = verifyReceiptAgainstAuthorization(broken, authorization, {
      sellerAddress: SELLER_WALLET.address,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('sellerSig unverifiable');
  });
});

describe('receiptToClaimInput', () => {
  it('assembles the exact contract claim from the pair', async () => {
    const { authorization, receipt } = await fixture();
    expect(receiptToClaimInput(authorization, receipt)).toEqual({
      buyer: FIELDS.buyer,
      epoch: FIELDS.epoch,
      offeringId: FIELDS.offeringId,
      callId: FIELDS.callId,
      maxUnits: FIELDS.maxUnits,
      askPerUnitWei: FIELDS.askPerUnitWei,
      expiry: FIELDS.expiry,
      servedUnits: receipt.servedUnits,
      resultCommitment: receipt.resultCommitment,
      authSignature: authorization.signature,
    });
  });

  it('refuses a receipt that settles a different authorization', async () => {
    const { authorization, receipt } = await fixture();
    const foreign = { ...receipt, authDigest: '0x' + 'dd'.repeat(32) };
    expect(() => receiptToClaimInput(authorization, foreign)).toThrow('does not settle');
  });
});
