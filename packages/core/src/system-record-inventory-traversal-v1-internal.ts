import { copyBoundedSystemRecordBytesV1 } from './system-record-codec-primitives-v1.js';
import {
  SYSTEM_RECORD_MAX_HEADER_BYTES,
  SYSTEM_RECORD_MAX_INVENTORY_LEAVES,
  SYSTEM_RECORD_MAX_INVENTORY_OBJECTS,
  SYSTEM_RECORD_MAX_INVENTORY_RECORDS,
  SYSTEM_RECORD_LEAF_MAX_ROWS,
  SYSTEM_RECORD_LEAF_MIN_ROWS,
  SYSTEM_RECORD_MAX_SLICE_REQUESTS,
  SYSTEM_RECORD_MAX_SLICE_WIRE_BYTES,
  SYSTEM_RECORD_MAX_TREE_HEIGHT,
  SYSTEM_RECORD_OBJECT_CAPS_V1,
  SYSTEM_RECORD_SLICE_TIMEOUT_MS,
} from './system-record-limits-v1.js';
import {
  computeSystemRecordInventoryInternalDigestV1,
  computeSystemRecordInventoryLeafDigestV1,
  decodeInventoryRowBase64UrlV1,
  parseCanonicalSystemRecordInventoryInternalObjectV1,
  parseCanonicalSystemRecordInventoryLeafObjectV1,
  type SystemRecordInventoryInternalObjectV1,
  type SystemRecordInventoryLeafObjectV1,
  type SystemRecordInventoryRowV1,
  type SystemRecordRootDescriptorObjectV1,
  validateRootDescriptor,
} from './system-record-inventory-codecs-v1-internal.js';
import { parseCanonicalDecimalU64, type Digest32V1 } from './sync-wire-scalars.js';
import { snapshotDataRecord, snapshotExactDataRecord } from './sync-wire-objects.js';

export interface ValidatedSystemRecordInventoryTreeV1 {
  readonly totalRows: number;
  readonly leaves: number;
  readonly height: number;
  readonly objectDigests: ReadonlySet<string>;
}

export interface SystemRecordInventoryLoadedObjectV1 {
  readonly outcome: 'ok';
  readonly objectKind: 'inventory-internal' | 'inventory-leaf';
  readonly canonicalBytes: Uint8Array;
  /** Actual prefix + header + payload bytes consumed from the response stream. */
  readonly wireBytes: number;
}

export interface SystemRecordInventoryRejectedLoadV1 {
  readonly outcome: 'rejected';
  readonly wireBytes: number;
  readonly rejection: 'not-found' | 'invalid-response' | 'busy' | 'transport';
}

export interface SystemRecordInventoryTraversalSliceV1 {
  readonly signal?: AbortSignal;
  readonly maxRequests: number;
  readonly maxWireBytes: number;
  readonly deadlineMs: number;
  readonly nowMs?: () => number;
}

export interface SystemRecordInventoryTraversalSliceResultV1 {
  readonly status: 'paused' | 'complete' | 'rejected';
  readonly requests: number;
  readonly wireBytes: number;
  readonly rejection?: SystemRecordInventoryRejectedLoadV1['rejection'];
  readonly result?: ValidatedSystemRecordInventoryTreeV1;
}

export interface SystemRecordInventoryTraversalV1 {
  /** Advance one bounded validation slice. Concurrent calls are rejected. */
  advance(
    load: (
      digest: Digest32V1,
      expectedKind: 'inventory-internal' | 'inventory-leaf' | undefined,
      signal?: AbortSignal,
    ) => Promise<
      SystemRecordInventoryLoadedObjectV1 | SystemRecordInventoryRejectedLoadV1 | undefined
    >,
    slice: SystemRecordInventoryTraversalSliceV1,
  ): Promise<SystemRecordInventoryTraversalSliceResultV1>;
}

interface SystemRecordInventoryRowTraversalSliceResultBaseV1 {
  readonly requests: number;
  readonly wireBytes: number;
  readonly validatedRows: number;
  readonly validatedLeaves: number;
  /** Canonical rows whose traversal work completed in this physical slice. */
  readonly rows: readonly SystemRecordInventoryRowV1[];
}

