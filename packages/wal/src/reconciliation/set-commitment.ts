import {
  WAL_OBJECT_ID_LENGTH,
  bytesToHex,
  compareBytes,
  concatBytes,
  equalBytes,
  u64be
} from './bytes.js';
import { ReconciliationError } from './errors.js';
import { DOMAIN, hashBytes } from './hash.js';
import {
  setCommitmentRoot,
  walObjectId,
  type SetCommitmentRoot,
  type WalObjectId
} from './ids.js';

export const SET_COMMITMENT_LEAF_CAPACITY = 256;
const MAX_NIBBLE_DEPTH = WAL_OBJECT_ID_LENGTH * 2;
const SNAPSHOT_MAGIC = new TextEncoder().encode('DKGWSET1');

interface CommitmentNodeBase {
  prefix: number[];
  count: number;
  hash: SetCommitmentRoot;
}

interface LeafNode extends CommitmentNodeBase {
  kind: 'leaf';
  ids: WalObjectId[];
}

interface BranchNode extends CommitmentNodeBase {
  kind: 'branch';
  children: Array<CommitmentNode | undefined>;
}

type CommitmentNode = LeafNode | BranchNode;

function nibbleAt(id: WalObjectId, depth: number): number {
  const byte = id[Math.floor(depth / 2)];
  return depth % 2 === 0 ? byte >>> 4 : byte & 0x0f;
}

export function packNibblePrefix(nibbles: readonly number[]): Uint8Array {
  if (nibbles.length > MAX_NIBBLE_DEPTH) {
    throw new ReconciliationError('INVALID_CONFIGURATION', 'nibble prefix is too long');
  }
  const output = new Uint8Array(Math.ceil(nibbles.length / 2));
  for (let index = 0; index < nibbles.length; index += 1) {
    const nibble = nibbles[index];
    if (!Number.isInteger(nibble) || nibble < 0 || nibble > 15) {
      throw new ReconciliationError('INVALID_CONFIGURATION', 'invalid nibble');
    }
    if (index % 2 === 0) output[Math.floor(index / 2)] = nibble << 4;
    else output[Math.floor(index / 2)] |= nibble;
  }
  return output;
}

function hashLeaf(ids: readonly WalObjectId[], prefix: readonly number[]): SetCommitmentRoot {
  return setCommitmentRoot(hashBytes(
    DOMAIN.setLeaf,
    Uint8Array.of(prefix.length),
    packNibblePrefix(prefix),
    u64be(BigInt(ids.length)),
    concatBytes(...ids)
  ));
}

function hashBranch(node: Pick<BranchNode, 'prefix' | 'children'>): SetCommitmentRoot {
  const children: Uint8Array[] = [];
  let bitmap = 0;
  for (let nibble = 0; nibble < node.children.length; nibble += 1) {
    const child = node.children[nibble];
    if (child === undefined) continue;
    bitmap |= 1 << nibble;
    children.push(Uint8Array.of(nibble), u64be(BigInt(child.count)), child.hash);
  }
  const bitmapBytes = new Uint8Array(2);
  new DataView(bitmapBytes.buffer).setUint16(0, bitmap, false);
  return setCommitmentRoot(hashBytes(
    DOMAIN.setBranch,
    Uint8Array.of(node.prefix.length),
    packNibblePrefix(node.prefix),
    bitmapBytes,
    ...children
  ));
}

function leaf(ids: readonly WalObjectId[], prefix: readonly number[]): LeafNode {
  const copied = ids.map(walObjectId);
  return { kind: 'leaf', prefix: [...prefix], count: copied.length, ids: copied, hash: hashLeaf(copied, prefix) };
}

function branch(children: Array<CommitmentNode | undefined>, prefix: readonly number[]): BranchNode {
  const node: BranchNode = {
    kind: 'branch',
    prefix: [...prefix],
    count: children.reduce((sum, child) => sum + (child?.count ?? 0), 0),
    children,
    hash: setCommitmentRoot(new Uint8Array(32))
  };
  node.hash = hashBranch(node);
  return node;
}

function buildNode(ids: readonly WalObjectId[], prefix: readonly number[]): CommitmentNode {
  if (ids.length <= SET_COMMITMENT_LEAF_CAPACITY) return leaf(ids, prefix);
  const groups: WalObjectId[][] = Array.from({ length: 16 }, () => []);
  for (const id of ids) groups[nibbleAt(id, prefix.length)].push(id);
  const children = groups.map((group, nibble) => group.length === 0 ? undefined : buildNode(group, [...prefix, nibble]));
  return branch(children, prefix);
}

function sortedUnique(ids: readonly WalObjectId[]): WalObjectId[] {
  const sorted = ids.map(walObjectId).sort(compareBytes);
  for (let index = 1; index < sorted.length; index += 1) {
    if (equalBytes(sorted[index - 1], sorted[index])) {
      throw new ReconciliationError('DUPLICATE_WAL_OBJECT_ID', `duplicate WalObjectId: ${bytesToHex(sorted[index])}`);
    }
  }
  return sorted;
}

function findId(ids: readonly WalObjectId[], id: WalObjectId): { found: boolean; index: number } {
  let low = 0;
  let high = ids.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const comparison = compareBytes(ids[middle], id);
    if (comparison < 0) low = middle + 1;
    else high = middle;
  }
  return { found: low < ids.length && equalBytes(ids[low], id), index: low };
}

