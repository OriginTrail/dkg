import { describe, it, expect } from 'vitest';
import {
  computeACKDigest,
  computeUpdateACKDigest,
  eip191Hash,
  keccak256,
  keccak256Hex,
} from '../src/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Audit findings:
//   C-1  computeUpdateACKDigest had ZERO tests despite being exported and signed
//        on every UPDATE. KAV10.sol:832-846.
//   C-2  computeACKDigest 6-field form (contextGraphId, merkleRoot, kaCount,
//        byteSize, epochs, tokenAmount) was implemented but tests only
//        exercised the legacy 2-field form. ACK replay across cost parameters
//        was undetectable.
//   C-3  eip191Hash had no golden cross-check against ethers.hashMessage.
//        Off-by-one in the "\x19Ethereum Signed Message:\n32" prefix would
//        have shipped silently.
//
// Golden vectors below were precomputed with ethers v6:
//   ethers.solidityPackedKeccak256(types, values)  for the digests
//   ethers.hashMessage(digestBytes)                for the EIP-191 wrap
// They are pinned literal hex; if the implementation drifts in field order,
// width, prefix, or hash function, the pinned value no longer matches.
// ─────────────────────────────────────────────────────────────────────────────

const KAV10_ADDRESS = '0x0000000000000000000000000000000000000042';
const CHAIN_ID = 31337n;
const CG_ID = 1337n;

