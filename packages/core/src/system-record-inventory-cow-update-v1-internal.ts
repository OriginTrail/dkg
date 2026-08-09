import { canonicalizeJsonBytes, type CanonicalJsonValue } from './canonical-json.js';
import { assertNetworkIdV1, type NetworkIdV1 } from './sync-wire-identifiers.js';
import { snapshotDataRecord, snapshotExactDataRecord } from './sync-wire-objects.js';
import {
  assertCanonicalDigest,
  type Digest32V1,
} from './sync-wire-scalars.js';
import { assertCanonicalSystemRecordPeerIdV1 } from './system-record-codec-primitives-v1.js';
import {
  computeSystemRecordRootDescriptorDigestV1,
  computeSystemRecordStableKeyHashV1,
  decodeInventoryRowBase64UrlV1,
  encodeSystemRecordInventoryRowV1,
  validateInventoryRow,
  validateRootDescriptor,
  type SystemRecordInventoryInternalEntryV1,
  type SystemRecordInventoryInternalObjectV1,
  type SystemRecordInventoryLeafObjectV1,
  type SystemRecordInventoryRowV1,
  type SystemRecordRootDescriptorObjectV1,
} from './system-record-inventory-codecs-v1-internal.js';
import {
  SYSTEM_RECORD_INTERNAL_MAX_ENTRIES,
  SYSTEM_RECORD_INTERNAL_MIN_ENTRIES,
  SYSTEM_RECORD_LEAF_MAX_ROWS,
  SYSTEM_RECORD_LEAF_MIN_ROWS,
  SYSTEM_RECORD_MAX_TREE_HEIGHT,
} from './system-record-limits-v1.js';
import {
  chooseSystemRecordByteAwareSplitIndexV1,
  chooseSystemRecordRebalanceV1,
  type CowChildRef,
  type SystemRecordInventoryCowUpdateV1,
  type SystemRecordInventoryMutationV1,
  type SystemRecordInventoryStoredObjectV1,
  type SystemRecordInventoryTreeSnapshotV1,
} from './system-record-inventory-cow-build-v1-internal.js';
import {
  createCowMutationContextV1,
  type CowMutationContextV1,
  type CowPreparedMutationV1,
} from './system-record-inventory-cow-context-v1-internal.js';

const MAP_HAS = Map.prototype.has;

interface CowPathFrame {
  readonly digest: Digest32V1;
  readonly object: SystemRecordInventoryInternalObjectV1;
  readonly childIndex: number;
  readonly root: boolean;
}

/** The only value propagated from one immutable tree level to its parent. */
interface CowChildReplacementV1 {
  readonly refs: readonly CowChildRef[];
  readonly parentIndex: number;
  readonly replacedCount: 1 | 2;
}

interface CowLeafMutationResultV1 {
  readonly changed: boolean;
  readonly rows: readonly SystemRecordInventoryRowV1[];
  readonly totalRowsDelta: -1 | 0 | 1;
}

interface CowLocatedLeafV1 {
  readonly path: CowPathFrame[];
  readonly leafMutation: CowLeafMutationResultV1;
}

/**
 * Apply one localized immutable mutation through explicit validation, lookup,
 * leaf-rewrite, parent-propagation, and descriptor-finalization phases.
 */
export function updateSystemRecordInventoryTreeV1(
  snapshot: SystemRecordInventoryTreeSnapshotV1,
  mutation: SystemRecordInventoryMutationV1,
): SystemRecordInventoryCowUpdateV1 {
  const context = createCowMutationContextV1(prepareCowMutationV1(snapshot, mutation));
  const located = locateCowMutationLeafV1(context);
  if (!located.leafMutation.changed) return context.unchanged();
  return rewriteCowLeafAndPropagateV1(context, located);
}