export type SystemRecordInventoryRowTraversalSliceResultV1 =
  | Readonly<SystemRecordInventoryRowTraversalSliceResultBaseV1 & {
      readonly status: 'paused';
    }>
  | Readonly<SystemRecordInventoryRowTraversalSliceResultBaseV1 & {
      readonly status: 'complete';
      readonly result: ValidatedSystemRecordInventoryTreeV1;
    }>
  | Readonly<SystemRecordInventoryRowTraversalSliceResultBaseV1 & {
      readonly status: 'rejected';
      readonly rejection: SystemRecordInventoryRejectedLoadV1['rejection'];
    }>
  | Readonly<SystemRecordInventoryRowTraversalSliceResultBaseV1 & {
      readonly status: 'failed';
      readonly failure: SystemRecordInventoryRowTraversalFailureV1;
    }>;

export interface SystemRecordInventoryRowTraversalFailureV1 {
  readonly reason:
    | 'aborted'
    | 'deadline'
    | 'not-found'
    | 'invalid-response'
    | 'transport'
    | 'invalid-slice';
  readonly message: string;
  /** Original loader failure when the row traversal classifies a transport error. */
  readonly cause?: unknown;
}

export interface SystemRecordInventoryRowTraversalV1 {
  /** Advance one bounded row-producing slice. Concurrent calls are rejected. */
  advance(
    load: (
      digest: Digest32V1,
      expectedKind: 'inventory-internal' | 'inventory-leaf',
      signal: AbortSignal | undefined,
      path: readonly number[],
    ) => Promise<
      SystemRecordInventoryLoadedObjectV1 | SystemRecordInventoryRejectedLoadV1 | undefined
    >,
    slice: SystemRecordInventoryTraversalSliceV1,
  ): Promise<SystemRecordInventoryRowTraversalSliceResultV1>;
}

interface SystemRecordInventoryTraversalStepResultBaseV1 {
  readonly requests: number;
  readonly wireBytes: number;
  readonly validatedRows: number;
  readonly validatedLeaves: number;
}

type SystemRecordInventoryTraversalStepResultV1 =
  | Readonly<SystemRecordInventoryTraversalStepResultBaseV1 & {
      readonly status: 'paused';
    }>
  | Readonly<SystemRecordInventoryTraversalStepResultBaseV1 & {
      readonly status: 'complete';
      readonly result: ValidatedSystemRecordInventoryTreeV1;
    }>
  | Readonly<SystemRecordInventoryTraversalStepResultBaseV1 & {
      readonly status: 'rejected';
      readonly rejection: SystemRecordInventoryRejectedLoadV1['rejection'];
    }>
  | Readonly<SystemRecordInventoryTraversalStepResultBaseV1 & {
      readonly status: 'failed';
      readonly failure: SystemRecordInventoryRowTraversalFailureV1;
    }>;

interface SystemRecordInventoryTraversalStepperV1 {
  advance(
    load: (
      digest: Digest32V1,
      expectedKind: 'inventory-internal' | 'inventory-leaf',
      signal: AbortSignal | undefined,
      path: readonly number[],
    ) => Promise<
      SystemRecordInventoryLoadedObjectV1 | SystemRecordInventoryRejectedLoadV1 | undefined
    >,
    slice: SystemRecordInventoryTraversalSliceV1,
    emitRow?: (row: SystemRecordInventoryRowV1) => void,
  ): Promise<SystemRecordInventoryTraversalStepResultV1>;
}

interface SystemRecordInventoryTraversalWorkBaseV1 {
  readonly digest: Digest32V1;
  readonly depth: number;
  readonly expectedFirst?: Digest32V1;
  readonly upperExclusive?: Digest32V1;
  readonly expectedLast?: Digest32V1;
  readonly path: readonly number[];
}

interface SystemRecordInventoryTraversalRootProbeWorkV1
  extends SystemRecordInventoryTraversalWorkBaseV1 {
  readonly workType: 'root-probe';
  readonly depth: 1;
  readonly expectedKinds: readonly ('inventory-internal' | 'inventory-leaf')[];
}

