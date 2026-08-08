import { canonicalizeJsonBytes, type CanonicalJsonValue } from './canonical-json.js';
import { assertNetworkIdV1, type NetworkIdV1 } from './sync-wire-identifiers.js';
import {
  snapshotDataArray,
  snapshotDataRecord,
  snapshotExactDataRecord,
} from './sync-wire-objects.js';
import {
  assertCanonicalDecimalU64,
  assertCanonicalDigest,
  parseCanonicalDecimalU64,
  type DecimalU64V1,
  type Digest32V1,
} from './sync-wire-scalars.js';
import {
  assertCanonicalSystemRecordPeerIdV1,
  copyBoundedSystemRecordBytesV1,
  digestSystemRecordBytesV1,
} from './system-record-codec-primitives-v1.js';
import {
  canonicalizeSystemRecordInventoryInternalObjectV1,
  canonicalizeSystemRecordInventoryLeafObjectV1,
  canonicalizeSystemRecordRootDescriptorObjectV1,
  compareRows,
  computeSystemRecordInventoryInternalDigestV1,
  computeSystemRecordInventoryLeafDigestV1,
  computeSystemRecordRootDescriptorDigestV1,
  computeSystemRecordStableKeyHashV1,
  decodeInventoryRowBase64UrlV1,
  encodeInventoryRowBase64UrlV1,
  encodeSystemRecordInventoryRowV1,
  validateInternal,
  validateInventoryRow,
  validateLeaf,
  validateRootDescriptor,
  type SystemRecordInventoryInternalEntryV1,
  type SystemRecordInventoryInternalObjectV1,
  type SystemRecordInventoryLeafObjectV1,
  type SystemRecordInventoryObjectV1,
  type SystemRecordInventoryRowV1,
  type SystemRecordRootDescriptorObjectV1,
} from './system-record-inventory-codecs-v1-internal.js';
import {
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  SYSTEM_RECORD_INTERNAL_MAX_ENTRIES,
  SYSTEM_RECORD_INTERNAL_MIN_ENTRIES,
  SYSTEM_RECORD_INTERNAL_TARGET_BYTES,
  SYSTEM_RECORD_KIND_V1,
  SYSTEM_RECORD_LEAF_MAX_ROWS,
  SYSTEM_RECORD_LEAF_MIN_ROWS,
  SYSTEM_RECORD_LEAF_TARGET_BYTES,
  SYSTEM_RECORD_MAX_INTERNAL_ENTRY_BYTES,
  SYSTEM_RECORD_MAX_INVENTORY_LEAVES,
  SYSTEM_RECORD_MAX_INVENTORY_RECORDS,
  SYSTEM_RECORD_MAX_ROW_BYTES,
  SYSTEM_RECORD_MAX_TREE_HEIGHT,
  SYSTEM_RECORD_MAX_TREE_UPDATE_BYTES,
  SYSTEM_RECORD_MAX_TREE_UPDATE_OBJECTS,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
  SYSTEM_RECORD_ROOT_MAX_ENTRIES,
} from './system-record-limits-v1.js';

const MAP_GET = Map.prototype.get;
const MAP_HAS = Map.prototype.has;