function prepareCowMutationV1(
  snapshot: SystemRecordInventoryTreeSnapshotV1,
  mutation: SystemRecordInventoryMutationV1,
): CowPreparedMutationV1 {
  const pinnedSnapshot = snapshotExactDataRecord(
    snapshot,
    ['networkId', 'descriptor', 'descriptorDigest', 'objects'],
    'inventory tree snapshot',
  );
  const descriptor = validateRootDescriptor(pinnedSnapshot.descriptor);
  const networkId = pinnedSnapshot.networkId as NetworkIdV1;
  const pinnedDescriptorDigest = pinnedSnapshot.descriptorDigest as Digest32V1;
  const objects = pinnedSnapshot.objects;
  assertNetworkIdV1(networkId);
  assertCanonicalDigest(pinnedDescriptorDigest);
  if (!(objects instanceof Map)) throw new Error('inventory snapshot objects must be a native map');
  try {
    Reflect.apply(MAP_HAS, objects, [descriptor.treeRootDigest]);
  } catch {
    throw new Error('inventory snapshot objects must be a native map');
  }
  if (
    descriptor.networkId !== networkId ||
    computeSystemRecordRootDescriptorDigestV1(descriptor) !== pinnedDescriptorDigest
  ) {
    throw new Error('inventory snapshot descriptor binding is invalid');
  }

  const mutationProbe = snapshotDataRecord(mutation, 'inventory mutation', {
    rejectNullValues: true,
  });
  const normalizedMutation: SystemRecordInventoryMutationV1 =
    mutationProbe.operation === 'upsert'
      ? Object.freeze({
          operation: 'upsert',
          row: validateInventoryRow(
            snapshotExactDataRecord(
              mutationProbe,
              ['operation', 'row'],
              'inventory upsert mutation',
            ).row,
            networkId,
          ),
        })
      : mutationProbe.operation === 'delete'
        ? (Object.freeze({
            ...snapshotExactDataRecord(
              mutationProbe,
              ['operation', 'stableKeyHash', 'peerId'],
              'inventory delete mutation',
            ),
            operation: 'delete' as const,
          }) as unknown as SystemRecordInventoryMutationV1)
        : (() => {
            throw new Error('inventory mutation operation is invalid');
          })();
  const targetKey =
    normalizedMutation.operation === 'upsert'
      ? normalizedMutation.row.stableKeyHash
      : normalizedMutation.stableKeyHash;
  const targetPeer =
    normalizedMutation.operation === 'upsert'
      ? normalizedMutation.row.peerId
      : normalizedMutation.peerId;
  assertCanonicalDigest(targetKey);
  assertCanonicalSystemRecordPeerIdV1(targetPeer);
  if (targetKey !== computeSystemRecordStableKeyHashV1(networkId, targetPeer)) {
    throw new Error('inventory mutation key does not bind networkId/peerId');
  }
  return {
    networkId,
    descriptor,
    pinnedDescriptorDigest,
    objects: objects as ReadonlyMap<Digest32V1, SystemRecordInventoryStoredObjectV1>,
    mutation: normalizedMutation,
    targetKey,
    targetPeer,
  };
}

function locateCowMutationLeafV1(context: CowMutationContextV1): CowLocatedLeafV1 {
  const path: CowPathFrame[] = [];
  let currentDigest = context.descriptor.treeRootDigest;
  let depth = 1;
  let leaf: SystemRecordInventoryLeafObjectV1;
  while (true) {
    const stored = context.loadObject(currentDigest, depth === 1);
    if (stored.objectKind === 'inventory-leaf') {
      leaf = stored.object as SystemRecordInventoryLeafObjectV1;
      break;
    }
    const internal = stored.object as SystemRecordInventoryInternalObjectV1;
    const childIndex = findChildIndex(internal.entries, context.targetKey);
    path.push({
      digest: currentDigest,
      object: internal,
      childIndex,
      root: depth === 1,
    });
    currentDigest = internal.entries[childIndex].childDigest;
    depth += 1;
    if (depth > SYSTEM_RECORD_MAX_TREE_HEIGHT) {
      throw new Error('inventory mutation path exceeds height bound');
    }
  }
  return {
    path,
    leafMutation: applyCowLeafMutationV1(
      context.networkId,
      leaf.rows.map((encoded) => decodeInventoryRowBase64UrlV1(context.networkId, encoded)),
      context.mutation,
      context.targetKey,
      context.targetPeer,
    ),
  };
}

