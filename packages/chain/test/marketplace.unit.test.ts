// SPDX-License-Identifier: Apache-2.0
/**
 * The marketplace's EIP-712 helpers and revert decoding (marketplace.ts),
 * against the contracts' own definitions: each type string is the Solidity
 * one, each digest is the one the contracts build by hand, and every
 * signature is a 64-byte EIP-2098 one with a low s.
 * `evm-adapter-marketplace.test.ts` checks the same digests against the
 * deployed contracts on Hardhat.
 */
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { loadAbi } from '../src/evm-adapter-abi.js';
import {
  BUYER_GRANT_TYPES,
  QUERY_INFERENCE_RECEIPT_TYPES,
  RECEIPT_BATCH_FAULTS,
  SERVICE_REQUEST_TYPES,
  compactSignature,
  grantDomain,
  hashBuyerGrant,
  hashQueryInferenceReceipt,
  hashServiceRequest,
  receiptBatchFaultOf,
  receiptItemOf,
  receiptsDigest,
  recoverSigner,
  requestDomain,
  signServiceRequest,
  subscriptionIdOf,
  type BuyerGrantTerms,
  type QueryInferenceReceipt,
  type ServiceRequest,
} from '../src/marketplace.js';

const coder = ethers.AbiCoder.defaultAbiCoder();
const STORAGE = '0x00000000000000000000000000000000000000a1';
const SUBSCRIPTIONS = '0x00000000000000000000000000000000000000a2';
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SESSION_KEY = new ethers.SigningKey(`0x${'11'.repeat(32)}`);

const REQUEST_TYPE =
  'ServiceRequest(bytes32 subscriptionId,bytes32 serviceId,uint72 seller,uint64 nonce,uint96 pricePerUnit,uint64 maxUnits,uint96 maxValueWei,uint40 issuedAt,uint40 expiry)';
const RECEIPT_TYPE =
  'QueryInferenceReceipt(bytes32 requestDigest,bytes32 resultCommitment,uint64 units,uint96 valueWei,uint40 completedAt)';
const GRANT_TYPE = 'BuyerGrant(uint256 accountId,address buyer,uint96 maxCostPerEpoch,uint40 expiresAt,uint64 nonce)';

const request: ServiceRequest = {
  subscriptionId: ethers.keccak256('0x01'),
  serviceId: ethers.keccak256('0x02'),
  seller: (1n << 72n) - 1n,
  nonce: (1n << 64n) - 1n,
  pricePerUnit: (1n << 96n) - 1n,
  maxUnits: 1_000n,
  maxValueWei: (1n << 96n) - 1n,
  issuedAt: 2 ** 40 - 2,
  expiry: 2 ** 40 - 1,
};

const receipt: QueryInferenceReceipt = {
  requestDigest: ethers.keccak256('0x03'),
  resultCommitment: ethers.keccak256('0x04'),
  units: 1_000n,
  valueWei: 5_000n,
  completedAt: 1_700_000_000,
};

const terms: BuyerGrantTerms = {
  accountId: 42n,
  buyer: ethers.getAddress('0x00000000000000000000000000000000000000b1'),
  maxCostPerEpoch: 10n ** 21n,
  expiresAt: 1_800_000_000,
  nonce: 3n,
};

