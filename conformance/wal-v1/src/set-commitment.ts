import { compareBytes, concat, equalBytes, hash, sortedUniqueBytes, u16be, u64be } from './bytes.js';
import { DOMAINS } from './schema.js';

export const SET_LEAF_CAPACITY = 256;
const MAX_DEPTH = 64;

interface NodeBase {
  prefix: number[];
  count: number;
  hash: Uint8Array;
}

interface Leaf extends NodeBase {
  kind: 'leaf';
  ids: Uint8Array[];
}

interface Branch extends NodeBase {
  kind: 'branch';
  children: Array<Node | undefined>;
}

type Node = Leaf | Branch;

export interface SetProofSibling {
  nibble: number;
  count: number;
  hash: Uint8Array;
}

export interface SetProofLevel {
  parentPrefixLength: number;
  childBitmap: number;
  childNibble: number;
  siblings: SetProofSibling[];
}

export interface SetMembershipProof {
  id: Uint8Array;
  leafPrefixLength: number;
  leafIds: Uint8Array[];
  path: SetProofLevel[];
}

function nibbleAt(id: Uint8Array, depth: number): number {
  const byte = id[Math.floor(depth / 2)];
  return depth % 2 === 0 ? byte >>> 4 : byte & 15;
}

export function packNibblePrefix(nibbles: readonly number[]): Uint8Array {
  if (nibbles.length > MAX_DEPTH) throw new Error('prefix is deeper than a WalObjectId');
  const output = new Uint8Array(Math.ceil(nibbles.length / 2));
  for (let index = 0; index < nibbles.length; index += 1) {
    const nibble = nibbles[index];
    if (!Number.isInteger(nibble) || nibble < 0 || nibble > 15) throw new Error('invalid nibble');
    if (index % 2 === 0) output[index >> 1] = nibble << 4;
    else output[index >> 1] |= nibble;
  }
  return output;
}

function prefixOf(id: Uint8Array, length: number): number[] {
  return Array.from({ length }, (_, index) => nibbleAt(id, index));
}

function hashLeaf(prefix: readonly number[], ids: readonly Uint8Array[]): Uint8Array {
  return hash(
    DOMAINS.setLeaf,
    Uint8Array.of(prefix.length),
    packNibblePrefix(prefix),
    u64be(BigInt(ids.length)),
    concat(...ids)
  );
}

function hashBranch(prefix: readonly number[], children: readonly (Node | undefined)[]): Uint8Array {
  let bitmap = 0;
  const encodedChildren: Uint8Array[] = [];
  for (let nibble = 0; nibble < 16; nibble += 1) {
    const child = children[nibble];
    if (child === undefined) continue;
    bitmap |= 1 << nibble;
    encodedChildren.push(Uint8Array.of(nibble), u64be(BigInt(child.count)), child.hash);
  }
  return hash(
    DOMAINS.setBranch,
    Uint8Array.of(prefix.length),
    packNibblePrefix(prefix),
    u16be(bitmap),
    ...encodedChildren
  );
}

function build(ids: readonly Uint8Array[], prefix: readonly number[]): Node {
  if (ids.length <= SET_LEAF_CAPACITY) {
    const copied = ids.map((id) => new Uint8Array(id));
    return { kind: 'leaf', prefix: [...prefix], count: copied.length, ids: copied, hash: hashLeaf(prefix, copied) };
  }
  if (prefix.length >= MAX_DEPTH) throw new Error('duplicate IDs cannot be split');
  const groups = Array.from({ length: 16 }, () => [] as Uint8Array[]);
  for (const id of ids) groups[nibbleAt(id, prefix.length)].push(id);
  const children = groups.map((group, nibble) => group.length === 0 ? undefined : build(group, [...prefix, nibble]));
  const count = children.reduce((sum, child) => sum + (child?.count ?? 0), 0);
  return { kind: 'branch', prefix: [...prefix], count, children, hash: hashBranch(prefix, children) };
}

function validateIds(ids: readonly Uint8Array[]): Uint8Array[] {
  for (const id of ids) if (id.length !== 32) throw new Error('WalObjectId must be bytes32');
  return sortedUniqueBytes(ids);
}

export function setCommitmentRoot(ids: readonly Uint8Array[]): Uint8Array {
  if (ids.length === 0) return hash(DOMAINS.setEmpty);
  return build(validateIds(ids), []).hash;
}