interface SystemRecordInventoryTraversalNodeWorkV1
  extends SystemRecordInventoryTraversalWorkBaseV1 {
  readonly workType: 'node';
  readonly expectedKind: 'inventory-internal' | 'inventory-leaf';
}

type SystemRecordInventoryTraversalWorkV1 =
  | SystemRecordInventoryTraversalRootProbeWorkV1
  | SystemRecordInventoryTraversalNodeWorkV1;

/** Preserve the original validation-only V1 contract and rejection behavior. */
export function createSystemRecordInventoryTraversalV1(
  descriptor: SystemRecordRootDescriptorObjectV1,
): SystemRecordInventoryTraversalV1 {
  const traversal = createSystemRecordInventoryTraversalStepperV1(descriptor);
  return Object.freeze({ advance });

  async function advance(
    load: (
      digest: Digest32V1,
      expectedKind: 'inventory-internal' | 'inventory-leaf' | undefined,
      signal?: AbortSignal,
    ) => Promise<
      SystemRecordInventoryLoadedObjectV1 | SystemRecordInventoryRejectedLoadV1 | undefined
    >,
    slice: SystemRecordInventoryTraversalSliceV1,
  ): Promise<SystemRecordInventoryTraversalSliceResultV1> {
    const advanced = await traversal.advance(
      (digest, expectedKind, signal, path) => load(
        digest,
        path.length === 0 ? undefined : expectedKind,
        signal,
      ),
      slice,
    );
    if (advanced.status === 'failed') {
      if (
        advanced.failure.reason === 'transport'
        && advanced.failure.cause !== undefined
      ) {
        throw advanced.failure.cause;
      }
      throw new Error(advanced.failure.message);
    }
    if (advanced.status === 'complete') {
      return Object.freeze({
        status: advanced.status,
        requests: advanced.requests,
        wireBytes: advanced.wireBytes,
        result: advanced.result,
      });
    }
    if (advanced.status === 'rejected') {
      return Object.freeze({
        status: advanced.status,
        requests: advanced.requests,
        wireBytes: advanced.wireBytes,
        rejection: advanced.rejection,
      });
    }
    return Object.freeze({
      status: advanced.status,
      requests: advanced.requests,
      wireBytes: advanced.wireBytes,
    });
  }
}

/** Create a pinned traversal dedicated to bounded, lossless row reconciliation. */
export function createSystemRecordInventoryRowTraversalV1(
  descriptor: SystemRecordRootDescriptorObjectV1,
): SystemRecordInventoryRowTraversalV1 {
  const traversal = createSystemRecordInventoryTraversalStepperV1(descriptor);
  return Object.freeze({ advance });

  async function advance(
    load: (
      digest: Digest32V1,
      expectedKind: 'inventory-internal' | 'inventory-leaf',
      signal: AbortSignal | undefined,
      path: readonly number[],
    ) => Promise<
      SystemRecordInventoryLoadedObjectV1 | SystemRecordInventoryRejectedLoadV1 | undefined
    >,
    slice: SystemRecordInventoryTraversalSliceV1,
  ): Promise<SystemRecordInventoryRowTraversalSliceResultV1> {
    const rows: SystemRecordInventoryRowV1[] = [];
    const advanced = await traversal.advance(load, slice, (row) => rows.push(row));
    return Object.freeze({
      ...advanced,
      rows: Object.freeze(rows),
    }) as SystemRecordInventoryRowTraversalSliceResultV1;
  }
}