/** The EIP-712 digest as the contracts build it by hand: domain separator, then struct hash. */
function handBuiltDigest(name: string, verifyingContract: string, typeString: string, types: string[], values: unknown[]): string {
  const domainSeparator = ethers.keccak256(coder.encode(
    ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
    [
      ethers.id('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
      ethers.id(name),
      ethers.id('1'),
      31337,
      verifyingContract,
    ],
  ));
  const structHash = ethers.keccak256(coder.encode(['bytes32', ...types], [ethers.id(typeString), ...values]));
  return ethers.keccak256(ethers.concat(['0x1901', domainSeparator, structHash]));
}

/** The high-s twin of a signature: s' = n − s with the other parity, which recovers to the same key. */
function highSTwin(signature: string): string {
  const sig = ethers.Signature.from(signature);
  const s = ethers.toBeHex(SECP256K1_N - BigInt(sig.s), 32);
  return ethers.concat([sig.r, s, sig.v === 27 ? '0x1c' : '0x1b']);
}

describe('marketplace EIP-712 messages', () => {
  it('each type string is the Solidity typehash string', () => {
    expect(ethers.TypedDataEncoder.from(SERVICE_REQUEST_TYPES).encodeType('ServiceRequest')).toBe(REQUEST_TYPE);
    expect(ethers.TypedDataEncoder.from(QUERY_INFERENCE_RECEIPT_TYPES).encodeType('QueryInferenceReceipt')).toBe(RECEIPT_TYPE);
    expect(ethers.TypedDataEncoder.from(BUYER_GRANT_TYPES).encodeType('BuyerGrant')).toBe(GRANT_TYPE);
  });

  it('requests and receipts are signed under DKGQueryInference v1, grants under DKGServiceSubscriptions v1', () => {
    expect(requestDomain(31337n, STORAGE)).toEqual({
      name: 'DKGQueryInference', version: '1', chainId: 31337, verifyingContract: ethers.getAddress(STORAGE),
    });
    expect(grantDomain(31337, SUBSCRIPTIONS)).toEqual({
      name: 'DKGServiceSubscriptions', version: '1', chainId: 31337, verifyingContract: ethers.getAddress(SUBSCRIPTIONS),
    });
  });

  it('the digests are those the contracts build by hand, at the widest values of each field', () => {
    expect(hashServiceRequest(requestDomain(31337, STORAGE), request)).toBe(handBuiltDigest(
      'DKGQueryInference', STORAGE, REQUEST_TYPE,
      ['bytes32', 'bytes32', 'uint72', 'uint64', 'uint96', 'uint64', 'uint96', 'uint40', 'uint40'],
      [request.subscriptionId, request.serviceId, request.seller, request.nonce, request.pricePerUnit, request.maxUnits,
        request.maxValueWei, request.issuedAt, request.expiry],
    ));
    expect(hashQueryInferenceReceipt(requestDomain(31337, STORAGE), receipt)).toBe(handBuiltDigest(
      'DKGQueryInference', STORAGE, RECEIPT_TYPE,
      ['bytes32', 'bytes32', 'uint64', 'uint96', 'uint40'],
      [receipt.requestDigest, receipt.resultCommitment, receipt.units, receipt.valueWei, receipt.completedAt],
    ));
    expect(hashBuyerGrant(grantDomain(31337, SUBSCRIPTIONS), terms)).toBe(handBuiltDigest(
      'DKGServiceSubscriptions', SUBSCRIPTIONS, GRANT_TYPE,
      ['uint256', 'address', 'uint96', 'uint40', 'uint64'],
      [terms.accountId, terms.buyer, terms.maxCostPerEpoch, terms.expiresAt, terms.nonce],
    ));
  });

  it('a request signed for another seller or another storage has another digest', () => {
    const domain = requestDomain(31337, STORAGE);
    expect(hashServiceRequest(domain, { ...request, seller: 1n })).not.toBe(hashServiceRequest(domain, request));
    expect(hashServiceRequest(requestDomain(31337, SUBSCRIPTIONS), request)).not.toBe(hashServiceRequest(domain, request));
  });

  it('subscriptionIdOf is keccak256(abi.encode(buyer, epoch)), one id per buyer and epoch', () => {
    expect(subscriptionIdOf(terms.buyer, 663)).toBe(ethers.keccak256(coder.encode(['address', 'uint256'], [terms.buyer, 663n])));
    expect(subscriptionIdOf(terms.buyer, 664n)).not.toBe(subscriptionIdOf(terms.buyer, 663));
  });

  it('receiptsDigest is the keccak256 of the digests, concatenated in order', () => {
    const digests = [ethers.keccak256('0x05'), ethers.keccak256('0x06')];
    expect(receiptsDigest(digests)).toBe(ethers.keccak256(ethers.concat(digests)));
    expect(receiptsDigest([...digests].reverse())).not.toBe(receiptsDigest(digests));
  });
});

describe('marketplace signatures', () => {
  const domain = requestDomain(31337, STORAGE);
  const digest = hashServiceRequest(domain, request);

  it('a session key signs a request as a 64-byte EIP-2098 signature with a low s', () => {
    const signature = signServiceRequest(SESSION_KEY, domain, request);
    expect(ethers.getBytes(signature)).toHaveLength(64);
    const s = BigInt(ethers.hexlify(ethers.getBytes(signature).slice(32))) & ((1n << 255n) - 1n);
    expect(s <= SECP256K1_N / 2n).toBe(true);
    expect(recoverSigner(digest, signature)).toBe(ethers.computeAddress(SESSION_KEY.publicKey));
    expect(signServiceRequest(SESSION_KEY.privateKey, domain, request)).toBe(signature);
  });

  it('recoverSigner refuses what the contracts refuse: a high s, and any length but 64 or 65 bytes', () => {
    const sig = SESSION_KEY.sign(digest);
    const signer = ethers.computeAddress(SESSION_KEY.publicKey);
    expect(recoverSigner(digest, sig.serialized)).toBe(signer);
    expect(recoverSigner(digest, sig.compactSerialized)).toBe(signer);
    // The malleated twin of a valid 65-byte signature recovers to the same key; the contracts refuse it.
    expect(recoverSigner(digest, highSTwin(sig.serialized))).toBeNull();
    // A 64-byte signature whose s, the low 255 bits of vs, is above n / 2.
    const parity = BigInt(sig.yParity) << 255n;
    expect(recoverSigner(digest, ethers.concat([sig.r, ethers.toBeHex(parity | (SECP256K1_N / 2n + 1n), 32)]))).toBeNull();
    expect(recoverSigner(digest, ethers.dataSlice(sig.serialized, 0, 63))).toBeNull();
    expect(recoverSigner(digest, '0x123')).toBeNull();
    expect(recoverSigner(digest, 'not hex')).toBeNull();
  });

  it('compactSignature turns a 65-byte signature into its 64-byte form and refuses a high s', () => {
    const sig = SESSION_KEY.sign(digest);
    expect(compactSignature(sig.serialized)).toBe(sig.compactSerialized);
    expect(compactSignature(sig.compactSerialized)).toBe(sig.compactSerialized);
    expect(() => compactSignature(highSTwin(sig.serialized))).toThrow();
  });

  it('receiptItemOf carries the request, the receipt but its request digest, and the split signature', () => {
    const signature = signServiceRequest(SESSION_KEY, domain, request);
    const item = receiptItemOf(request, receipt, signature);
    expect(item).toEqual({
      nonce: request.nonce,
      pricePerUnit: request.pricePerUnit,
      maxUnits: request.maxUnits,
      maxValueWei: request.maxValueWei,
      issuedAt: request.issuedAt,
      expiry: request.expiry,
      units: receipt.units,
      valueWei: receipt.valueWei,
      resultCommitment: receipt.resultCommitment,
      completedAt: receipt.completedAt,
      sigR: ethers.dataSlice(signature, 0, 32),
      sigVS: ethers.dataSlice(signature, 32, 64),
    });
    expect(receiptItemOf(request, receipt, SESSION_KEY.sign(digest).serialized)).toEqual(item);
  });
});

describe('marketplace decoding', () => {
  const settlement = new ethers.Interface(loadAbi('QueryInferenceSettlement'));

  it('RECEIPT_BATCH_FAULTS lists QueryInferenceSettlement.Fault in declaration order', () => {
    expect(RECEIPT_BATCH_FAULTS).toHaveLength(13);
    expect(RECEIPT_BATCH_FAULTS[0]).toBe('None');
    expect(RECEIPT_BATCH_FAULTS.indexOf('OutsideEpoch')).toBe(3);
    expect(RECEIPT_BATCH_FAULTS.indexOf('BadSignature')).toBe(6);
    expect(RECEIPT_BATCH_FAULTS.indexOf('DuplicateNonce')).toBe(8);
    expect(RECEIPT_BATCH_FAULTS[12]).toBe('ZeroResultCommitment');
  });

  it('receiptBatchFaultOf names the group or the item a refused batch names', () => {
    const revertOf = (name: string, args: unknown[]) => {
      const data = settlement.encodeErrorResult(name, args);
      return Object.assign(new Error(`execution reverted (unknown custom error) (data="${data}")`), { data });
    };
    expect(receiptBatchFaultOf(revertOf('ReceiptFault', [1, 4, 8]))).toEqual({ groupIndex: 1, itemIndex: 4, fault: 'DuplicateNonce' });
    expect(receiptBatchFaultOf(revertOf('GroupFault', [2, 3]))).toEqual({ groupIndex: 2, itemIndex: null, fault: 'OutsideEpoch' });
    expect(receiptBatchFaultOf(revertOf('NoNodeScore', [7, 663]))).toBeNull();
    expect(receiptBatchFaultOf(new Error('socket hang up'))).toBeNull();
  });
});