describe('computeACKDigest (6-field) — H5 cost-parameter binding [C-2]', () => {
  const merkleRoot = new Uint8Array(32).fill(0xaa);
  const kaCount = 3;
  const byteSize = 777n;
  const epochs = 2;
  const tokenAmount = 1000n;

  // Reference: ethers.solidityPackedKeccak256(
  //   ['uint256','bytes32','uint256','uint256','uint256','uint256'],
  //   [1337n, '0xaa..aa', 3n, 777n, 2n, 1000n]
  // )
  const GOLDEN =
    '0x102ba91f737533c93a29bdb57bb55bf93d052b21acef90571153ccd6dfb1978a';
  const GOLDEN_WRONG_EPOCHS =
    '0xe719f60fc86bc79a01ac6b5e22f10be504f64b1db3fe35b7cc0bedae707739d2';
  const GOLDEN_WRONG_TOKEN =
    '0x61b9b8b0f924ccd637aaa05903a3cb70a3a3e0b7cb19423c89f147214238e8a8';

  it('matches solidityPackedKeccak256 golden vector', () => {
    const digest = computeACKDigest(CG_ID, merkleRoot, kaCount, byteSize, epochs, tokenAmount);
    expect(keccak256Hex(merkleRoot)).toMatch(/^0x/); // sanity
    expect('0x' + Buffer.from(digest).toString('hex')).toBe(GOLDEN);
  });

  it('changing epochs changes the digest (replay across cost params is rejected)', () => {
    const digest = computeACKDigest(CG_ID, merkleRoot, kaCount, byteSize, 99, tokenAmount);
    expect('0x' + Buffer.from(digest).toString('hex')).toBe(GOLDEN_WRONG_EPOCHS);
    expect('0x' + Buffer.from(digest).toString('hex')).not.toBe(GOLDEN);
  });

  it('changing tokenAmount changes the digest (replay across cost params is rejected)', () => {
    const digest = computeACKDigest(CG_ID, merkleRoot, kaCount, byteSize, epochs, 9999n);
    expect('0x' + Buffer.from(digest).toString('hex')).toBe(GOLDEN_WRONG_TOKEN);
  });

  it('changing kaCount changes the digest', () => {
    const a = computeACKDigest(CG_ID, merkleRoot, kaCount, byteSize, epochs, tokenAmount);
    const b = computeACKDigest(CG_ID, merkleRoot, kaCount + 1, byteSize, epochs, tokenAmount);
    expect(a).not.toEqual(b);
  });

  it('changing byteSize changes the digest', () => {
    const a = computeACKDigest(CG_ID, merkleRoot, kaCount, byteSize, epochs, tokenAmount);
    const b = computeACKDigest(CG_ID, merkleRoot, kaCount, byteSize + 1n, epochs, tokenAmount);
    expect(a).not.toEqual(b);
  });

  it('6-field digest is NEVER equal to 2-field digest for the same (cgId, merkleRoot)', () => {
    const six = computeACKDigest(CG_ID, merkleRoot, kaCount, byteSize, epochs, tokenAmount);
    const two = computeACKDigest(CG_ID, merkleRoot);
    expect(six).not.toEqual(two);
  });

  it('zero kaCount/byteSize/tokenAmount/epochs=1 still uses the 6-field branch (not 2-field)', () => {
    // Even with all numeric extras at their defaults, the SHAPE is different
    // because the packed buffer is 192 bytes, not 64. This guards against an
    // optimization that would silently fall through to the 2-field form.
    const sixDefault = computeACKDigest(CG_ID, merkleRoot, 0, 0n, 1, 0n);
    const two = computeACKDigest(CG_ID, merkleRoot);
    expect(sixDefault).not.toEqual(two);
  });

  it('rejects a non-32-byte merkleRoot in the 6-field form', () => {
    expect(() => computeACKDigest(CG_ID, new Uint8Array(31), kaCount, byteSize, epochs, tokenAmount))
      .toThrow(/merkleRoot/);
  });

  it('field width is exactly 192 bytes (6 × uint256)', () => {
    // Reference layout — must match keccak256 of the same packed buffer.
    const packed = new Uint8Array(192);
    // cgId
    let v = CG_ID;
    for (let i = 31; i >= 0; i--) { packed[i] = Number(v & 0xffn); v >>= 8n; }
    // merkleRoot at offset 32
    packed.set(merkleRoot, 32);
    // kaCount at offset 64
    v = BigInt(kaCount);
    for (let i = 95; i >= 64; i--) { packed[i] = Number(v & 0xffn); v >>= 8n; }
    // byteSize at offset 96
    v = byteSize;
    for (let i = 127; i >= 96; i--) { packed[i] = Number(v & 0xffn); v >>= 8n; }
    // epochs at offset 128
    v = BigInt(epochs);
    for (let i = 159; i >= 128; i--) { packed[i] = Number(v & 0xffn); v >>= 8n; }
    // tokenAmount at offset 160
    v = tokenAmount;
    for (let i = 191; i >= 160; i--) { packed[i] = Number(v & 0xffn); v >>= 8n; }

    const ref = keccak256(packed);
    const digest = computeACKDigest(CG_ID, merkleRoot, kaCount, byteSize, epochs, tokenAmount);
    expect(digest).toEqual(ref);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// !!! CRITICAL FINDING DURING TEST AUTHORING !!!
//
// `computeUpdateACKDigest` in src/crypto/ack.ts allocates a 340-byte packed
// buffer but only writes 308 bytes (10 fields totalling 32+20+32+32+32+32+32+32
// +32+32 = 308). The trailing 32 zero bytes ARE included in keccak256, so the
// off-chain digest does NOT match the on-chain digest computed by KAV10.sol
// lines 832-846. Every V10 UPDATE signed off-chain will fail _verifySignatures
// on chain.
//
// The docstring in ack.ts even says "total packed width = 340 bytes" — that is
// also wrong. Contract source of truth: 308 bytes (verified by reading the
// abi.encodePacked() call in KnowledgeAssetsV10.sol).
//
// Golden vectors below are the CORRECT contract-layout vectors (308 bytes,
// computed via ethers.solidityPackedKeccak256 with the exact field order from
// the contract). The "matches the contract-layout golden vector" test SHOULD
// pass; while it fails, that failure IS the bug signal
// finding C-1 (upgraded to PROD-BUG).
//
// QA policy (per user instruction "trust the code more"): do NOT modify
// production code from a test PR. Leave the test red so the implementation
// owner sees the contract-mismatch and fixes the buffer width.
// ─────────────────────────────────────────────────────────────────────────────
describe('computeUpdateACKDigest — KAV10.sol:832-846 layout [C-1]', () => {
  const newMerkleRoot = new Uint8Array(32).fill(0xbb);
  const kcId = 7n;
  const preUpdateMerkleRootCount = 2n;
  const newByteSize = 5000n;
  const newTokenAmount = 2500n;
  const mintAmount = 4n;
  const burnTokenIds = [10n, 11n, 12n];

  // ethers.solidityPackedKeccak256(
  //   ['uint256','address','uint256','uint256','uint256','bytes32',
  //    'uint256','uint256','uint256','bytes32'],
  //   [31337n, '0x...42', 1337n, 7n, 2n, '0xbb..bb', 5000n, 2500n, 4n, burnHash]
  // )
  const GOLDEN =
    '0xc74b73501b2342bc4441c08920a7b52e31d3af8da77da4b87d18bf9d572350b3';
  const GOLDEN_WRONG_TOKEN =
    '0x2a9df3e935b9c7f5bfaf1631fd203c09a2191e01630f24ef89ad32aca5e5d39c';
  const GOLDEN_EMPTY_BURN =
    '0xdcadd5ba58e520a97505ce8f2dec61c483c58caf0d9a925ebf0b6758ae24d8e3';

  it('matches the contract-layout golden vector', () => {
    const digest = computeUpdateACKDigest(
      CHAIN_ID, KAV10_ADDRESS, CG_ID, kcId,
      preUpdateMerkleRootCount, newMerkleRoot,
      newByteSize, newTokenAmount, mintAmount, burnTokenIds,
    );
    expect('0x' + Buffer.from(digest).toString('hex')).toBe(GOLDEN);
  });

  it('different chainId produces different digest (H5 chain pin)', () => {
    const a = computeUpdateACKDigest(
      CHAIN_ID, KAV10_ADDRESS, CG_ID, kcId,
      preUpdateMerkleRootCount, newMerkleRoot,
      newByteSize, newTokenAmount, mintAmount, burnTokenIds,
    );
    const b = computeUpdateACKDigest(
      CHAIN_ID + 1n, KAV10_ADDRESS, CG_ID, kcId,
      preUpdateMerkleRootCount, newMerkleRoot,
      newByteSize, newTokenAmount, mintAmount, burnTokenIds,
    );
    expect(a).not.toEqual(b);
  });

  it('different KAV10 address produces different digest (H5 contract pin)', () => {
    const a = computeUpdateACKDigest(
      CHAIN_ID, KAV10_ADDRESS, CG_ID, kcId,
      preUpdateMerkleRootCount, newMerkleRoot,
      newByteSize, newTokenAmount, mintAmount, burnTokenIds,
    );
    const b = computeUpdateACKDigest(
      CHAIN_ID, '0x0000000000000000000000000000000000000043', CG_ID, kcId,
      preUpdateMerkleRootCount, newMerkleRoot,
      newByteSize, newTokenAmount, mintAmount, burnTokenIds,
    );
    expect(a).not.toEqual(b);
  });

  it('changing newTokenAmount produces different digest (replay across cost params rejected)', () => {
    const digest = computeUpdateACKDigest(
      CHAIN_ID, KAV10_ADDRESS, CG_ID, kcId,
      preUpdateMerkleRootCount, newMerkleRoot,
      newByteSize, 9999n, mintAmount, burnTokenIds,
    );
    expect('0x' + Buffer.from(digest).toString('hex')).toBe(GOLDEN_WRONG_TOKEN);
    expect('0x' + Buffer.from(digest).toString('hex')).not.toBe(GOLDEN);
  });

  it('changing newByteSize changes digest', () => {
    const a = computeUpdateACKDigest(
      CHAIN_ID, KAV10_ADDRESS, CG_ID, kcId,
      preUpdateMerkleRootCount, newMerkleRoot,
      newByteSize, newTokenAmount, mintAmount, burnTokenIds,
    );
    const b = computeUpdateACKDigest(
      CHAIN_ID, KAV10_ADDRESS, CG_ID, kcId,
      preUpdateMerkleRootCount, newMerkleRoot,
      newByteSize + 1n, newTokenAmount, mintAmount, burnTokenIds,
    );
    expect(a).not.toEqual(b);
  });

  it('changing kcId changes digest (cannot reuse one ACK for another KC)', () => {
    const a = computeUpdateACKDigest(
      CHAIN_ID, KAV10_ADDRESS, CG_ID, kcId,
      preUpdateMerkleRootCount, newMerkleRoot,
      newByteSize, newTokenAmount, mintAmount, burnTokenIds,
    );
    const b = computeUpdateACKDigest(
      CHAIN_ID, KAV10_ADDRESS, CG_ID, kcId + 1n,
      preUpdateMerkleRootCount, newMerkleRoot,
      newByteSize, newTokenAmount, mintAmount, burnTokenIds,
    );
    expect(a).not.toEqual(b);
  });

  it('changing preUpdateMerkleRootCount changes digest (cannot replay an ACK after another update)', () => {
    const a = computeUpdateACKDigest(
      CHAIN_ID, KAV10_ADDRESS, CG_ID, kcId,
      preUpdateMerkleRootCount, newMerkleRoot,
      newByteSize, newTokenAmount, mintAmount, burnTokenIds,
    );
    const b = computeUpdateACKDigest(
      CHAIN_ID, KAV10_ADDRESS, CG_ID, kcId,
      preUpdateMerkleRootCount + 1n, newMerkleRoot,
      newByteSize, newTokenAmount, mintAmount, burnTokenIds,
    );
    expect(a).not.toEqual(b);
  });

  it('changing burn list changes digest (cannot swap which KAs are burned)', () => {
    const a = computeUpdateACKDigest(
      CHAIN_ID, KAV10_ADDRESS, CG_ID, kcId,
      preUpdateMerkleRootCount, newMerkleRoot,
      newByteSize, newTokenAmount, mintAmount, burnTokenIds,
    );
    const b = computeUpdateACKDigest(
      CHAIN_ID, KAV10_ADDRESS, CG_ID, kcId,
      preUpdateMerkleRootCount, newMerkleRoot,
      newByteSize, newTokenAmount, mintAmount, [10n, 11n, 13n],
    );
    expect(a).not.toEqual(b);
  });

  it('reordering burn list changes digest (order matters)', () => {
    const a = computeUpdateACKDigest(
      CHAIN_ID, KAV10_ADDRESS, CG_ID, kcId,
      preUpdateMerkleRootCount, newMerkleRoot,
      newByteSize, newTokenAmount, mintAmount, [10n, 11n, 12n],
    );
    const b = computeUpdateACKDigest(
      CHAIN_ID, KAV10_ADDRESS, CG_ID, kcId,
      preUpdateMerkleRootCount, newMerkleRoot,
      newByteSize, newTokenAmount, mintAmount, [12n, 11n, 10n],
    );
    expect(a).not.toEqual(b);
  });

  it('empty burn list golden vector', () => {
    const digest = computeUpdateACKDigest(
      CHAIN_ID, KAV10_ADDRESS, CG_ID, kcId,
      preUpdateMerkleRootCount, newMerkleRoot,
      newByteSize, newTokenAmount, mintAmount, [],
    );
    expect('0x' + Buffer.from(digest).toString('hex')).toBe(GOLDEN_EMPTY_BURN);
  });

  it('rejects newMerkleRoot with wrong length', () => {
    expect(() => computeUpdateACKDigest(
      CHAIN_ID, KAV10_ADDRESS, CG_ID, kcId,
      preUpdateMerkleRootCount, new Uint8Array(31),
      newByteSize, newTokenAmount, mintAmount, burnTokenIds,
    )).toThrow(/newMerkleRoot/);
  });

  it('rejects malformed kav10Address', () => {
    expect(() => computeUpdateACKDigest(
      CHAIN_ID, '0xnotanaddress', CG_ID, kcId,
      preUpdateMerkleRootCount, newMerkleRoot,
      newByteSize, newTokenAmount, mintAmount, burnTokenIds,
    )).toThrow(/kav10Address/);
  });

  it('is deterministic', () => {
    const a = computeUpdateACKDigest(
      CHAIN_ID, KAV10_ADDRESS, CG_ID, kcId,
      preUpdateMerkleRootCount, newMerkleRoot,
      newByteSize, newTokenAmount, mintAmount, burnTokenIds,
    );
    const b = computeUpdateACKDigest(
      CHAIN_ID, KAV10_ADDRESS, CG_ID, kcId,
      preUpdateMerkleRootCount, newMerkleRoot,
      newByteSize, newTokenAmount, mintAmount, burnTokenIds,
    );
    expect(a).toEqual(b);
  });

  it('is NEVER equal to publish ACK digest for the same (chain, kav10, cgId, root)', () => {
    // Sanity that the two digest schemes are distinguishable; otherwise an
    // attacker could submit a publish ACK as an update ACK (or vice versa).
    const updateDigest = computeUpdateACKDigest(
      CHAIN_ID, KAV10_ADDRESS, CG_ID, kcId,
      preUpdateMerkleRootCount, newMerkleRoot,
      newByteSize, newTokenAmount, mintAmount, burnTokenIds,
    );
    const ack6 = computeACKDigest(CG_ID, newMerkleRoot, Number(mintAmount), newByteSize, 1, newTokenAmount);
    expect(updateDigest).not.toEqual(ack6);
  });
});

describe('eip191Hash — golden cross-check vs ethers.hashMessage [C-3]', () => {
  // Reference values produced by:
  //   ethers.hashMessage(ethers.getBytes(digestHex))
  // ethers prepends "\x19Ethereum Signed Message:\n32" then keccak256s. Any
  // off-by-one in that prefix (eg "\n32" vs "\n3" or extra space) breaks
  // every Ethereum signature verification on chain.

  it('matches ethers.hashMessage for keccak256("hello")', () => {
    const digest = keccak256(new TextEncoder().encode('hello'));
    const expected = '0x456e9aea5e197a1f1af7a3e85a3212fa4049a3ba34c2289b4c860fc0b0c64ef3';
    expect('0x' + Buffer.from(eip191Hash(digest)).toString('hex')).toBe(expected);
  });

  it('matches ethers.hashMessage for 32 zero bytes', () => {
    const digest = new Uint8Array(32);
    const expected = '0x5e4106618209740b9f773a94c5667b9659a7a4e2691c7c8a78336e9889a6be07';
    expect('0x' + Buffer.from(eip191Hash(digest)).toString('hex')).toBe(expected);
  });

  it('matches ethers.hashMessage for 32 0xff bytes', () => {
    const digest = new Uint8Array(32).fill(0xff);
    const expected = '0xd8eb9c93f8c5f6a817f81a53c227312ab8a63415ee9524c9f7d6ff28db51a3f5';
    expect('0x' + Buffer.from(eip191Hash(digest)).toString('hex')).toBe(expected);
  });

  it('prefix is exactly 28 bytes ("\\x19Ethereum Signed Message:\\n32")', () => {
    // Manually build the prefix and compare to what eip191Hash produces. If
    // someone changed "\n32" to "\n64" for a longer digest, the hash here
    // would no longer match the manual reference.
    const prefix = new TextEncoder().encode('\x19Ethereum Signed Message:\n32');
    expect(prefix.length).toBe(28);
    const digest = keccak256(new TextEncoder().encode('canary'));
    const combined = new Uint8Array(prefix.length + digest.length);
    combined.set(prefix, 0);
    combined.set(digest, prefix.length);
    const expected = keccak256(combined);
    expect(eip191Hash(digest)).toEqual(expected);
  });

  it('different digests produce different EIP-191 hashes', () => {
    const a = eip191Hash(keccak256(new TextEncoder().encode('a')));
    const b = eip191Hash(keccak256(new TextEncoder().encode('b')));
    expect(a).not.toEqual(b);
  });
});