function createSystemRecordInventoryTraversalStepperV1(
  descriptor: SystemRecordRootDescriptorObjectV1,
): SystemRecordInventoryTraversalStepperV1 {
  const pinned = validateRootDescriptor(descriptor);
  const expectedRows = Number(parseCanonicalDecimalU64(pinned.totalRows));
  const seen = new Set<string>();
  const pending: SystemRecordInventoryTraversalWorkV1[] = [
    {
      workType: 'root-probe',
      digest: pinned.treeRootDigest,
      depth: 1,
      expectedKinds: rootExpectedKinds(expectedRows),
      path: Object.freeze([]),
    },
  ];
  let rows = 0;
  let leaves = 0;
  let maximumDepth = 0;
  let leafDepth: number | undefined;
  let advancing = false;
  let completed:
    | Readonly<{
        totalRows: number;
        leaves: number;
        height: number;
        objectDigests: readonly string[];
      }>
    | undefined;

  return Object.freeze({ advance });

  async function advance(
    load: (
      digest: Digest32V1,
      expectedKind: 'inventory-internal' | 'inventory-leaf',
      signal: AbortSignal | undefined,
      path: readonly number[],
    ) => Promise<
      SystemRecordInventoryLoadedObjectV1 | SystemRecordInventoryRejectedLoadV1 | undefined
    >,
    slice: SystemRecordInventoryTraversalSliceV1,
    emitRow?: (row: SystemRecordInventoryRowV1) => void,
  ): Promise<SystemRecordInventoryTraversalStepResultV1> {
    if (advancing) throw new Error('inventory traversal already has an active slice');
    if (completed !== undefined) {
      return Object.freeze({
        status: 'complete',
        requests: 0,
        wireBytes: 0,
        validatedRows: rows,
        validatedLeaves: leaves,
        result: completedResult(),
      });
    }
    let requests = 0;
    let wireBytes = 0;
    let admittedSignal: AbortSignal | undefined;
    advancing = true;
    try {
      // Pin the admitted budget before the first await. Callers commonly reuse mutable
      // scheduler state; re-reading it after load() would let one slice grow in flight.
      admittedSignal = slice.signal;
      const signal = admittedSignal;
      const maxRequests = slice.maxRequests;
      const maxWireBytes = slice.maxWireBytes;
      const deadlineMs = slice.deadlineMs;
      const now = slice.nowMs ?? Date.now;
      if (typeof now !== 'function') throw new InventoryTraversalSliceError();
      const readNow = (): number => {
        let current: number;
        try {
          current = now();
        } catch (error) {
          throw new InventoryTraversalSliceError('inventory traversal clock failed', error);
        }
        if (!Number.isSafeInteger(current) || current < 0) {
          throw new InventoryTraversalSliceError('inventory traversal clock is invalid');
        }
        return current;
      };
      const admittedAtMs = readNow();
      if (
        !Number.isSafeInteger(maxRequests) ||
        maxRequests < 1 ||
        maxRequests > SYSTEM_RECORD_MAX_SLICE_REQUESTS ||
        !Number.isSafeInteger(maxWireBytes) ||
        maxWireBytes < framedObjectMaximum('inventory-leaf') ||
        maxWireBytes > SYSTEM_RECORD_MAX_SLICE_WIRE_BYTES ||
        !Number.isSafeInteger(deadlineMs) ||
        !Number.isSafeInteger(admittedAtMs) ||
        admittedAtMs < 0 ||
        deadlineMs > admittedAtMs + SYSTEM_RECORD_SLICE_TIMEOUT_MS
      ) {
        throw new InventoryTraversalSliceError();
      }
      while (pending.length > 0) {
        abortIfNeeded(signal);
        if (readNow() >= deadlineMs) break;
        const work = pending[pending.length - 1];
        const expectedKind = work.workType === 'root-probe'
          ? work.expectedKinds[0]!
          : work.expectedKind;
        const maximumNextBytes = framedObjectMaximum(
          expectedKind,
        );
        if (requests >= maxRequests || wireBytes + maximumNextBytes > maxWireBytes) break;
        if (work.depth > SYSTEM_RECORD_MAX_TREE_HEIGHT)
          throw new Error('inventory tree exceeds height three');
        if (seen.has(work.digest))
          throw new Error('inventory tree must not contain a cycle or duplicate path');
        if (seen.size >= SYSTEM_RECORD_MAX_INVENTORY_OBJECTS) {
          throw new Error('inventory traversal exceeds its object budget');
        }
        const remainingMs = deadlineMs - readNow();
        if (remainingMs <= 0) break;
        let loaded:
          | SystemRecordInventoryLoadedObjectV1
          | SystemRecordInventoryRejectedLoadV1
          | undefined;
        try {
          loaded = await loadInventoryObjectWithinDeadlineV1(
            (loadSignal) => {
              requests += 1;
              return load(
                work.digest,
                expectedKind,
                loadSignal,
                Object.freeze([...work.path]),
              );
            },
            signal,
            remainingMs,
          );
        } catch (error) {
          if (signal?.aborted || error instanceof InventoryTraversalDeadlineError) throw error;
          throw new InventoryTraversalTransportError(error);
        }
        if (loaded === undefined) {
          if (advanceRootProbe(work)) {
            return pausedSliceResult(requests, wireBytes);
          }
          throw new InventoryTraversalNotFoundError(work.digest);
        }
        const probe = snapshotDataRecord(loaded, 'inventory loader result', {
          rejectNullValues: true,
        });
        if (
          !Number.isSafeInteger(probe.wireBytes)
          || (probe.wireBytes as number) < 0
          || (probe.wireBytes as number) > maximumNextBytes
          || wireBytes + (probe.wireBytes as number) > maxWireBytes
        ) {
          throw new Error('inventory loader returned invalid actual wire accounting');
        }
        wireBytes += probe.wireBytes as number;
        abortIfNeeded(signal);
        if (readNow() >= deadlineMs) {
          throw new InventoryTraversalDeadlineError();
        }
        if (probe.outcome === 'rejected') {
          const rejected = snapshotExactDataRecord(
            probe,
            ['outcome', 'wireBytes', 'rejection'],
            'rejected inventory loader result',
          );
          if (
            rejected.rejection !== 'not-found' &&
            rejected.rejection !== 'invalid-response' &&
            rejected.rejection !== 'busy' &&
            rejected.rejection !== 'transport'
          ) {
            throw new Error('inventory loader returned an invalid rejection');
          }
          if (rejected.rejection === 'not-found' && advanceRootProbe(work)) {
            return pausedSliceResult(requests, wireBytes);
          }
          return Object.freeze({
            status: 'rejected',
            requests,
            wireBytes,
            validatedRows: rows,
            validatedLeaves: leaves,
            rejection: rejected.rejection,
          });
        }
        if (probe.outcome !== 'ok') throw new Error('inventory loader returned an invalid outcome');
        const artifact = snapshotExactDataRecord(
          probe,
          ['outcome', 'objectKind', 'canonicalBytes', 'wireBytes'],
          'successful inventory loader result',
        );
        if (
          !Number.isSafeInteger(artifact.wireBytes)
        ) {
          throw new Error('inventory loader returned invalid actual wire accounting');
        }
        if (
          artifact.objectKind !== 'inventory-leaf' &&
          artifact.objectKind !== 'inventory-internal'
        ) {
          throw new Error('inventory loader returned an invalid object kind');
        }
        const canonicalBytes = copyBoundedSystemRecordBytesV1(
          artifact.canonicalBytes,
          SYSTEM_RECORD_OBJECT_CAPS_V1[artifact.objectKind],
          'inventory loader canonical bytes',
        );
        if ((artifact.wireBytes as number) < 6 + canonicalBytes.byteLength) {
          throw new Error('inventory loader returned an over-cap object');
        }
        const kindMatches = work.workType === 'root-probe'
          ? work.expectedKinds.includes(artifact.objectKind)
          : artifact.objectKind === expectedKind;
        if (!kindMatches) {
          throw new Error('inventory child kind mismatch');
        }
        const root = work.depth === 1;
        const object =
          artifact.objectKind === 'inventory-leaf'
            ? parseCanonicalSystemRecordInventoryLeafObjectV1(
                canonicalBytes,
                pinned.networkId,
                root,
              )
            : parseCanonicalSystemRecordInventoryInternalObjectV1(canonicalBytes, root);
        const actualDigest =
          artifact.objectKind === 'inventory-leaf'
            ? computeSystemRecordInventoryLeafDigestV1(
                object as SystemRecordInventoryLeafObjectV1,
                pinned.networkId,
                root,
              )
            : computeSystemRecordInventoryInternalDigestV1(
                object as SystemRecordInventoryInternalObjectV1,
                root,
              );
        if (actualDigest !== work.digest) throw new Error('inventory object digest mismatch');
        const first = object.firstKeyHash;
        const last = object.lastKeyHash;
        if (work.expectedFirst !== undefined && first !== work.expectedFirst) {
          throw new Error('inventory child lower range mismatch');
        }
        if (
          work.upperExclusive !== undefined &&
          last !== undefined &&
          last >= work.upperExclusive
        ) {
          throw new Error('inventory child range overlaps its next sibling');
        }
        if (work.expectedLast !== undefined && last !== work.expectedLast) {
          throw new Error('inventory final child range mismatch');
        }
        pending.pop();
        seen.add(work.digest);
        maximumDepth = Math.max(maximumDepth, work.depth);
        if (artifact.objectKind === 'inventory-leaf') {
          const leaf = object as SystemRecordInventoryLeafObjectV1;
          if (leafDepth !== undefined && work.depth !== leafDepth) {
            throw new Error('inventory tree leaves must all have the same depth');
          }
          leafDepth = work.depth;
          leaves += 1;
          rows += leaf.rows.length;
          for (const encoded of leaf.rows) {
            const decoded = decodeInventoryRowBase64UrlV1(pinned.networkId, encoded);
            emitRow?.(decoded);
          }
          if (
            leaves > SYSTEM_RECORD_MAX_INVENTORY_LEAVES ||
            rows > SYSTEM_RECORD_MAX_INVENTORY_RECORDS ||
            rows > expectedRows
          ) {
            throw new Error('inventory traversal exceeds its leaf/row bound');
          }
        } else {
          if (work.depth === SYSTEM_RECORD_MAX_TREE_HEIGHT) {
            throw new Error('internal node appears below height bound');
          }
          const internal = object as SystemRecordInventoryInternalObjectV1;
          for (let index = internal.entries.length - 1; index >= 0; index -= 1) {
            const entry = internal.entries[index];
            pending.push({
              workType: 'node',
              digest: entry.childDigest,
              depth: work.depth + 1,
              expectedKind: entry.childKind,
              expectedFirst: entry.separatorKeyHash,
              ...(index === internal.entries.length - 1
                ? {}
                : {
                    upperExclusive: internal.entries[index + 1].separatorKeyHash,
                  }),
              ...(index === internal.entries.length - 1
                ? { expectedLast: internal.lastKeyHash }
                : {}),
              path: Object.freeze([...work.path, index]),
            });
          }
        }
      }
      if (pending.length !== 0) {
        return Object.freeze({
          status: 'paused',
          requests,
          wireBytes,
          validatedRows: rows,
          validatedLeaves: leaves,
        });
      }
      if (rows !== expectedRows)
        throw new Error('inventory traversal total does not match descriptor.totalRows');
      if (rows === 0 && leaves !== 1) throw new Error('empty inventory must use one root leaf');
      completed = Object.freeze({
        totalRows: rows,
        leaves,
        height: maximumDepth,
        objectDigests: Object.freeze([...seen]),
      });
      return Object.freeze({
        status: 'complete',
        requests,
        wireBytes,
        validatedRows: rows,
        validatedLeaves: leaves,
        result: completedResult(),
      });
    } catch (error) {
      const reason = traversalFailureReason(error, admittedSignal);
      return Object.freeze({
        status: 'failed',
        requests,
        wireBytes,
        validatedRows: rows,
        validatedLeaves: leaves,
        failure: Object.freeze({
          reason,
          message: error instanceof Error ? error.message : 'inventory traversal failed',
          ...(reason === 'transport' && error instanceof InventoryTraversalTransportError
            ? { cause: error.cause }
            : {}),
        }),
      });
    } finally {
      advancing = false;
    }
  }

  function advanceRootProbe(work: SystemRecordInventoryTraversalWorkV1): boolean {
    if (work.workType !== 'root-probe' || work.expectedKinds.length < 2) return false;
    pending[pending.length - 1] = Object.freeze({
      ...work,
      expectedKinds: Object.freeze(work.expectedKinds.slice(1)),
    });
    return true;
  }

  function pausedSliceResult(
    requests: number,
    wireBytes: number,
  ): SystemRecordInventoryTraversalStepResultV1 {
    return Object.freeze({
      status: 'paused',
      requests,
      wireBytes,
      validatedRows: rows,
      validatedLeaves: leaves,
    });
  }

  function completedResult(): ValidatedSystemRecordInventoryTreeV1 {
    if (completed === undefined) throw new Error('inventory traversal is not complete');
    return Object.freeze({
      totalRows: completed.totalRows,
      leaves: completed.leaves,
      height: completed.height,
      objectDigests: new Set(completed.objectDigests),
    });
  }
}

