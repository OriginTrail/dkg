/**
 * v10-kc-helpers-extra.test.ts — audit coverage (E-15).
 *
 * Finding E-15 (MEDIUM, TEST-DEBT, see .test-audit/BUGS_FOUND.md):
 *   "Helpers (v10-kc-helpers.ts etc.) mirror contract behavior but are
 *    not tested themselves. Parallel bug in helper + contract → false
 *    positive."
 *
 * Goal: pin the EXACT byte layout of every V10 digest the helpers emit.
 * If anyone silently reorders a field or drops a type (say, `uint72` →
 * `uint256` on publisher identityId, or "forgets" the H5 chainid prefix),
 * an identical change in the contract would hide the bug — but this file
 * would catch it because it uses an INDEPENDENT second source of truth
 * (`ethers.concat` + `ethers.keccak256` with explicit `zeroPad/toBeHex`)
 * to compute the expected digest.
 *
 * Contract ABI reference (must stay in lockstep with `KnowledgeAssetsV10.sol`):
 *   Publisher digest:
 *     keccak256(abi.encodePacked(
 *       block.chainid        uint256
 *       address(this)        address
 *       publisherIdentityId  uint72
 *       contextGraphId       uint256
 *       merkleRoot           bytes32
 *     ))
 *
 *   Publish ACK digest:
 *     keccak256(abi.encodePacked(
 *       block.chainid                uint256
 *       address(this)                address
 *       contextGraphId               uint256
 *       merkleRoot                   bytes32
 *       knowledgeAssetsAmount        uint256  (cast in contract)
 *       byteSize                     uint256  (cast)
 *       epochs                       uint256  (cast)
 *       tokenAmount                  uint256
 *     ))
 *
 *   Update ACK digest:
 *     keccak256(abi.encodePacked(
 *       chainid, kav10, contextGraphId, id,
 *       preUpdateMerkleRootCount, newMerkleRoot,
 *       newByteSize, newTokenAmount, mintKnowledgeAssetsAmount,
 *       keccak256(abi.encodePacked(knowledgeAssetsToBurn))
 *     ))
 */
import { expect } from 'chai';
import { ethers } from 'ethers';

import {
  buildPublishAckDigest,
  buildPublisherDigest,
  buildUpdateAckDigest,
  DEFAULT_CHAIN_ID,
} from '../helpers/v10-kc-helpers';

// Independent second-source encoder: builds `abi.encodePacked` layouts by
// byte-concatenation so any drift in `ethers.solidityPackedKeccak256` also
// shows up here.
function hex(bytes: number, n: bigint | number): string {
  return ethers.zeroPadValue(ethers.toBeHex(BigInt(n)), bytes);
}
function addr(a: string): string {
  return ethers.getAddress(a); // normalized 20-byte addr
}