function rewriteCowLeafAndPropagateV1(
  context: CowMutationContextV1,
  located: CowLocatedLeafV1,
): SystemRecordInventoryCowUpdateV1 {
  const rows = [...located.leafMutation.rows];
  const path = located.path;
  if (path.length === 0) {
    if (rows.length <= SYSTEM_RECORD_LEAF_MAX_ROWS) {
      return context.finish(context.persistLeaf(rows, true, 'root').digest, rows.length);
    }
    const split = chooseSystemRecordByteAwareSplitIndexV1(
      rows.map((row) => encodeSystemRecordInventoryRowV1(context.networkId, row).byteLength),
      SYSTEM_RECORD_LEAF_MIN_ROWS,
      SYSTEM_RECORD_LEAF_MIN_ROWS,
    );
    const children = [
      context.persistLeaf(rows.slice(0, split), false, 'leaf'),
      context.persistLeaf(rows.slice(split), false, 'leaf'),
    ];
    return context.finish(context.persistInternal(children, true, 'root').digest, rows.length);
  }
  return propagateCowChildReplacementV1(
    context,
    path,
    planCowLeafReplacementV1(context, path.at(-1)!, rows),
    context.totalRows(located.leafMutation.totalRowsDelta),
  );
}

function planCowLeafReplacementV1(
  context: CowMutationContextV1,
  parent: CowPathFrame,
  rows: readonly SystemRecordInventoryRowV1[],
): CowChildReplacementV1 {
  if (rows.length > SYSTEM_RECORD_LEAF_MAX_ROWS) {
    const split = chooseSystemRecordByteAwareSplitIndexV1(
      rows.map((row) => encodeSystemRecordInventoryRowV1(context.networkId, row).byteLength),
      SYSTEM_RECORD_LEAF_MIN_ROWS,
      SYSTEM_RECORD_LEAF_MIN_ROWS,
    );
    return {
      refs: [
        context.persistLeaf(rows.slice(0, split), false, 'leaf'),
        context.persistLeaf(rows.slice(split), false, 'leaf'),
      ],
      parentIndex: parent.childIndex,
      replacedCount: 1,
    };
  }
  if (rows.length >= SYSTEM_RECORD_LEAF_MIN_ROWS) {
    return {
      refs: [context.persistLeaf(rows, false, 'leaf')],
      parentIndex: parent.childIndex,
      replacedCount: 1,
    };
  }
  const leftIndex = parent.childIndex > 0 ? parent.childIndex - 1 : undefined;
  const rightIndex =
    parent.childIndex + 1 < parent.object.entries.length ? parent.childIndex + 1 : undefined;
  const loadLeafRows = (index: number): SystemRecordInventoryRowV1[] => {
    const siblingEntry = parent.object.entries[index];
    if (siblingEntry?.childKind !== 'inventory-leaf') {
      throw new Error('leaf rebalance sibling is unavailable');
    }
    const sibling = context.loadObject(siblingEntry.childDigest, false)
      .object as SystemRecordInventoryLeafObjectV1;
    return sibling.rows.map((encoded) =>
      decodeInventoryRowBase64UrlV1(context.networkId, encoded),
    );
  };
  const leftRows = leftIndex === undefined ? undefined : loadLeafRows(leftIndex);
  const rightRows =
    leftRows !== undefined && leftRows.length > SYSTEM_RECORD_LEAF_MIN_ROWS
      ? undefined
      : rightIndex === undefined
        ? undefined
        : loadLeafRows(rightIndex);
  const rebalance = chooseSystemRecordRebalanceV1(
    leftRows?.length,
    rightRows?.length,
    SYSTEM_RECORD_LEAF_MIN_ROWS,
  );
  const siblingIsLeft = rebalance.endsWith('left');
  const siblingIndex = siblingIsLeft ? leftIndex! : rightIndex!;
  const siblingRows = siblingIsLeft ? leftRows! : rightRows!;
  return {
    refs: rebalanceOrderedCowGroupsV1(
      rows,
      siblingRows,
      siblingIsLeft,
      rebalance.startsWith('borrow'),
    ).map((group) => context.persistLeaf(group, false, 'leaf')),
    parentIndex: Math.min(parent.childIndex, siblingIndex),
    replacedCount: 2,
  };
}

