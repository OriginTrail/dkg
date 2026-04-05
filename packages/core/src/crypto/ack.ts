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
 * Encode a uint256 as a big-endian 32-byte Uint8Array.
 */
function uint256ToBytesValue(value: bigint): Uint8Array {
  const buf = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

/**
 * Compute the ACK digest that core nodes sign to attest data integrity.
 *
 * ACK = EIP-191(keccak256(abi.encodePacked(contextGraphId, merkleRoot, knowledgeAssetsAmount)))
 *
 * This function computes the inner digest (before EIP-191 prefix).
 * The EIP-191 prefix is applied by the signing function (e.g. ethers signMessage).
 *
 * @param contextGraphId - The uint256 context graph identifier
 * @param merkleRoot - The 32-byte merkle root of the triple set
 * @param kaCount - Optional number of knowledge assets (included in digest if provided)
 * @returns 32-byte keccak256 digest
 */
export function computeACKDigest(contextGraphId: bigint, merkleRoot: Uint8Array, kaCount?: number): Uint8Array {
  if (merkleRoot.length !== 32) {
    throw new Error(`merkleRoot must be 32 bytes, got ${merkleRoot.length}`);
  }
  if (kaCount !== undefined) {
    // V10.1+: include kaCount in digest to prevent mint count manipulation
    const packed = new Uint8Array(96);
    packed.set(uint256ToBytes(contextGraphId), 0);
    packed.set(merkleRoot, 32);
    packed.set(uint256ToBytesValue(BigInt(kaCount)), 64);
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