/** Pick the deterministic split nearest half encoded bytes while preserving minima. */
export function chooseSystemRecordByteAwareSplitIndexV1(
  encodedEntryBytes: readonly number[],
  minimumLeft: number,
  minimumRight: number,
): number {
  const lengths = snapshotDataArray(encodedEntryBytes, 'split byte lengths', {
    maxLength: SYSTEM_RECORD_LEAF_MAX_ROWS + 1,
  }) as readonly number[];
  if (
    !Number.isInteger(minimumLeft) ||
    !Number.isInteger(minimumRight) ||
    minimumLeft < 1 ||
    minimumRight < 1 ||
    lengths.length < minimumLeft + minimumRight
  ) {
    throw new Error('split cardinality cannot preserve occupancy');
  }
  const maximumEntryBytes = Math.max(
    SYSTEM_RECORD_MAX_ROW_BYTES,
    SYSTEM_RECORD_MAX_INTERNAL_ENTRY_BYTES,
  );
  if (
    lengths.some((value) => !Number.isSafeInteger(value) || value <= 0 || value > maximumEntryBytes)
  ) {
    throw new Error('split byte lengths must be positive safe integers');
  }
  let total = 0;
  for (const value of lengths) {
    total += value;
    if (!Number.isSafeInteger(total)) throw new Error('split byte-length total is unsafe');
  }
  let prefix = 0;
  for (let index = 0; index < minimumLeft; index += 1) {
    prefix += lengths[index];
    if (!Number.isSafeInteger(prefix)) throw new Error('split byte-length prefix is unsafe');
  }
  let best = minimumLeft;
  let bestDistance = Math.abs(total - 2 * prefix);
  for (let index = minimumLeft + 1; index <= lengths.length - minimumRight; index += 1) {
    prefix += lengths[index - 1];
    if (!Number.isSafeInteger(prefix)) throw new Error('split byte-length prefix is unsafe');
    const distance = Math.abs(total - 2 * prefix);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}
export type SystemRecordRebalanceChoiceV1 =
  | 'borrow-left'
  | 'borrow-right'
  | 'merge-left'
  | 'merge-right';

export function chooseSystemRecordRebalanceV1(
  leftCount: number | undefined,
  rightCount: number | undefined,
  minimum: number,
): SystemRecordRebalanceChoiceV1 {
  if (leftCount !== undefined && leftCount > minimum) return 'borrow-left';
  if (rightCount !== undefined && rightCount > minimum) return 'borrow-right';
  if (leftCount !== undefined) return 'merge-left';
  if (rightCount !== undefined) return 'merge-right';
  throw new Error('rebalance requires an adjacent sibling');
}

export interface SystemRecordInventoryCowUpdateAccountingV1 {
  readonly leafObjects: number;
  readonly internalObjects: number;
  readonly rootObjects: number;
  readonly descriptorObjects: number;
  readonly encodedBytes: number;
}

export function assertSystemRecordInventoryCowUpdateBoundV1(
  accounting: SystemRecordInventoryCowUpdateAccountingV1,
): void {
  const validated = snapshotExactDataRecord(
    accounting,
    ['leafObjects', 'internalObjects', 'rootObjects', 'descriptorObjects', 'encodedBytes'],
    'COW accounting',
  );
  const values = [
    validated.leafObjects,
    validated.internalObjects,
    validated.rootObjects,
    validated.descriptorObjects,
    validated.encodedBytes,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || (value as number) < 0)) {
    throw new Error('COW accounting values must be non-negative safe integers');
  }
  const objects =
    (validated.leafObjects as number) +
    (validated.internalObjects as number) +
    (validated.rootObjects as number) +
    (validated.descriptorObjects as number);
  if (
    (validated.leafObjects as number) > 2 ||
    (validated.internalObjects as number) > 2 ||
    (validated.rootObjects as number) > 1 ||
    validated.descriptorObjects !== 1 ||
    objects > SYSTEM_RECORD_MAX_TREE_UPDATE_OBJECTS ||
    (validated.encodedBytes as number) > SYSTEM_RECORD_MAX_TREE_UPDATE_BYTES
  ) {
    throw new Error('inventory update exceeds the six-object/1-MiB COW bound');
  }
}

export const SYSTEM_RECORD_INVENTORY_REBALANCE_TARGETS_V1 = Object.freeze({
  leafBytes: SYSTEM_RECORD_LEAF_TARGET_BYTES,
  internalBytes: SYSTEM_RECORD_INTERNAL_TARGET_BYTES,
});

export interface SystemRecordInventoryStoredObjectV1 {
  readonly objectKind: 'inventory-leaf' | 'inventory-internal';
  readonly object: SystemRecordInventoryObjectV1;
  readonly canonicalBytes: Uint8Array;
}

export interface SystemRecordInventoryTreeSnapshotV1 {
  readonly networkId: NetworkIdV1;
  readonly descriptor: SystemRecordRootDescriptorObjectV1;
  readonly descriptorDigest: Digest32V1;
  readonly objects: ReadonlyMap<Digest32V1, SystemRecordInventoryStoredObjectV1>;
}

