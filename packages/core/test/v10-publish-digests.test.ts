import { describe, it, expect } from 'vitest';
import {
  computePublishACKDigest,
  computePublishPublisherDigest,
  keccak256Hex,
} from '../src/index.js';

// Golden reference vectors computed via ethers.solidityPackedKeccak256 against
// the exact abi.encodePacked shapes in KnowledgeAssetsV10.sol:
//   - ACK digest            → contract lines 362-373
//   - Publisher digest      → contract lines 327-335
//
// The contract prefixes both with (block.chainid, address(this)) for H5 replay
// protection; the publisher digest field order is (identityId, cgId, merkleRoot)
// per N26. Any drift in packing width, order, or prefix breaks both gates.

const CHAIN_ID = 31337n;
const KAV10_ADDRESS = '0x0000000000000000000000000000000000000042';
const CG_ID = 1337n;
const MERKLE_ROOT = new Uint8Array(32).fill(0xaa);
const KA_COUNT = 3n;
const BYTE_SIZE = 777n;
const EPOCHS = 2n;
const TOKEN_AMOUNT = 1000n;
const IDENTITY_ID = 5n;

// Golden hex reference — precomputed offline with ethers.solidityPackedKeccak256.
// If either of these diverges from the contract, on-chain _verifySignatures and
// _verifySignature revert on every publish; keep these vectors pinned.
const ACK_DIGEST_GOLDEN =
  '0xd00e49a83ec62438bbd23818a35d1dd1572adaf72e1b660a2e7573bb15d22bcc';
const PUBLISHER_DIGEST_GOLDEN =
  '0x511ca6d1022288492fb07cd51c6285513790e6ac1e99745ad1a369bb5b53d991';
// The same fields in the WRONG order (cgId before identityId) — must NOT match.
const PUBLISHER_DIGEST_SWAPPED_ORDER =
  '0xc187cc01681cb99adc14ce4146c0d4995d655c151dcbeb9badb3ca1ae51caaf2';

describe('computePublishACKDigest', () => {
  it('matches the H5-prefixed golden reference', () => {
    const digest = computePublishACKDigest(
      CHAIN_ID,
      KAV10_ADDRESS,
      CG_ID,
      MERKLE_ROOT,
      KA_COUNT,
      BYTE_SIZE,
      EPOCHS,
      TOKEN_AMOUNT,
    );
    expect(keccak256Hex(new Uint8Array(0))).toMatch(/^0x/); // sanity on helper import
    expect('0x' + Buffer.from(digest).toString('hex')).toBe(ACK_DIGEST_GOLDEN);
  });

  it('is deterministic for identical inputs', () => {
    const a = computePublishACKDigest(
      CHAIN_ID, KAV10_ADDRESS, CG_ID, MERKLE_ROOT, KA_COUNT, BYTE_SIZE, EPOCHS, TOKEN_AMOUNT,
    );
    const b = computePublishACKDigest(
      CHAIN_ID, KAV10_ADDRESS, CG_ID, MERKLE_ROOT, KA_COUNT, BYTE_SIZE, EPOCHS, TOKEN_AMOUNT,
    );
    expect(a).toEqual(b);
  });

  it('different chainId produces a different digest (H5 chain-pin)', () => {
    const a = computePublishACKDigest(
      CHAIN_ID, KAV10_ADDRESS, CG_ID, MERKLE_ROOT, KA_COUNT, BYTE_SIZE, EPOCHS, TOKEN_AMOUNT,
    );
    const b = computePublishACKDigest(
      CHAIN_ID + 1n, KAV10_ADDRESS, CG_ID, MERKLE_ROOT, KA_COUNT, BYTE_SIZE, EPOCHS, TOKEN_AMOUNT,
    );
    expect(a).not.toEqual(b);
  });

  it('different kav10Address produces a different digest (H5 contract-pin)', () => {
    const a = computePublishACKDigest(
      CHAIN_ID, KAV10_ADDRESS, CG_ID, MERKLE_ROOT, KA_COUNT, BYTE_SIZE, EPOCHS, TOKEN_AMOUNT,
    );
    const b = computePublishACKDigest(
      CHAIN_ID, '0x0000000000000000000000000000000000000043', CG_ID, MERKLE_ROOT, KA_COUNT, BYTE_SIZE, EPOCHS, TOKEN_AMOUNT,
    );
    expect(a).not.toEqual(b);
  });

  it('rejects merkleRoot with wrong length', () => {
    expect(() =>
      computePublishACKDigest(
        CHAIN_ID, KAV10_ADDRESS, CG_ID, new Uint8Array(16), KA_COUNT, BYTE_SIZE, EPOCHS, TOKEN_AMOUNT,
      ),
    ).toThrow(/merkleRoot/);
  });

  it('rejects malformed kav10Address', () => {
    expect(() =>
      computePublishACKDigest(
        CHAIN_ID, '0xnope', CG_ID, MERKLE_ROOT, KA_COUNT, BYTE_SIZE, EPOCHS, TOKEN_AMOUNT,
      ),
    ).toThrow(/kav10Address/);
  });
});

describe('computePublishPublisherDigest', () => {
  it('matches the H5-prefixed, N26-ordered golden reference', () => {
    const digest = computePublishPublisherDigest(
      CHAIN_ID,
      KAV10_ADDRESS,
      IDENTITY_ID,
      CG_ID,
      MERKLE_ROOT,
    );
    expect('0x' + Buffer.from(digest).toString('hex')).toBe(PUBLISHER_DIGEST_GOLDEN);
  });

  it('does NOT produce the cgId-before-identityId shape (N26 regression guard)', () => {
    const digest = computePublishPublisherDigest(
      CHAIN_ID, KAV10_ADDRESS, IDENTITY_ID, CG_ID, MERKLE_ROOT,
    );
    const asHex = '0x' + Buffer.from(digest).toString('hex');
    // The swapped-order digest is the one that would pass signature verification
    // on-chain iff the contract also had the fields reversed — it does not.
    // If this assertion ever fires, someone put cgId ahead of identityId in the
    // pack and every publisher digest will fail _verifySignature on chain.
    expect(asHex).not.toBe(PUBLISHER_DIGEST_SWAPPED_ORDER);
    expect(asHex).toBe(PUBLISHER_DIGEST_GOLDEN);
  });

  it('is deterministic for identical inputs', () => {
    const a = computePublishPublisherDigest(CHAIN_ID, KAV10_ADDRESS, IDENTITY_ID, CG_ID, MERKLE_ROOT);
    const b = computePublishPublisherDigest(CHAIN_ID, KAV10_ADDRESS, IDENTITY_ID, CG_ID, MERKLE_ROOT);
    expect(a).toEqual(b);
  });

  it('rejects identityId overflow (> uint72 max)', () => {
    const uint72Max = (1n << 72n) - 1n;
    expect(() =>
      computePublishPublisherDigest(CHAIN_ID, KAV10_ADDRESS, uint72Max + 1n, CG_ID, MERKLE_ROOT),
    ).toThrow(/uint72|identityId/);
  });

  it('rejects merkleRoot with wrong length', () => {
    expect(() =>
      computePublishPublisherDigest(CHAIN_ID, KAV10_ADDRESS, IDENTITY_ID, CG_ID, new Uint8Array(31)),
    ).toThrow(/merkleRoot/);
  });
});