function propagateCowChildReplacementV1(
  context: CowMutationContextV1,
  path: CowPathFrame[],
  childReplacement: CowChildReplacementV1,
  totalRows: number,
): SystemRecordInventoryCowUpdateV1 {
  const frame = path.pop()!;
  const parentEntries = replaceChildEntries(
    frame.object.entries,
    childReplacement.parentIndex,
    childReplacement.replacedCount,
    childReplacement.refs,
  );
  if (frame.root) return context.finishRootEntries(parentEntries, totalRows);
  let nextParentRefs: CowChildRef[];
  if (parentEntries.length > SYSTEM_RECORD_INTERNAL_MAX_ENTRIES) {
    const split = chooseSystemRecordByteAwareSplitIndexV1(
      parentEntries.map(
        (entry) => canonicalizeJsonBytes(entry as unknown as CanonicalJsonValue).byteLength,
      ),
      SYSTEM_RECORD_INTERNAL_MIN_ENTRIES,
      SYSTEM_RECORD_INTERNAL_MIN_ENTRIES,
    );
    nextParentRefs = [
      context.persistInternalEntries(parentEntries.slice(0, split), false, 'internal'),
      context.persistInternalEntries(parentEntries.slice(split), false, 'internal'),
    ];
  } else if (parentEntries.length >= SYSTEM_RECORD_INTERNAL_MIN_ENTRIES) {
    nextParentRefs = [context.persistInternalEntries(parentEntries, false, 'internal')];
  } else {
    return rebalanceCowInternalUnderflowV1(context, path, parentEntries, totalRows);
  }
  const rootFrame = path.pop();
  if (rootFrame === undefined || !rootFrame.root) {
    throw new Error('inventory height exceeds the V1 update model');
  }
  return context.finishRootEntries(
    replaceChildEntries(rootFrame.object.entries, rootFrame.childIndex, 1, nextParentRefs),
    totalRows,
  );
}

function rebalanceCowInternalUnderflowV1(
  context: CowMutationContextV1,
  path: CowPathFrame[],
  parentEntries: readonly SystemRecordInventoryInternalEntryV1[],
  totalRows: number,
): SystemRecordInventoryCowUpdateV1 {
  const rootParent = path.pop();
  if (rootParent === undefined || !rootParent.root) {
    throw new Error('non-root internal node lacks root parent');
  }
  const leftIndex = rootParent.childIndex > 0 ? rootParent.childIndex - 1 : undefined;
  const rightIndex =
    rootParent.childIndex + 1 < rootParent.object.entries.length
      ? rootParent.childIndex + 1
      : undefined;
  const loadInternalSibling = (index: number): SystemRecordInventoryInternalObjectV1 => {
    const siblingEntry = rootParent.object.entries[index];
    if (siblingEntry?.childKind !== 'inventory-internal') {
      throw new Error('internal rebalance sibling is unavailable');
    }
    return context.loadObject(siblingEntry.childDigest, false)
      .object as SystemRecordInventoryInternalObjectV1;
  };
  const left = leftIndex === undefined ? undefined : loadInternalSibling(leftIndex);
  const right =
    left !== undefined && left.entries.length > SYSTEM_RECORD_INTERNAL_MIN_ENTRIES
      ? undefined
      : rightIndex === undefined
        ? undefined
        : loadInternalSibling(rightIndex);
  const rebalance = chooseSystemRecordRebalanceV1(
    left?.entries.length,
    right?.entries.length,
    SYSTEM_RECORD_INTERNAL_MIN_ENTRIES,
  );
  const siblingIsLeft = rebalance.endsWith('left');
  const siblingIndex = siblingIsLeft ? leftIndex! : rightIndex!;
  const sibling = siblingIsLeft ? left! : right!;
  const entryGroups = rebalanceOrderedCowGroupsV1(
    parentEntries,
    sibling.entries,
    siblingIsLeft,
    rebalance.startsWith('borrow'),
  );
  const collapsesRoot = entryGroups.length === 1 && rootParent.object.entries.length === 2;
  const nextParentRefs = entryGroups.map((group) =>
    context.persistInternalEntries(group, collapsesRoot, collapsesRoot ? 'root' : 'internal'),
  );
  const rootEntries = replaceChildEntries(
    rootParent.object.entries,
    Math.min(rootParent.childIndex, siblingIndex),
    2,
    nextParentRefs,
  );
  if (rootEntries.length === 1) return context.finish(rootEntries[0].childDigest, totalRows);
  return context.finishRootEntries(rootEntries, totalRows);
}

