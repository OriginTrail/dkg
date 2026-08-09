import { canonicalizeJsonBytes, type CanonicalJsonValue } from './canonical-json.js';
import { assertNetworkIdV1, type NetworkIdV1 } from './sync-wire-identifiers.js';
import { snapshotDataArray, snapshotExactDataRecord } from './sync-wire-objects.js';
import {
  assertCanonicalDecimalU64,
  type DecimalU64V1,
  type Digest32V1,
} from './sync-wire-scalars.js';
import {
  canonicalizeSystemRecordInventoryInternalObjectV1,
  canonicalizeSystemRecordInventoryLeafObjectV1,
  computeSystemRecordInventoryInternalDigestV1,
  computeSystemRecordInventoryLeafDigestV1,
  computeSystemRecordRootDescriptorDigestV1,
  compareRows,
  encodeInventoryRowBase64UrlV1,
  encodeSystemRecordInventoryRowV1,
  validateInventoryRow,
  validateRootDescriptor,
  type SystemRecordInventoryInternalObjectV1,
  type SystemRecordInventoryLeafObjectV1,
  type SystemRecordInventoryObjectV1,
  type SystemRecordInventoryRowV1,
  type SystemRecordRootDescriptorObjectV1,
} from './system-record-inventory-codecs-v1-internal.js';
import {
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
  SYSTEM_RECORD_MAX_TREE_UPDATE_BYTES,
  SYSTEM_RECORD_MAX_TREE_UPDATE_OBJECTS,
  SYSTEM_RECORD_ROOT_MAX_ENTRIES,
} from './system-record-limits-v1.js';

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

export interface CowChildRef {
  readonly digest: Digest32V1;
  readonly objectKind: 'inventory-leaf' | 'inventory-internal';
  readonly first?: Digest32V1;
  readonly last?: Digest32V1;
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

export function makeLeafObject(
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

export function makeInternalObject(
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
