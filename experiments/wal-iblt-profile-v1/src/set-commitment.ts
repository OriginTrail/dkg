import { WAL_OBJECT_ID_LENGTH, assertLength, compareBytes, concatBytes, copyBytes, u64be } from './bytes.js';
import { DOMAIN, hashBytes } from './hash.js';

export const SET_COMMITMENT_LEAF_CAPACITY = 256;
const MAX_NIBBLE_DEPTH = WAL_OBJECT_ID_LENGTH * 2;

interface CommitmentNode {
  count: number;
  hash: Uint8Array;
}

function nibbleAt(id: Uint8Array, depth: number): number {
  const byte = id[Math.floor(depth / 2)];
  return depth % 2 === 0 ? byte >>> 4 : byte & 0x0f;
}

export function packNibblePrefix(nibbles: readonly number[]): Uint8Array {
  if (nibbles.length > MAX_NIBBLE_DEPTH) throw new RangeError('nibble prefix is too long');
  const output = new Uint8Array(Math.ceil(nibbles.length / 2));
  for (let index = 0; index < nibbles.length; index += 1) {
    const nibble = nibbles[index];
    if (!Number.isInteger(nibble) || nibble < 0 || nibble > 15) throw new RangeError('invalid nibble');
    if (index % 2 === 0) output[Math.floor(index / 2)] = nibble << 4;
    else output[Math.floor(index / 2)] |= nibble;
  }
  return output;
}

function leafHash(ids: readonly Uint8Array[], prefix: readonly number[]): Uint8Array {
  return hashBytes(
    DOMAIN.setLeaf,
    Uint8Array.of(prefix.length),
    packNibblePrefix(prefix),
    u64be(BigInt(ids.length)),
    concatBytes(...ids)
  );
}

function buildNode(ids: readonly Uint8Array[], prefix: readonly number[]): CommitmentNode {
  if (ids.length <= SET_COMMITMENT_LEAF_CAPACITY) {
    return { count: ids.length, hash: leafHash(ids, prefix) };
  }
  const groups: Uint8Array[][] = Array.from({ length: 16 }, () => []);
  for (const id of ids) groups[nibbleAt(id, prefix.length)].push(id);
  const children: Uint8Array[] = [];
  let bitmap = 0;
  for (let nibble = 0; nibble < groups.length; nibble += 1) {
    const group = groups[nibble];
    if (group.length === 0) continue;
    bitmap |= 1 << nibble;
    const child = buildNode(group, [...prefix, nibble]);
    children.push(Uint8Array.of(nibble), u64be(BigInt(child.count)), child.hash);
  }
  const bitmapBytes = new Uint8Array(2);
  new DataView(bitmapBytes.buffer).setUint16(0, bitmap, false);
  return {
    count: ids.length,
    hash: hashBytes(
      DOMAIN.setBranch,
      Uint8Array.of(prefix.length),
      packNibblePrefix(prefix),
      bitmapBytes,
      ...children
    )
  };
}

export function setCommitment(ids: readonly Uint8Array[]): Uint8Array {
  if (ids.length === 0) return hashBytes(DOMAIN.setEmpty);
  const sorted = [...ids].map((id) => {
    assertLength(id, WAL_OBJECT_ID_LENGTH, 'walObjectId');
    return copyBytes(id);
  }).sort(compareBytes);
  for (let index = 1; index < sorted.length; index += 1) {
    if (compareBytes(sorted[index - 1], sorted[index]) === 0) throw new RangeError('duplicate WalObjectId');
  }
  return buildNode(sorted, []).hash;
}