export interface SystemRecordInventoryCowWriteV1 extends SystemRecordInventoryStoredObjectV1 {
  readonly digest: Digest32V1;
  readonly role: 'leaf' | 'internal' | 'root';
}

export type SystemRecordInventoryMutationV1 =
  | { readonly operation: 'upsert'; readonly row: SystemRecordInventoryRowV1 }
  | {
      readonly operation: 'delete';
      readonly stableKeyHash: Digest32V1;
      readonly peerId: string;
    };

export interface SystemRecordInventoryCowUpdateV1 {
  readonly changed: boolean;
  readonly descriptor: SystemRecordRootDescriptorObjectV1;
  readonly descriptorDigest: Digest32V1;
  readonly writes: readonly SystemRecordInventoryCowWriteV1[];
  readonly descriptorBytes?: Uint8Array;
  readonly accounting: SystemRecordInventoryCowUpdateAccountingV1;
  readonly reusedObjectDigests: ReadonlySet<Digest32V1>;
  readonly loadedObjectDigests: ReadonlySet<Digest32V1>;
}

/** Build the first immutable tree; subsequent publications must use the COW updater. */
export function buildSystemRecordInventoryTreeV1(
  networkId: NetworkIdV1,
  rows: readonly SystemRecordInventoryRowV1[],
  epoch: DecimalU64V1 = '0' as DecimalU64V1,
): SystemRecordInventoryTreeSnapshotV1 {
  assertNetworkIdV1(networkId);
  assertCanonicalDecimalU64(epoch);
  const inputRows = snapshotDataArray(rows, 'initial inventory rows', {
    maxLength: SYSTEM_RECORD_MAX_INVENTORY_RECORDS,
  }) as readonly SystemRecordInventoryRowV1[];
  const sorted = inputRows.map((row) => validateInventoryRow(row, networkId));
  sorted.sort(compareRows);
  for (let index = 1; index < sorted.length; index += 1) {
    if (compareRows(sorted[index - 1], sorted[index]) >= 0) {
      throw new Error('initial inventory rows must be stable-key unique');
    }
  }
  const objects = new Map<Digest32V1, SystemRecordInventoryStoredObjectV1>();
  let rootDigest: Digest32V1;
  if (sorted.length <= SYSTEM_RECORD_LEAF_MAX_ROWS) {
    rootDigest = storeLeaf(sorted, true).digest;
  } else {
    const leafGroups = partitionByTarget(
      sorted,
      SYSTEM_RECORD_LEAF_MIN_ROWS,
      SYSTEM_RECORD_LEAF_MAX_ROWS,
      SYSTEM_RECORD_LEAF_TARGET_BYTES,
      (row) => encodeSystemRecordInventoryRowV1(networkId, row).byteLength,
    );
    if (leafGroups.length > SYSTEM_RECORD_MAX_INVENTORY_LEAVES) {
      throw new Error('initial inventory exceeds the V1 leaf bound');
    }
    const leafRefs = leafGroups.map((group) => storeLeaf(group, false));
    if (leafRefs.length <= SYSTEM_RECORD_ROOT_MAX_ENTRIES) {
      rootDigest = storeInternal(leafRefs, true).digest;
    } else {
      const internalGroups = partitionByTarget(
        leafRefs,
        SYSTEM_RECORD_INTERNAL_MIN_ENTRIES,
        SYSTEM_RECORD_INTERNAL_MAX_ENTRIES,
        SYSTEM_RECORD_INTERNAL_TARGET_BYTES,
        () => SYSTEM_RECORD_MAX_INTERNAL_ENTRY_BYTES,
      );
      const internalRefs = internalGroups.map((group) => storeInternal(group, false));
      if (internalRefs.length > SYSTEM_RECORD_ROOT_MAX_ENTRIES) {
        throw new Error('initial inventory exceeds the V1 root fanout');
      }
      rootDigest = storeInternal(internalRefs, true).digest;
    }
  }
  const descriptor: SystemRecordRootDescriptorObjectV1 = {
    objectType: 'root-descriptor',
    kind: SYSTEM_RECORD_KIND_V1,
    networkId,
    epoch,
    version: '0' as DecimalU64V1,
    treeRootDigest: rootDigest,
    totalRows: inputRows.length.toString() as DecimalU64V1,
  };
  return Object.freeze({
    networkId,
    descriptor: validateRootDescriptor(descriptor),
    descriptorDigest: computeSystemRecordRootDescriptorDigestV1(descriptor),
    objects,
  });

  function storeLeaf(group: readonly SystemRecordInventoryRowV1[], root: boolean): CowChildRef {
    const object = makeLeafObject(networkId, group);
    const canonicalBytes = canonicalizeSystemRecordInventoryLeafObjectV1(object, networkId, root);
    const digest = computeSystemRecordInventoryLeafDigestV1(object, networkId, root);
    objects.set(digest, Object.freeze({ objectKind: 'inventory-leaf', object, canonicalBytes }));
    return {
      digest,
      objectKind: 'inventory-leaf',
      first: object.firstKeyHash,
      last: object.lastKeyHash,
    };
  }

  function storeInternal(group: readonly CowChildRef[], root: boolean): CowChildRef {
    const object = makeInternalObject(group);
    const canonicalBytes = canonicalizeSystemRecordInventoryInternalObjectV1(object, root);
    const digest = computeSystemRecordInventoryInternalDigestV1(object, root);
    objects.set(
      digest,
      Object.freeze({
        objectKind: 'inventory-internal',
        object,
        canonicalBytes,
      }),
    );
    return {
      digest,
      objectKind: 'inventory-internal',
      first: object.firstKeyHash,
      last: object.lastKeyHash,
    };
  }
}

