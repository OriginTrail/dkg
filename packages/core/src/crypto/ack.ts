import { keccak256 } from './keccak.js';

/**
 * Encode a uint256 as a big-endian 32-byte Uint8Array (abi.encodePacked format).
 */
function uint256ToBytes(value: bigint): Uint8Array {
  const buf = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

/**
 * LEGACY 2-field / 6-field ACK digest used by the **verify-proposal** flow
 * (`verify-proposal-handler.ts`, `verify-collector.ts`). NOT used by the
 * V10 publish path — see `computePublishACKDigest` below for the
 * H5-prefixed 8-field layout that matches `KnowledgeAssetsV10.sol:362-373`.
 *
 * This function has two shapes kept for backward compatibility:
 *   - 2-field: `keccak256(abi.encodePacked(contextGraphId, merkleRoot))`
 *     when `kaCount` is omitted.
 *   - 6-field: `keccak256(abi.encodePacked(contextGraphId, merkleRoot,
 *     kaCount, byteSize, epochs, tokenAmount))` when all extra fields
 *     are supplied.
 *
 * Neither shape carries the chain/contract domain separation that the
 * V10 publish digest requires. Any V10 publish-path signer MUST use
 * `computePublishACKDigest` instead.
 *
 * Returns the inner digest only; the EIP-191 prefix is applied by the
 * signing function (e.g. `ethers.Wallet.signMessage`).
 *
 * @param contextGraphId - The uint256 context graph identifier
 * @param merkleRoot - The 32-byte merkle root of the triple set
 * @param kaCount - Optional number of knowledge assets
 * @param byteSize - Optional public byte size (uint88 on-chain, packed as uint256)
 * @param epochs - Optional number of epochs (default 1)
 * @param tokenAmount - Optional TRAC token amount
 * @returns 32-byte keccak256 digest
 */
export function computeACKDigest(
  contextGraphId: bigint,
  merkleRoot: Uint8Array,
  kaCount?: number,
  byteSize?: bigint,
  epochs?: number,
  tokenAmount?: bigint,
): Uint8Array {
  if (merkleRoot.length !== 32) {
    throw new Error(`merkleRoot must be 32 bytes, got ${merkleRoot.length}`);
  }
  if (kaCount !== undefined) {
    // 6-field V10 digest: contextGraphId + merkleRoot + kaCount + byteSize + epochs + tokenAmount
    const packed = new Uint8Array(192);
    packed.set(uint256ToBytes(contextGraphId), 0);
    packed.set(merkleRoot, 32);
    packed.set(uint256ToBytes(BigInt(kaCount)), 64);
    packed.set(uint256ToBytes(byteSize ?? 0n), 96);
    packed.set(uint256ToBytes(BigInt(epochs ?? 1)), 128);
    packed.set(uint256ToBytes(tokenAmount ?? 0n), 160);
    return keccak256(packed);
  }
  const packed = new Uint8Array(64);
  packed.set(uint256ToBytes(contextGraphId), 0);
  packed.set(merkleRoot, 32);
  return keccak256(packed);
}

/**
 * Apply the EIP-191 "personal sign" prefix and hash.
 * Equivalent to: keccak256("\x19Ethereum Signed Message:\n32" + digest)
 */
export function eip191Hash(digest: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode('\x19Ethereum Signed Message:\n32');
  const combined = new Uint8Array(prefix.length + digest.length);
  combined.set(prefix, 0);
  combined.set(digest, prefix.length);
  return keccak256(combined);
}

export { uint256ToBytes };

/**
 * Parse a 0x-prefixed 20-byte EVM address into raw bytes.
 * Throws on malformed input. Used by the V10 publish digest builders so
 * the address packs to its natural 20-byte width under abi.encodePacked.
 */
function addressToBytes(address: string): Uint8Array {
  if (typeof address !== 'string' || address.length !== 42 || !address.startsWith('0x')) {
    throw new Error(`kav10Address must be a 0x-prefixed 20-byte hex string, got: ${address}`);
  }
  const hex = address.slice(2);
  if (!/^[0-9a-fA-F]{40}$/.test(hex)) {
    throw new Error(`kav10Address contains non-hex characters: ${address}`);
  }
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Encode a uint72 value as 9 big-endian bytes (natural width under
 * Solidity `abi.encodePacked`). Throws on overflow.
 */
function uint72ToBytes(value: bigint): Uint8Array {
  if (value < 0n || value > (1n << 72n) - 1n) {
    throw new Error(`identityId must fit in uint72, got: ${value}`);
  }
  const buf = new Uint8Array(9);
  let v = value;
  for (let i = 8; i >= 0; i--) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

/**
 * Compute the V10 publish ACK digest that each receiving core node signs.
 *
 * Layout matches `KnowledgeAssetsV10.sol:362-373` exactly:
 *   keccak256(abi.encodePacked(
 *     block.chainid,            // uint256 (32)
 *     address(this),            // address (20) — the deployed KAV10 address
 *     contextGraphId,           // uint256 (32)
 *     merkleRoot,               // bytes32 (32)
 *     knowledgeAssetsAmount,    // uint256 (32)
 *     uint256(byteSize),        // uint256 (32) — cast from uint88 in contract
 *     uint256(epochs),          // uint256 (32) — cast from uint40 in contract
 *     uint256(tokenAmount)      // uint256 (32) — cast from uint96 in contract
 *   ))                          // total packed width = 244 bytes
 *
 * The contract wraps this with `ECDSA.toEthSignedMessageHash` (EIP-191)
 * before recovery; off-chain, `signer.signMessage(returnedBytes)` applies
 * the same wrap.
 *
 * H5 closure: the leading (chainid, kav10Address) prefix pins signatures to
 * this chain and this contract. Replay across chains / forks / contract
 * redeployments is rejected at signature verification.
 */
export function computePublishACKDigest(
  chainId: bigint,
  kav10Address: string,
  contextGraphId: bigint,
  merkleRoot: Uint8Array,
  kaCount: bigint,
  byteSize: bigint,
  epochs: bigint,
  tokenAmount: bigint,
): Uint8Array {
  if (merkleRoot.length !== 32) {
    throw new Error(`merkleRoot must be 32 bytes, got ${merkleRoot.length}`);
  }
  const addrBytes = addressToBytes(kav10Address);

  const packed = new Uint8Array(244);
  let offset = 0;
  packed.set(uint256ToBytes(chainId), offset); offset += 32;
  packed.set(addrBytes, offset); offset += 20;
  packed.set(uint256ToBytes(contextGraphId), offset); offset += 32;
  packed.set(merkleRoot, offset); offset += 32;
  packed.set(uint256ToBytes(kaCount), offset); offset += 32;
  packed.set(uint256ToBytes(byteSize), offset); offset += 32;
  packed.set(uint256ToBytes(epochs), offset); offset += 32;
  packed.set(uint256ToBytes(tokenAmount), offset); offset += 32;

  return keccak256(packed);
}

/**
 * Compute the V10 publish publisher digest that the publishing node's
 * operational key signs.
 *
 * Layout matches `KnowledgeAssetsV10.sol:327-335` exactly:
 *   keccak256(abi.encodePacked(
 *     block.chainid,            // uint256 (32)
 *     address(this),            // address (20) — the deployed KAV10 address
 *     publisherNodeIdentityId,  // uint72  (9)  — natural width
 *     contextGraphId,           // uint256 (32)
 *     merkleRoot                // bytes32 (32)
 *   ))                          // total packed width = 125 bytes
 *
 * N26 closure: `identityId` comes BEFORE `contextGraphId`. Swapping them
 * produces a different digest that the contract rejects at
 * `_verifySignature`.
 */
export function computePublishPublisherDigest(
  chainId: bigint,
  kav10Address: string,
  publisherNodeIdentityId: bigint,
  contextGraphId: bigint,
  merkleRoot: Uint8Array,
): Uint8Array {
  if (merkleRoot.length !== 32) {
    throw new Error(`merkleRoot must be 32 bytes, got ${merkleRoot.length}`);
  }
  const addrBytes = addressToBytes(kav10Address);
  const idBytes = uint72ToBytes(publisherNodeIdentityId);

  const packed = new Uint8Array(125);
  let offset = 0;
  packed.set(uint256ToBytes(chainId), offset); offset += 32;
  packed.set(addrBytes, offset); offset += 20;
  packed.set(idBytes, offset); offset += 9;
  packed.set(uint256ToBytes(contextGraphId), offset); offset += 32;
  packed.set(merkleRoot, offset); offset += 32;

  return keccak256(packed);
}