describe('@unit v10-kc-helpers — digest byte-layout pins (E-15)', () => {
  const chainId = DEFAULT_CHAIN_ID;
  const kav10 = '0x1234567890123456789012345678901234567890';
  const publisherIdentityId = 7n;
  const contextGraphId = 99n;
  const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('mr-extra-test'));

  it('DEFAULT_CHAIN_ID is 31337 (hardhat)', () => {
    expect(chainId).to.equal(31337n);
  });

  it('buildPublisherDigest matches an independent abi.encodePacked reference', () => {
    const got = buildPublisherDigest(
      chainId,
      kav10,
      publisherIdentityId,
      contextGraphId,
      merkleRoot,
    );

    // abi.encodePacked(uint256, address, uint72, uint256, bytes32)
    const packed = ethers.concat([
      hex(32, chainId), // uint256
      addr(kav10), // address (20 bytes, no pad)
      hex(9, publisherIdentityId), // uint72 (9 bytes, no padding in encodePacked)
      hex(32, contextGraphId), // uint256
      merkleRoot, // bytes32
    ]);
    const expected = ethers.keccak256(packed);
    expect(got).to.equal(expected);
  });

  it('buildPublisherDigest is sensitive to chainId (H5 closure)', () => {
    const a = buildPublisherDigest(31337n, kav10, 1, 1n, merkleRoot);
    const b = buildPublisherDigest(1n, kav10, 1, 1n, merkleRoot);
    expect(a).to.not.equal(b);
  });

  it('buildPublisherDigest is sensitive to kav10Address (H5 closure)', () => {
    const a = buildPublisherDigest(chainId, kav10, 1, 1n, merkleRoot);
    const b = buildPublisherDigest(
      chainId,
      '0x0000000000000000000000000000000000000001',
      1,
      1n,
      merkleRoot,
    );
    expect(a).to.not.equal(b);
  });

  it('buildPublisherDigest is sensitive to merkleRoot', () => {
    const a = buildPublisherDigest(chainId, kav10, 1, 1n, merkleRoot);
    const b = buildPublisherDigest(
      chainId,
      kav10,
      1,
      1n,
      ethers.keccak256(ethers.toUtf8Bytes('OTHER')),
    );
    expect(a).to.not.equal(b);
  });

  it('buildPublishAckDigest matches an independent abi.encodePacked reference', () => {
    const knowledgeAssetsAmount = 3;
    const byteSize = 4096;
    const epochs = 7;
    const tokenAmount = ethers.parseEther('1');

    const got = buildPublishAckDigest(
      chainId,
      kav10,
      contextGraphId,
      merkleRoot,
      knowledgeAssetsAmount,
      byteSize,
      epochs,
      tokenAmount,
    );

    // abi.encodePacked(uint256, address, uint256, bytes32, uint256, uint256, uint256, uint256)
    const packed = ethers.concat([
      hex(32, chainId),
      addr(kav10),
      hex(32, contextGraphId),
      merkleRoot,
      hex(32, knowledgeAssetsAmount),
      hex(32, byteSize),
      hex(32, epochs),
      hex(32, tokenAmount),
    ]);
    const expected = ethers.keccak256(packed);
    expect(got).to.equal(expected);
  });

  it('buildPublishAckDigest encodes byteSize/epochs/tokenAmount as uint256 (cast pin)', () => {
    // If any of these were encoded as their native widths (e.g. uint64),
    // the second-source recomputation below would mismatch. This test
    // pins the cast-to-uint256 behavior documented in the PRD.
    const a = buildPublishAckDigest(chainId, kav10, 1n, merkleRoot, 1, 1, 1, 1n);
    const packed = ethers.concat([
      hex(32, chainId),
      addr(kav10),
      hex(32, 1n),
      merkleRoot,
      hex(32, 1),
      hex(32, 1),
      hex(32, 1),
      hex(32, 1n),
    ]);
    expect(a).to.equal(ethers.keccak256(packed));
  });

  it('buildPublishAckDigest is sensitive to every field (no silent coalescing)', () => {
    const base = buildPublishAckDigest(chainId, kav10, 1n, merkleRoot, 1, 1, 1, 1n);
    const variations = [
      buildPublishAckDigest(1n, kav10, 1n, merkleRoot, 1, 1, 1, 1n), // chainId
      buildPublishAckDigest(chainId, '0x000000000000000000000000000000000000dEaD', 1n, merkleRoot, 1, 1, 1, 1n), // kav10
      buildPublishAckDigest(chainId, kav10, 2n, merkleRoot, 1, 1, 1, 1n), // cgId
      buildPublishAckDigest(chainId, kav10, 1n, ethers.keccak256('0x01'), 1, 1, 1, 1n), // mr
      buildPublishAckDigest(chainId, kav10, 1n, merkleRoot, 2, 1, 1, 1n), // kaAmount
      buildPublishAckDigest(chainId, kav10, 1n, merkleRoot, 1, 2, 1, 1n), // byteSize
      buildPublishAckDigest(chainId, kav10, 1n, merkleRoot, 1, 1, 2, 1n), // epochs
      buildPublishAckDigest(chainId, kav10, 1n, merkleRoot, 1, 1, 1, 2n), // tokenAmount
    ];
    for (const v of variations) expect(v).to.not.equal(base);
    // And no two variations collide (paranoid):
    const all = new Set([base, ...variations]);
    expect(all.size).to.equal(variations.length + 1);
  });

  it('buildUpdateAckDigest matches an independent abi.encodePacked reference', () => {
    const id = 42n;
    const preUpdate = 1n;
    const newMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes('new-mr'));
    const newByteSize = 2048n;
    const newTokenAmount = ethers.parseEther('0.5');
    const mintAmount = 2n;
    const burn = [1n, 2n];

    const got = buildUpdateAckDigest(
      chainId,
      kav10,
      contextGraphId,
      id,
      preUpdate,
      newMerkleRoot,
      newByteSize,
      newTokenAmount,
      mintAmount,
      burn,
    );

    // Inner: keccak256(abi.encodePacked(uint256[]))
    const innerPacked = ethers.concat(burn.map((b) => hex(32, b)));
    const innerHash = ethers.keccak256(innerPacked);

    const outerPacked = ethers.concat([
      hex(32, chainId),
      addr(kav10),
      hex(32, contextGraphId),
      hex(32, id),
      hex(32, preUpdate),
      newMerkleRoot,
      hex(32, newByteSize),
      hex(32, newTokenAmount),
      hex(32, mintAmount),
      innerHash,
    ]);
    const expected = ethers.keccak256(outerPacked);
    expect(got).to.equal(expected);
  });

  it('buildUpdateAckDigest inner burn-list hash: two distinct lists → two distinct outputs', () => {
    const base = buildUpdateAckDigest(
      chainId,
      kav10,
      1n,
      1n,
      1n,
      merkleRoot,
      1n,
      1n,
      1n,
      [1n, 2n],
    );
    const reordered = buildUpdateAckDigest(
      chainId,
      kav10,
      1n,
      1n,
      1n,
      merkleRoot,
      1n,
      1n,
      1n,
      [2n, 1n], // order matters in abi.encodePacked(uint256[])
    );
    expect(base).to.not.equal(reordered);

    const empty = buildUpdateAckDigest(
      chainId,
      kav10,
      1n,
      1n,
      1n,
      merkleRoot,
      1n,
      1n,
      1n,
      [],
    );
    expect(empty).to.not.equal(base);
  });

  it('buildUpdateAckDigest is sensitive to preUpdateMerkleRootCount', () => {
    // preUpdateMerkleRootCount is the field the contract reads from
    // `KnowledgeCollectionStorage.getKnowledgeCollectionMetadata` during
    // update — off-by-one here means signature forgery against a
    // same-id same-root update. Critical pin.
    const a = buildUpdateAckDigest(chainId, kav10, 1n, 1n, 1n, merkleRoot, 1n, 1n, 1n, [1n]);
    const b = buildUpdateAckDigest(chainId, kav10, 1n, 1n, 2n, merkleRoot, 1n, 1n, 1n, [1n]);
    expect(a).to.not.equal(b);
  });
});
