import { getBytes, Wallet } from 'ethers';
import { describe, expect, it } from 'vitest';
import {
  AUTH_DOMAIN,
  RCPT_DOMAIN,
  computeAuthDigest,
  computeReceiptDigest,
  eip191RecoverDigest,
  eip191SignDigest,
  offeringIdFor,
} from '../src/index.js';
import type { AuthorizationFields } from '../src/index.js';

/**
 * FIXED digest vectors. The expectations below were computed once from the
 * spec'd `abi.encodePacked` layouts and are hardcoded so ANY drift in domain
 * literals, field order, or packed widths breaks loudly. The Solidity test
 * suite asserts these exact vectors against `Marketplace.sol`.
 */
const AUTH_VECTOR_FIELDS: AuthorizationFields = {
  chainId: 31337n,
  marketplaceAddress: '0x1111111111111111111111111111111111111111',
  buyer: '0x2222222222222222222222222222222222222222',
  sellerIdentityId: 7n,
  offeringId: '0x71bca9a6544a949e1b23e90662484d852a552be7d60ac61cb2abc96966d78780',
  callId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  epoch: 42n,
  maxUnits: 1000n,
  askPerUnitWei: 500000000000n,
  expiry: 1793577600n,
};
const AUTH_VECTOR_DIGEST = '0x452c8e71cd6db0092bcd045e3de3fcc35b8fb9e3a07660bfc99d2b3f110f314e';
const RECEIPT_VECTOR_DIGEST = '0x9d3de83612bb73f436244e6af3e933c70f1d9cf5abfbf585df63744fc5343ad6';
const RESULT_COMMITMENT = '0x0a4293eeaaafe0f1899e6884e58ecf36beb958adbae7f25787e01f536aacb89d';

const SESSION_KEY = new Wallet('0x0101010101010101010101010101010101010101010101010101010101010101');

describe('authorization digest', () => {
  it('matches the fixed vector byte-for-byte', () => {
    expect(computeAuthDigest(AUTH_VECTOR_FIELDS)).toBe(AUTH_VECTOR_DIGEST);
  });

  it('binds every field: changing any one changes the digest', () => {
    const variants: Partial<AuthorizationFields>[] = [
      { chainId: 31338n },
      { marketplaceAddress: '0x1111111111111111111111111111111111111112' },
      { buyer: '0x2222222222222222222222222222222222222223' },
      { sellerIdentityId: 8n },
      { offeringId: '0x8298de7e0a29b25d32650b7e6fd5afd132fdfc0d9a844fc5aef85a7748740ec6' },
      { callId: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      { epoch: 43n },
      { maxUnits: 1001n },
      { askPerUnitWei: 500000000001n },
      { expiry: 1793577601n },
    ];
    for (const variant of variants) {
      expect(computeAuthDigest({ ...AUTH_VECTOR_FIELDS, ...variant })).not.toBe(AUTH_VECTOR_DIGEST);
    }
  });

  it('rejects out-of-range packed fields', () => {
    expect(() => computeAuthDigest({ ...AUTH_VECTOR_FIELDS, sellerIdentityId: 1n << 72n })).toThrow('uint72');
    expect(() => computeAuthDigest({ ...AUTH_VECTOR_FIELDS, maxUnits: 1n << 64n })).toThrow('uint64');
    expect(() => computeAuthDigest({ ...AUTH_VECTOR_FIELDS, askPerUnitWei: 1n << 96n })).toThrow('uint96');
    expect(() => computeAuthDigest({ ...AUTH_VECTOR_FIELDS, expiry: 1n << 40n })).toThrow('uint40');
    expect(() => computeAuthDigest({ ...AUTH_VECTOR_FIELDS, epoch: -1n })).toThrow('uint256');
    expect(() => computeAuthDigest({ ...AUTH_VECTOR_FIELDS, offeringId: '0x1234' })).toThrow('32-byte');
    expect(() => computeAuthDigest({ ...AUTH_VECTOR_FIELDS, callId: 'not-hex' })).toThrow('32-byte');
  });
});

describe('receipt digest', () => {
  it('matches the fixed vector byte-for-byte', () => {
    expect(
      computeReceiptDigest({
        authDigest: AUTH_VECTOR_DIGEST,
        servedUnits: 640n,
        receiptValueWei: 320000000000000n,
        resultCommitment: RESULT_COMMITMENT,
      }),
    ).toBe(RECEIPT_VECTOR_DIGEST);
  });

  it('rejects malformed fields', () => {
    const base = {
      authDigest: AUTH_VECTOR_DIGEST,
      servedUnits: 640n,
      receiptValueWei: 320000000000000n,
      resultCommitment: RESULT_COMMITMENT,
    };
    expect(() => computeReceiptDigest({ ...base, servedUnits: 1n << 64n })).toThrow('uint64');
    expect(() => computeReceiptDigest({ ...base, receiptValueWei: -1n })).toThrow('uint256');
    expect(() => computeReceiptDigest({ ...base, authDigest: '0xff' })).toThrow('32-byte');
    expect(() => computeReceiptDigest({ ...base, resultCommitment: '0xff' })).toThrow('32-byte');
  });
});

describe('EIP-191 digest signing', () => {
  it('signs deterministically and recovers the signer (fixed signature vector)', async () => {
    const signature = await eip191SignDigest(SESSION_KEY, AUTH_VECTOR_DIGEST);
    expect(signature).toBe(
      '0x7ccc0d8c1e763b321ba91235896e43aae9d1c3538c7e49d524113dadcddc501d0170dd1018351ca13c4443f094acd585ca3576298412f02770d554905cfdfe1a1b',
    );
    expect(eip191RecoverDigest(AUTH_VECTOR_DIGEST, signature)).toBe(SESSION_KEY.address);
  });

  it('is personal-sign over the raw 32 digest bytes (signMessage equivalence)', async () => {
    const direct = await SESSION_KEY.signMessage(getBytes(RECEIPT_VECTOR_DIGEST));
    expect(await eip191SignDigest(SESSION_KEY, RECEIPT_VECTOR_DIGEST)).toBe(direct);
  });

  it('recovers a DIFFERENT address for a tampered digest, never throws', async () => {
    const signature = await eip191SignDigest(SESSION_KEY, AUTH_VECTOR_DIGEST);
    expect(eip191RecoverDigest(RECEIPT_VECTOR_DIGEST, signature)).not.toBe(SESSION_KEY.address);
  });

  it('rejects non-bytes32 digests before signing or recovering', async () => {
    await expect(eip191SignDigest(SESSION_KEY, '0x1234')).rejects.toThrow('32-byte');
    expect(() => eip191RecoverDigest('0x1234', '0x00')).toThrow('32-byte');
  });
});

describe('offeringIdFor', () => {
  it('is keccak256 of the UTF-8 offering name (fixed vectors)', () => {
    expect(offeringIdFor('devnet-llm')).toBe('0x71bca9a6544a949e1b23e90662484d852a552be7d60ac61cb2abc96966d78780');
    expect(offeringIdFor('devnet-knowledge')).toBe('0x8298de7e0a29b25d32650b7e6fd5afd132fdfc0d9a844fc5aef85a7748740ec6');
  });
});

describe('domain literals', () => {
  it('pins the contract-shared domain-separation strings', () => {
    expect(AUTH_DOMAIN).toBe('DKG_MKT_AUTH_V1');
    expect(RCPT_DOMAIN).toBe('DKG_MKT_RCPT_V1');
  });
});