export function createMembershipProof(ids: readonly Uint8Array[], target: Uint8Array): SetMembershipProof {
  const root = build(validateIds(ids), []);
  if (target.length !== 32) throw new Error('WalObjectId must be bytes32');
  const path: SetProofLevel[] = [];
  let node = root;
  while (node.kind === 'branch') {
    const childNibble = nibbleAt(target, node.prefix.length);
    const child = node.children[childNibble];
    if (child === undefined) throw new Error('target is not in the set');
    let childBitmap = 0;
    const siblings: SetProofSibling[] = [];
    for (let nibble = 0; nibble < 16; nibble += 1) {
      const candidate = node.children[nibble];
      if (candidate === undefined) continue;
      childBitmap |= 1 << nibble;
      if (nibble !== childNibble) siblings.push({ nibble, count: candidate.count, hash: candidate.hash });
    }
    path.push({ parentPrefixLength: node.prefix.length, childBitmap, childNibble, siblings });
    node = child;
  }
  if (!node.ids.some((id) => equalBytes(id, target))) throw new Error('target is not in the set');
  return {
    id: new Uint8Array(target),
    leafPrefixLength: node.prefix.length,
    leafIds: node.ids.map((id) => new Uint8Array(id)),
    path
  };
}

export function verifyMembershipProof(proof: SetMembershipProof, expectedRoot: Uint8Array): boolean {
  try {
    if (proof.id.length !== 32 || expectedRoot.length !== 32) return false;
    if (proof.leafIds.length === 0 || proof.leafIds.length > SET_LEAF_CAPACITY) return false;
    const ids = validateIds(proof.leafIds);
    if (!ids.some((id) => equalBytes(id, proof.id))) return false;
    let count = ids.length;
    let prefixLength = proof.leafPrefixLength;
    if (prefixLength > MAX_DEPTH) return false;
    for (const id of ids) {
      if (!equalBytes(packNibblePrefix(prefixOf(id, prefixLength)), packNibblePrefix(prefixOf(proof.id, prefixLength)))) {
        return false;
      }
    }
    let currentHash = hashLeaf(prefixOf(proof.id, prefixLength), ids);
    for (let pathIndex = proof.path.length - 1; pathIndex >= 0; pathIndex -= 1) {
      const level = proof.path[pathIndex];
      if (level.parentPrefixLength >= prefixLength || level.childNibble !== nibbleAt(proof.id, level.parentPrefixLength)) return false;
      if ((level.childBitmap & (1 << level.childNibble)) === 0) return false;
      const children: Array<Node | undefined> = Array.from({ length: 16 });
      children[level.childNibble] = {
        kind: 'leaf',
        prefix: prefixOf(proof.id, prefixLength),
        count,
        ids: [],
        hash: currentHash
      };
      let priorNibble = -1;
      for (const sibling of level.siblings) {
        if (sibling.nibble <= priorNibble || sibling.nibble === level.childNibble || sibling.nibble < 0 || sibling.nibble > 15) return false;
        if (sibling.count <= 0 || sibling.hash.length !== 32) return false;
        if ((level.childBitmap & (1 << sibling.nibble)) === 0) return false;
        priorNibble = sibling.nibble;
        children[sibling.nibble] = {
          kind: 'leaf',
          prefix: [...prefixOf(proof.id, level.parentPrefixLength), sibling.nibble],
          count: sibling.count,
          ids: [],
          hash: sibling.hash
        };
      }
      const actualBitmap = children.reduce((bitmap, child, nibble) => child === undefined ? bitmap : bitmap | (1 << nibble), 0);
      if (actualBitmap !== level.childBitmap) return false;
      count = children.reduce((sum, child) => sum + (child?.count ?? 0), 0);
      prefixLength = level.parentPrefixLength;
      currentHash = hashBranch(prefixOf(proof.id, prefixLength), children);
    }
    return prefixLength === 0 && equalBytes(currentHash, expectedRoot);
  } catch {
    return false;
  }
}

export function independentSetCommitmentRoot(input: readonly Uint8Array[]): Uint8Array {
  if (input.length === 0) return hash(DOMAINS.setEmpty);
  const ids = validateIds(input);

  function visit(values: readonly Uint8Array[], depth: number): { count: number; digest: Uint8Array } {
    const prefix = prefixOf(values[0], depth);
    if (values.length <= SET_LEAF_CAPACITY) return { count: values.length, digest: hashLeaf(prefix, values) };
    const grouped = new Map<number, Uint8Array[]>();
    for (const value of values) {
      const nibble = nibbleAt(value, depth);
      const group = grouped.get(nibble) ?? [];
      group.push(value);
      grouped.set(nibble, group);
    }
    const children: Array<Node | undefined> = Array.from({ length: 16 });
    for (const [nibble, group] of grouped) {
      const child = visit(group, depth + 1);
      children[nibble] = { kind: 'leaf', prefix: [...prefix, nibble], count: child.count, ids: [], hash: child.digest };
    }
    return { count: values.length, digest: hashBranch(prefix, children) };
  }

  return visit(ids, 0).digest;
}