function applyCowLeafMutationV1(
  networkId: NetworkIdV1,
  currentRows: readonly SystemRecordInventoryRowV1[],
  mutation: SystemRecordInventoryMutationV1,
  targetKey: Digest32V1,
  targetPeer: string,
): CowLeafMutationResultV1 {
  const rows = [...currentRows];
  const index = findRowIndex(rows, targetKey, targetPeer);
  const exists = index < rows.length && rows[index].stableKeyHash === targetKey;
  if (exists && rows[index].peerId !== targetPeer) throw new Error('stable-key hash collision');
  if (mutation.operation === 'delete' && !exists) {
    return { changed: false, rows, totalRowsDelta: 0 };
  }
  if (
    mutation.operation === 'upsert' &&
    exists &&
    Buffer.from(encodeSystemRecordInventoryRowV1(networkId, rows[index])).equals(
      Buffer.from(encodeSystemRecordInventoryRowV1(networkId, mutation.row)),
    )
  ) {
    return { changed: false, rows, totalRowsDelta: 0 };
  }
  if (mutation.operation === 'upsert') {
    rows.splice(index, exists ? 1 : 0, mutation.row);
    return { changed: true, rows, totalRowsDelta: exists ? 0 : 1 };
  }
  rows.splice(index, 1);
  return { changed: true, rows, totalRowsDelta: -1 };
}

function rebalanceOrderedCowGroupsV1<T>(
  node: readonly T[],
  sibling: readonly T[],
  siblingIsLeft: boolean,
  borrow: boolean,
): readonly (readonly T[])[] {
  const nodeItems = [...node];
  const siblingItems = [...sibling];
  if (!borrow) {
    return [siblingIsLeft ? [...siblingItems, ...nodeItems] : [...nodeItems, ...siblingItems]];
  }
  if (siblingIsLeft) {
    nodeItems.unshift(siblingItems.pop()!);
    return [siblingItems, nodeItems];
  }
  nodeItems.push(siblingItems.shift()!);
  return [nodeItems, siblingItems];
}

function replaceChildEntries(
  entries: readonly SystemRecordInventoryInternalEntryV1[],
  index: number,
  count: number,
  replacements: readonly CowChildRef[],
): SystemRecordInventoryInternalEntryV1[] {
  const next = [...entries];
  next.splice(
    index,
    count,
    ...replacements.map((child) => ({
      separatorKeyHash: child.first!,
      childDigest: child.digest,
      childKind: child.objectKind,
    })),
  );
  return next;
}

function findChildIndex(
  entries: readonly SystemRecordInventoryInternalEntryV1[],
  key: Digest32V1,
): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (entries[middle].separatorKeyHash <= key) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

function findRowIndex(
  rows: readonly SystemRecordInventoryRowV1[],
  key: Digest32V1,
  peerId: string,
): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const candidate = rows[middle];
    const comparison =
      candidate.stableKeyHash === key
        ? candidate.peerId === peerId
          ? 0
          : (() => {
              throw new Error('stable-key hash collision');
            })()
        : candidate.stableKeyHash < key
          ? -1
          : 1;
    if (comparison < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}