interface CowChildRef {
  readonly digest: Digest32V1;
  readonly objectKind: 'inventory-leaf' | 'inventory-internal';
  readonly first?: Digest32V1;
  readonly last?: Digest32V1;
}

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



interface CowPreparedMutationV1 {
  readonly networkId: NetworkIdV1;
  readonly descriptor: SystemRecordRootDescriptorObjectV1;
  readonly pinnedDescriptorDigest: Digest32V1;
  readonly objects: ReadonlyMap<Digest32V1, SystemRecordInventoryStoredObjectV1>;
  readonly mutation: SystemRecordInventoryMutationV1;
  readonly targetKey: Digest32V1;
  readonly targetPeer: string;
}

interface CowLocatedLeafV1 {
  readonly path: CowPathFrame[];
  readonly leafMutation: CowLeafMutationResultV1;
}

interface CowMutationContextV1 extends CowPreparedMutationV1 {
  loadObject(
    digest: Digest32V1,
    root: boolean,
  ): Pick<SystemRecordInventoryStoredObjectV1, 'objectKind' | 'object'>;
  persistLeaf(
    rows: readonly SystemRecordInventoryRowV1[],
    root: boolean,
    role: SystemRecordInventoryCowWriteV1['role'],
  ): CowChildRef;
  persistInternal(
    children: readonly CowChildRef[],
    root: boolean,
    role: SystemRecordInventoryCowWriteV1['role'],
  ): CowChildRef;
  persistInternalEntries(
    entries: readonly SystemRecordInventoryInternalEntryV1[],
    root: boolean,
    role: SystemRecordInventoryCowWriteV1['role'],
  ): CowChildRef;
  childRef(entry: SystemRecordInventoryInternalEntryV1): CowChildRef;
  finishRootEntries(
    entries: readonly SystemRecordInventoryInternalEntryV1[],
    totalRows: number,
  ): SystemRecordInventoryCowUpdateV1;
  finish(rootDigest: Digest32V1, totalRows: number): SystemRecordInventoryCowUpdateV1;
  unchanged(): SystemRecordInventoryCowUpdateV1;
  totalRows(delta: -1 | 0 | 1): number;
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

function createCowMutationContextV1(prepared: CowPreparedMutationV1): CowMutationContextV1 {
  const { networkId, descriptor, pinnedDescriptorDigest, objects } = prepared;
  const loaded = new Set<Digest32V1>();
  const validatedStoredObjects = new Map<
    string,
    Pick<SystemRecordInventoryStoredObjectV1, 'objectKind' | 'object'>
  >();
  const writes: SystemRecordInventoryCowWriteV1[] = [];
  const nextObjects = new Map<Digest32V1, SystemRecordInventoryStoredObjectV1>();

  function loadObject(
    digest: Digest32V1,
    root: boolean,
  ): Pick<SystemRecordInventoryStoredObjectV1, 'objectKind' | 'object'> {
    const cacheKey = (root ? 'root' : 'child') + ':' + digest;
    const cached = validatedStoredObjects.get(cacheKey);
    if (cached !== undefined) return cached;
    const candidate = Reflect.apply(MAP_GET, objects, [digest]) as unknown;
    if (candidate === undefined) throw new Error('inventory snapshot is missing ' + digest);
    const stored = snapshotExactDataRecord(
      candidate,
      ['objectKind', 'object', 'canonicalBytes'],
      'inventory snapshot stored object',
    );
    if (stored.objectKind !== 'inventory-leaf' && stored.objectKind !== 'inventory-internal') {
      throw new Error('inventory snapshot object kind is invalid');
    }
    const object =
      stored.objectKind === 'inventory-leaf'
        ? validateLeaf(stored.object, networkId, root)
        : validateInternal(stored.object, root);
    const canonicalBytes = canonicalizeJsonBytes(object as unknown as CanonicalJsonValue, {
      maxBytes: SYSTEM_RECORD_OBJECT_CAPS_V1[stored.objectKind],
    });
    const retainedCanonicalBytes = copyBoundedSystemRecordBytesV1(
      stored.canonicalBytes,
      SYSTEM_RECORD_OBJECT_CAPS_V1[stored.objectKind],
      'inventory snapshot stored canonical bytes',
    );
    if (!sameBytes(canonicalBytes, retainedCanonicalBytes)) {
      throw new Error('inventory snapshot stored object does not match its canonical bytes');
    }
    const actual = digestSystemRecordBytesV1(
      stored.objectKind === 'inventory-leaf'
        ? SYSTEM_RECORD_DIGEST_DOMAINS_V1.inventoryLeaf
        : SYSTEM_RECORD_DIGEST_DOMAINS_V1.inventoryInternal,
      canonicalBytes,
    );
    if (actual !== digest) throw new Error('inventory snapshot object digest is invalid');
    loaded.add(digest);
    const validated = Object.freeze({ objectKind: stored.objectKind, object });
    validatedStoredObjects.set(cacheKey, validated);
    return validated;
  }

  function persistLeaf(
    rows: readonly SystemRecordInventoryRowV1[],
    root: boolean,
    role: SystemRecordInventoryCowWriteV1['role'],
  ): CowChildRef {
    const object = makeLeafObject(networkId, rows);
    const bytes = canonicalizeSystemRecordInventoryLeafObjectV1(object, networkId, root);
    const digest = computeSystemRecordInventoryLeafDigestV1(object, networkId, root);
    persist(digest, 'inventory-leaf', object, bytes, role);
    return {
      digest,
      objectKind: 'inventory-leaf',
      first: object.firstKeyHash,
      last: object.lastKeyHash,
    };
  }

  function persistInternal(
    children: readonly CowChildRef[],
    root: boolean,
    role: SystemRecordInventoryCowWriteV1['role'],
  ): CowChildRef {
    return persistInternalObject(makeInternalObject(children), root, role);
  }

  function persistInternalEntries(
    entries: readonly SystemRecordInventoryInternalEntryV1[],
    root: boolean,
    role: SystemRecordInventoryCowWriteV1['role'],
  ): CowChildRef {
    const lastChild = childRef(entries.at(-1)!);
    return persistInternalObject(
      {
        objectType: 'inventory-internal',
        firstKeyHash: entries[0].separatorKeyHash,
        lastKeyHash: lastChild.last!,
        entries: Object.freeze([...entries]),
      },
      root,
      role,
    );
  }

  function persistInternalObject(
    object: SystemRecordInventoryInternalObjectV1,
    root: boolean,
    role: SystemRecordInventoryCowWriteV1['role'],
  ): CowChildRef {
    const bytes = canonicalizeSystemRecordInventoryInternalObjectV1(object, root);
    const digest = computeSystemRecordInventoryInternalDigestV1(object, root);
    persist(digest, 'inventory-internal', object, bytes, role);
    return {
      digest,
      objectKind: 'inventory-internal',
      first: object.firstKeyHash,
      last: object.lastKeyHash,
    };
  }

  function persist(
    digest: Digest32V1,
    objectKind: SystemRecordInventoryStoredObjectV1['objectKind'],
    object: SystemRecordInventoryObjectV1,
    canonicalBytes: Uint8Array,
    role: SystemRecordInventoryCowWriteV1['role'],
  ): void {
    nextObjects.set(digest, Object.freeze({ objectKind, object, canonicalBytes }));
    const existsInSnapshot = Reflect.apply(MAP_HAS, objects, [digest]) as boolean;
    if (existsInSnapshot && loadObject(digest, role === 'root').objectKind !== objectKind) {
      throw new Error('inventory snapshot reuses a digest under a different object kind');
    }
    if (!existsInSnapshot && !writes.some((write) => write.digest === digest)) {
      writes.push(Object.freeze({ digest, objectKind, object, canonicalBytes, role }));
    }
  }

  function childRef(entry: SystemRecordInventoryInternalEntryV1): CowChildRef {
    const stored = nextObjects.get(entry.childDigest) ?? loadObject(entry.childDigest, false);
    if (stored.objectKind !== entry.childKind) {
      throw new Error('updated inventory child kind does not match its reference');
    }
    return {
      digest: entry.childDigest,
      objectKind: entry.childKind,
      first: stored.object.firstKeyHash,
      last: stored.object.lastKeyHash,
    };
  }

  function finishRootEntries(
    entries: readonly SystemRecordInventoryInternalEntryV1[],
    totalRows: number,
  ): SystemRecordInventoryCowUpdateV1 {
    if (entries.length === 1) return finish(entries[0].childDigest, totalRows);
    if (entries.length <= SYSTEM_RECORD_ROOT_MAX_ENTRIES) {
      return finish(persistInternalEntries(entries, true, 'root').digest, totalRows);
    }
    const split = chooseSystemRecordByteAwareSplitIndexV1(
      entries.map(
        (entry) => canonicalizeJsonBytes(entry as unknown as CanonicalJsonValue).byteLength,
      ),
      SYSTEM_RECORD_INTERNAL_MIN_ENTRIES,
      SYSTEM_RECORD_INTERNAL_MIN_ENTRIES,
    );
    const children = [
      persistInternalEntries(entries.slice(0, split), false, 'internal'),
      persistInternalEntries(entries.slice(split), false, 'internal'),
    ];
    return finish(persistInternal(children, true, 'root').digest, totalRows);
  }

  function finish(rootDigest: Digest32V1, totalRows: number): SystemRecordInventoryCowUpdateV1 {
    const nextVersion = parseCanonicalDecimalU64(descriptor.version) + 1n;
    if (nextVersion > 0xffff_ffff_ffff_ffffn) throw new Error('root descriptor version overflow');
    const nextDescriptor: SystemRecordRootDescriptorObjectV1 = {
      objectType: 'root-descriptor',
      kind: SYSTEM_RECORD_KIND_V1,
      networkId,
      epoch: descriptor.epoch,
      version: nextVersion.toString() as DecimalU64V1,
      priorRootDigest: pinnedDescriptorDigest,
      treeRootDigest: rootDigest,
      totalRows: totalRows.toString() as DecimalU64V1,
    };
    const descriptorBytes = canonicalizeSystemRecordRootDescriptorObjectV1(nextDescriptor);
    const accounting: SystemRecordInventoryCowUpdateAccountingV1 = {
      leafObjects: writes.filter((write) => write.role === 'leaf').length,
      internalObjects: writes.filter((write) => write.role === 'internal').length,
      rootObjects: writes.filter((write) => write.role === 'root').length,
      descriptorObjects: 1,
      encodedBytes:
        descriptorBytes.byteLength +
        writes.reduce((sum, write) => sum + write.canonicalBytes.byteLength, 0),
    };
    assertSystemRecordInventoryCowUpdateBoundV1(accounting);
    const reused = new Set<Digest32V1>();
    if (Reflect.apply(MAP_HAS, objects, [rootDigest])) reused.add(rootDigest);
    for (const write of writes) {
      if (write.objectKind !== 'inventory-internal') continue;
      for (const entry of (write.object as SystemRecordInventoryInternalObjectV1).entries) {
        if (Reflect.apply(MAP_HAS, objects, [entry.childDigest])) reused.add(entry.childDigest);
      }
    }
    return Object.freeze({
      changed: true,
      descriptor: validateRootDescriptor(nextDescriptor),
      descriptorDigest: computeSystemRecordRootDescriptorDigestV1(nextDescriptor),
      writes: Object.freeze(writes),
      descriptorBytes,
      accounting: Object.freeze(accounting),
      reusedObjectDigests: reused,
      loadedObjectDigests: loaded,
    });
  }

  function unchanged(): SystemRecordInventoryCowUpdateV1 {
    return Object.freeze({
      changed: false,
      descriptor,
      descriptorDigest: pinnedDescriptorDigest,
      writes: Object.freeze([]),
      accounting: Object.freeze({
        leafObjects: 0,
        internalObjects: 0,
        rootObjects: 0,
        descriptorObjects: 0,
        encodedBytes: 0,
      }),
      reusedObjectDigests: new Set<Digest32V1>(),
      loadedObjectDigests: loaded,
    });
  }

  return {
    ...prepared,
    loadObject,
    persistLeaf,
    persistInternal,
    persistInternalEntries,
    childRef,
    finishRootEntries,
    finish,
    unchanged,
    totalRows: (delta) => Number(parseCanonicalDecimalU64(descriptor.totalRows)) + delta,
  };
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

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function makeLeafObject(
  networkId: NetworkIdV1,
  rows: readonly SystemRecordInventoryRowV1[],
): SystemRecordInventoryLeafObjectV1 {
  const encoded = rows.map((row) => encodeInventoryRowBase64UrlV1(networkId, row));
  return rows.length === 0
    ? Object.freeze({
        objectType: 'inventory-leaf',
        rows: Object.freeze(encoded),
      })
    : Object.freeze({
        objectType: 'inventory-leaf',
        firstKeyHash: rows[0].stableKeyHash,
        lastKeyHash: rows.at(-1)!.stableKeyHash,
        rows: Object.freeze(encoded),
      });
}

function makeInternalObject(
  children: readonly CowChildRef[],
): SystemRecordInventoryInternalObjectV1 {
  if (
    children.length === 0 ||
    children.some((child) => child.first === undefined || child.last === undefined)
  ) {
    throw new Error('internal inventory node requires nonempty ranged children');
  }
  const childKind = children[0].objectKind;
  if (children.some((child) => child.objectKind !== childKind))
    throw new Error('internal children must have one kind');
  return Object.freeze({
    objectType: 'inventory-internal',
    firstKeyHash: children[0].first!,
    lastKeyHash: children.at(-1)!.last!,
    entries: Object.freeze(
      children.map((child) =>
        Object.freeze({
          separatorKeyHash: child.first!,
          childDigest: child.digest,
          childKind,
        }),
      ),
    ),
  });
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

function partitionByTarget<T>(
  values: readonly T[],
  minimum: number,
  maximum: number,
  targetBytes: number,
  encodedBytes: (value: T) => number,
): T[][] {
  if (values.length < minimum) throw new Error('partition cannot meet minimum occupancy');
  const totalBytes = values.reduce((sum, value) => sum + encodedBytes(value), 0);
  const minimumGroups = Math.ceil(values.length / maximum);
  const maximumGroups = Math.floor(values.length / minimum);
  const groups = Math.max(
    minimumGroups,
    Math.min(maximumGroups, Math.max(1, Math.round(totalBytes / targetBytes))),
  );
  const base = Math.floor(values.length / groups);
  const remainder = values.length % groups;
  const result: T[][] = [];
  let offset = 0;
  for (let index = 0; index < groups; index += 1) {
    const count = base + (index < remainder ? 1 : 0);
    result.push(values.slice(offset, offset + count));
    offset += count;
  }
  return result;
}