function rootExpectedKinds(
  expectedRows: number,
): readonly ('inventory-internal' | 'inventory-leaf')[] {
  if (expectedRows < 2 * SYSTEM_RECORD_LEAF_MIN_ROWS) {
    return Object.freeze(['inventory-leaf']);
  }
  if (expectedRows > SYSTEM_RECORD_LEAF_MAX_ROWS) {
    return Object.freeze(['inventory-internal']);
  }
  return Object.freeze(['inventory-leaf', 'inventory-internal']);
}

function framedObjectMaximum(objectKind: 'inventory-internal' | 'inventory-leaf'): number {
  return 4 + SYSTEM_RECORD_MAX_HEADER_BYTES + SYSTEM_RECORD_OBJECT_CAPS_V1[objectKind];
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('inventory traversal aborted');
}

class InventoryTraversalSliceError extends Error {
  constructor(message = 'inventory traversal slice budget is invalid', cause?: unknown) {
    super(message, { cause });
  }
}

class InventoryTraversalDeadlineError extends Error {
  constructor() {
    super('inventory traversal slice deadline expired during load');
  }
}

class InventoryTraversalNotFoundError extends Error {
  constructor(digest: Digest32V1) {
    super(`inventory tree is missing ${digest}`);
  }
}

class InventoryTraversalTransportError extends Error {
  constructor(cause: unknown) {
    super('inventory traversal loader failed', { cause });
  }
}