function collectIds(node: CommitmentNode, output: WalObjectId[]): void {
  if (node.kind === 'leaf') {
    output.push(...node.ids.map(walObjectId));
    return;
  }
  for (const child of node.children) {
    if (child === undefined) continue;
    collectIds(child, output);
  }
}

function insertNode(node: CommitmentNode, id: WalObjectId): CommitmentNode {
  if (node.kind === 'leaf') {
    const position = findId(node.ids, id);
    if (position.found) {
      throw new ReconciliationError('DUPLICATE_WAL_OBJECT_ID', `duplicate WalObjectId: ${bytesToHex(id)}`);
    }
    const ids = [...node.ids];
    ids.splice(position.index, 0, walObjectId(id));
    return ids.length <= SET_COMMITMENT_LEAF_CAPACITY ? leaf(ids, node.prefix) : buildNode(ids, node.prefix);
  }
  const nibble = nibbleAt(id, node.prefix.length);
  const children = [...node.children];
  const child = children[nibble];
  children[nibble] = child === undefined
    ? leaf([id], [...node.prefix, nibble])
    : insertNode(child, id);
  return branch(children, node.prefix);
}

function deleteNode(node: CommitmentNode, id: WalObjectId): { node?: CommitmentNode; deleted: boolean } {
  if (node.kind === 'leaf') {
    const position = findId(node.ids, id);
    if (!position.found) return { node, deleted: false };
    const ids = [...node.ids];
    ids.splice(position.index, 1);
    return ids.length === 0 ? { deleted: true } : { node: leaf(ids, node.prefix), deleted: true };
  }
  const nibble = nibbleAt(id, node.prefix.length);
  const child = node.children[nibble];
  if (child === undefined) return { node, deleted: false };
  const result = deleteNode(child, id);
  if (!result.deleted) return { node, deleted: false };
  const children = [...node.children];
  children[nibble] = result.node;
  const updated = branch(children, node.prefix);
  if (updated.count <= SET_COMMITMENT_LEAF_CAPACITY) {
    const ids: WalObjectId[] = [];
    collectIds(updated, ids);
    return { node: leaf(ids, node.prefix), deleted: true };
  }
  return { node: updated, deleted: true };
}

export function setCommitment(ids: readonly WalObjectId[]): SetCommitmentRoot {
  if (ids.length === 0) return setCommitmentRoot(hashBytes(DOMAIN.setEmpty));
  return buildNode(sortedUnique(ids), []).hash;
}

export class MutableSetCommitment {
  #root?: CommitmentNode;

  constructor(ids: readonly WalObjectId[] = []) {
    const sorted = sortedUnique(ids);
    this.#root = sorted.length === 0 ? undefined : buildNode(sorted, []);
  }

  get size(): number {
    return this.#root?.count ?? 0;
  }

  get root(): SetCommitmentRoot {
    return this.#root?.hash ?? setCommitment([]);
  }

  has(id: WalObjectId): boolean {
    let node = this.#root;
    while (node !== undefined) {
      if (node.kind === 'leaf') return findId(node.ids, id).found;
      node = node.children[nibbleAt(id, node.prefix.length)];
    }
    return false;
  }

  insert(id: WalObjectId): SetCommitmentRoot {
    this.#root = this.#root === undefined ? leaf([id], []) : insertNode(this.#root, id);
    return this.root;
  }

  delete(id: WalObjectId): boolean {
    if (this.#root === undefined) return false;
    const result = deleteNode(this.#root, id);
    this.#root = result.node;
    return result.deleted;
  }

  ids(): WalObjectId[] {
    const ids: WalObjectId[] = [];
    if (this.#root !== undefined) collectIds(this.#root, ids);
    return ids;
  }

  serialize(): Uint8Array {
    return concatBytes(SNAPSHOT_MAGIC, u64be(BigInt(this.size)), ...this.ids());
  }

  static restore(bytes: Uint8Array): MutableSetCommitment {
    if (bytes.length < SNAPSHOT_MAGIC.length + 8 || !equalBytes(bytes.subarray(0, SNAPSHOT_MAGIC.length), SNAPSHOT_MAGIC)) {
      throw new ReconciliationError('INVALID_BYTES', 'invalid set-commitment snapshot header');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset + SNAPSHOT_MAGIC.length, 8);
    const count = view.getBigUint64(0, false);
    if (count > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ReconciliationError('INTEGER_OUT_OF_RANGE', 'set-commitment snapshot count is too large');
    }
    const expectedLength = SNAPSHOT_MAGIC.length + 8 + Number(count) * WAL_OBJECT_ID_LENGTH;
    if (bytes.length !== expectedLength) {
      throw new ReconciliationError('INVALID_BYTES', 'set-commitment snapshot length mismatch');
    }
    const ids: WalObjectId[] = [];
    for (let offset = SNAPSHOT_MAGIC.length + 8; offset < bytes.length; offset += WAL_OBJECT_ID_LENGTH) {
      ids.push(walObjectId(bytes.subarray(offset, offset + WAL_OBJECT_ID_LENGTH)));
    }
    return new MutableSetCommitment(ids);
  }
}
