import { canonicalizeJsonBytes, type CanonicalJsonValue } from './canonical-json.js';
import type { NetworkIdV1 } from './sync-wire-identifiers.js';
import { snapshotExactDataRecord } from './sync-wire-objects.js';
import {
  parseCanonicalDecimalU64,
  type DecimalU64V1,
  type Digest32V1,
} from './sync-wire-scalars.js';
import {
  copyBoundedSystemRecordBytesV1,
  digestSystemRecordBytesV1,
} from './system-record-codec-primitives-v1.js';
import {
  canonicalizeSystemRecordInventoryInternalObjectV1,
  canonicalizeSystemRecordInventoryLeafObjectV1,
  canonicalizeSystemRecordRootDescriptorObjectV1,
  computeSystemRecordInventoryInternalDigestV1,
  computeSystemRecordInventoryLeafDigestV1,
  computeSystemRecordRootDescriptorDigestV1,
  validateInternal,
  validateLeaf,
  validateRootDescriptor,
  type SystemRecordInventoryInternalEntryV1,
  type SystemRecordInventoryInternalObjectV1,
  type SystemRecordInventoryObjectV1,
  type SystemRecordInventoryRowV1,
  type SystemRecordRootDescriptorObjectV1,
} from './system-record-inventory-codecs-v1-internal.js';
import {
  SYSTEM_RECORD_DIGEST_DOMAINS_V1,
  SYSTEM_RECORD_INTERNAL_MIN_ENTRIES,
  SYSTEM_RECORD_KIND_V1,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
  SYSTEM_RECORD_ROOT_MAX_ENTRIES,
} from './system-record-limits-v1.js';
import {
  assertSystemRecordInventoryCowUpdateBoundV1,
  chooseSystemRecordByteAwareSplitIndexV1,
  makeInternalObject,
  makeLeafObject,
  type CowChildRef,
  type SystemRecordInventoryCowUpdateAccountingV1,
  type SystemRecordInventoryCowUpdateV1,
  type SystemRecordInventoryCowWriteV1,
  type SystemRecordInventoryMutationV1,
  type SystemRecordInventoryStoredObjectV1,
} from './system-record-inventory-cow-build-v1-internal.js';

const MAP_GET = Map.prototype.get;
const MAP_HAS = Map.prototype.has;

export interface CowPreparedMutationV1 {
  readonly networkId: NetworkIdV1;
  readonly descriptor: SystemRecordRootDescriptorObjectV1;
  readonly pinnedDescriptorDigest: Digest32V1;
  readonly objects: ReadonlyMap<Digest32V1, SystemRecordInventoryStoredObjectV1>;
  readonly mutation: SystemRecordInventoryMutationV1;
  readonly targetKey: Digest32V1;
  readonly targetPeer: string;
}

export interface CowMutationContextV1 extends CowPreparedMutationV1 {
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

export function createCowMutationContextV1(
  prepared: CowPreparedMutationV1,
): CowMutationContextV1 {
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

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