function traversalFailureReason(
  error: unknown,
  signal: AbortSignal | undefined,
): SystemRecordInventoryRowTraversalFailureV1['reason'] {
  if (signal?.aborted) return 'aborted';
  if (error instanceof InventoryTraversalDeadlineError) return 'deadline';
  if (error instanceof InventoryTraversalNotFoundError) return 'not-found';
  if (error instanceof InventoryTraversalTransportError) return 'transport';
  if (error instanceof InventoryTraversalSliceError) return 'invalid-slice';
  return 'invalid-response';
}

async function loadInventoryObjectWithinDeadlineV1<T>(
  load: (signal: AbortSignal) => Promise<T>,
  admittedSignal: AbortSignal | undefined,
  remainingMs: number,
): Promise<T> {
  if (
    !Number.isSafeInteger(remainingMs) ||
    remainingMs < 1 ||
    remainingMs > SYSTEM_RECORD_SLICE_TIMEOUT_MS
  ) {
    throw new Error('inventory traversal load deadline is invalid');
  }
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectBoundary: ((reason?: unknown) => void) | undefined;
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject;
    timeout = setTimeout(() => {
      const reason = new InventoryTraversalDeadlineError();
      controller.abort(reason);
      reject(reason);
    }, remainingMs);
  });
  const onAbort = (): void => {
    let reason: unknown;
    try {
      reason = admittedSignal?.reason;
    } catch {
      reason = undefined;
    }
    reason ??= new Error('inventory traversal aborted');
    controller.abort(reason);
    rejectBoundary?.(reason);
  };
  try {
    if (admittedSignal?.aborted) onAbort();
    else admittedSignal?.addEventListener('abort', onAbort, { once: true });
    return await Promise.race([
      Promise.resolve().then(() => {
        abortIfNeeded(controller.signal);
        return load(controller.signal);
      }),
      boundary,
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    admittedSignal?.removeEventListener('abort', onAbort);
  }
}
