import { peerIdFromMultihash } from '@libp2p/peer-id';
import { create as createMultihashDigest } from 'multiformats/hashes/digest';
import { describe, expect, it } from 'vitest';

import {
  assertSystemRecordInventoryCowUpdateBoundV1,
  buildSystemRecordInventoryTreeV1,
  createSystemRecordInventoryTraversalV1,
  chooseSystemRecordByteAwareSplitIndexV1,
  chooseSystemRecordRebalanceV1,
  canonicalizeSystemRecordInventoryInternalObjectV1,
  canonicalizeSystemRecordRootDescriptorObjectV1,
  computeSystemRecordInventoryLeafDigestV1,
  computeSystemRecordInventoryInternalDigestV1,
  computeSystemRecordRootDescriptorDigestV1,
  computeSystemRecordStableKeyHashV1,
  decodeInventoryRowBase64UrlV1,
  decodeSystemRecordInventoryRowV1,
  encodeInventoryRowBase64UrlV1,
  encodeSystemRecordInventoryRowV1,
  parseCanonicalSystemRecordInventoryLeafObjectV1,
  canonicalizeSystemRecordInventoryLeafObjectV1,
  updateSystemRecordInventoryTreeV1,
  systemRecordInventoryRowMaxEncodedBytesV1,
  type SystemRecordInventoryLeafObjectV1,
  type SystemRecordInventoryInternalObjectV1,
  type SystemRecordInventoryCowUpdateV1,
  type SystemRecordInventoryRowV1,
  type SystemRecordInventoryStoredObjectV1,
  type SystemRecordInventoryTreeSnapshotV1,
} from '../src/system-record-inventory-v1.js';
import {
  createSystemRecordInventoryRowTraversalV1,
} from '../src/system-record-inventory-row-traversal-v1.js';
import {
  SYSTEM_RECORD_MAX_EVIDENCE_ROW_BYTES,
  SYSTEM_RECORD_MAX_INVENTORY_RECORDS,
  SYSTEM_RECORD_MAX_ORDINARY_ROW_BYTES,
  SYSTEM_RECORD_MAX_ROW_BYTES,
  SYSTEM_RECORD_SLICE_TIMEOUT_MS,
} from '../src/system-record-limits-v1.js';

const NETWORK = 'otp:20430' as const;
const HEAD = `0x${'aa'.repeat(32)}` as const;
const EVIDENCE = `0x${'bb'.repeat(32)}` as const;
const PEER_A = '12D3KooWJ1TsijH7H5F74hfAD5XishQz3sxrmAtVY37GtNd9CqYf';
const PEER_B = '12D3KooWDxBauQDeJjCmcvWiREFALfKsr5VfTzGUJbZJ6CUcc7aF';

describe('system-record compact inventory rows', () => {
  it('pins ordinary/evidence maximum rows at 340/372 bytes and accepts version zero', () => {
    expect(systemRecordInventoryRowMaxEncodedBytesV1(256)).toBe(SYSTEM_RECORD_MAX_ORDINARY_ROW_BYTES);
    expect(systemRecordInventoryRowMaxEncodedBytesV1(256, true)).toBe(SYSTEM_RECORD_MAX_EVIDENCE_ROW_BYTES);
    const ordinary = row(PEER_A);
    const evidence = { ...ordinary, quarantined: true, conflictEvidenceDigest: EVIDENCE };
    expect(encodeSystemRecordInventoryRowV1(NETWORK, ordinary).byteLength).toBeLessThanOrEqual(SYSTEM_RECORD_MAX_ORDINARY_ROW_BYTES);
    expect(encodeSystemRecordInventoryRowV1(NETWORK, evidence).byteLength).toBeLessThanOrEqual(SYSTEM_RECORD_MAX_EVIDENCE_ROW_BYTES);
    expect(decodeSystemRecordInventoryRowV1(NETWORK, encodeSystemRecordInventoryRowV1(NETWORK, ordinary)))
      .toEqual(ordinary);
    expect(decodeSystemRecordInventoryRowV1(NETWORK, encodeSystemRecordInventoryRowV1(NETWORK, evidence)))
      .toEqual(evidence);
  });

  it('normalizes row objects and bytes through intrinsic snapshots', () => {
    const value = row(PEER_A);
    const encoded = encodeSystemRecordInventoryRowV1(NETWORK, value);
    const hostileRow = new Proxy(value, {
      get(target, property, receiver) {
        if (property === 'peerId') return PEER_B;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(encodeSystemRecordInventoryRowV1(NETWORK, hostileRow)).toEqual(encoded);

    class MisleadingRowBytes extends Uint8Array {
      override get byteLength(): number { return 1; }
      override subarray(): Uint8Array { return new Uint8Array(); }
    }
    expect(decodeSystemRecordInventoryRowV1(NETWORK, new MisleadingRowBytes(encoded))).toEqual(value);
  });

  it('rejects mismatched stable keys and inconsistent quarantine evidence', () => {
    expect(() => encodeSystemRecordInventoryRowV1(NETWORK, {
      ...row(PEER_A), quarantined: false, conflictEvidenceDigest: EVIDENCE,
    })).toThrow(/quarantined/);
    expect(() => encodeSystemRecordInventoryRowV1(NETWORK, {
      ...row(PEER_A), quarantined: true,
    })).toThrow(/conflict evidence/);
    const contradictoryTerminal = {
      ...row(PEER_A), tombstone: true, quarantined: true, conflictEvidenceDigest: EVIDENCE,
    };
    expect(() => encodeSystemRecordInventoryRowV1(NETWORK, contradictoryTerminal))
      .toThrow(/tombstone.*quarantine/);
    const contradictoryTerminalBytes = encodeSystemRecordInventoryRowV1(NETWORK, {
      ...row(PEER_A), quarantined: true, conflictEvidenceDigest: EVIDENCE,
    });
    contradictoryTerminalBytes[contradictoryTerminalBytes.byteLength - 1] |= 0b001;
    expect(() => decodeSystemRecordInventoryRowV1(NETWORK, contradictoryTerminalBytes))
      .toThrow(/tombstone.*quarantine/);
    const quarantinedWithoutEvidence = encodeSystemRecordInventoryRowV1(NETWORK, row(PEER_A));
    quarantinedWithoutEvidence[quarantinedWithoutEvidence.byteLength - 1] |= 0b010;
    expect(() => decodeSystemRecordInventoryRowV1(NETWORK, quarantinedWithoutEvidence))
      .toThrow(/conflict evidence/);
    const encoded = encodeSystemRecordInventoryRowV1(NETWORK, row(PEER_A));
    expect(() => decodeSystemRecordInventoryRowV1('other:network' as typeof NETWORK, encoded))
      .toThrow(/stable key/);
    expect(() => decodeInventoryRowBase64UrlV1(
      NETWORK,
      'A'.repeat(Math.ceil(SYSTEM_RECORD_MAX_ROW_BYTES * 4 / 3) + 1),
    )).toThrow(/base64url/);
  });

  it('accepts authority sequence 14 and rejects sequence 15', () => {
    const atCap = { ...row(PEER_A), authoritySequence: '14' as const };
    expect(decodeSystemRecordInventoryRowV1(
      NETWORK,
      encodeSystemRecordInventoryRowV1(NETWORK, atCap),
    )).toEqual(atCap);
    expect(() => encodeSystemRecordInventoryRowV1(NETWORK, {
      ...row(PEER_A), authoritySequence: '15',
    })).toThrow(/authoritySequence.*V1 cap/);
  });
});

describe('system-record immutable B+tree objects', () => {
  it('round-trips a root leaf and rejects mutable publication/path fields', async () => {
    const rows = [row(PEER_A), row(PEER_B)].sort((a, b) =>
      a.stableKeyHash.localeCompare(b.stableKeyHash));
    const leaf = leafFor(rows);
    const bytes = canonicalizeSystemRecordInventoryLeafObjectV1(leaf, NETWORK, true);
    expect(parseCanonicalSystemRecordInventoryLeafObjectV1(bytes, NETWORK, true)).toEqual(leaf);
    expect(() => canonicalizeSystemRecordInventoryLeafObjectV1({
      ...leaf, epoch: '1', path: [0],
    } as unknown as SystemRecordInventoryLeafObjectV1, NETWORK, true)).toThrow(/unknown or missing/);

    const treeDigest = computeSystemRecordInventoryLeafDigestV1(leaf, NETWORK, true);
    const descriptor = {
      objectType: 'root-descriptor', kind: 'agents', networkId: NETWORK,
      epoch: '0', version: '0', treeRootDigest: treeDigest, totalRows: '2',
    } as const;
    const result = await validateTree(
      descriptor,
      async (digest) => digest === treeDigest ? leaf : undefined,
    );
    expect(result).toMatchObject({ totalRows: 2, leaves: 1, height: 1 });
    expect(computeSystemRecordRootDescriptorDigestV1(descriptor)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('validates descriptor totals and refuses incomplete traversal', async () => {
    const rows = [row(PEER_A)];
    const leaf = leafFor(rows);
    const digest = computeSystemRecordInventoryLeafDigestV1(leaf, NETWORK, true);
    const descriptor = {
      objectType: 'root-descriptor', kind: 'agents', networkId: NETWORK,
      epoch: '0', version: '0', treeRootDigest: digest, totalRows: '2',
    } as const;
    await expect(validateTree(descriptor, async () => leaf))
      .rejects.toThrow(/total/);
    await expect(validateTree(
      { ...descriptor, totalRows: '1' },
      async () => undefined,
    )).rejects.toThrow(/missing/);
    let loads = 0;
    await expect(validateTree(
      { ...descriptor, totalRows: '0' },
      async () => { loads += 1; return leaf; },
    )).rejects.toThrow(/row bound/);
    expect(loads).toBe(1);
    const controller = new AbortController();
    controller.abort(new Error('stop-now'));
    await expect(validateTree(
      { ...descriptor, totalRows: '1' },
      async () => leaf,
      controller.signal,
    )).rejects.toThrow(/stop-now/);
  });

  it('enforces slice request/byte budgets and observes abort after an awaited load', async () => {
    const snapshot = buildSystemRecordInventoryTreeV1(NETWORK, deterministicPeers(513).map(row));
    const traversal = createSystemRecordInventoryRowTraversalV1(snapshot.descriptor);
    let slices = 0;
    let totalWireBytes = 0;
    let discoveredLeaves = 0;
    let sawCumulativeProgressBeyondSlice = false;
    const requestedPaths: number[][] = [];
    const discoveredRows: SystemRecordInventoryRowV1[] = [];
    const digestByPath = new Map<string, typeof snapshot.descriptor.treeRootDigest>();
    const indexPaths = (
      digest: typeof snapshot.descriptor.treeRootDigest,
      path: readonly number[],
    ): void => {
      digestByPath.set(JSON.stringify(path), digest);
      const stored = snapshot.objects.get(digest)!;
      if (stored.objectKind !== 'inventory-internal') return;
      const internal = stored.object as SystemRecordInventoryInternalObjectV1;
      internal.entries.forEach((entry, index) => indexPaths(entry.childDigest, [...path, index]));
    };
    indexPaths(snapshot.descriptor.treeRootDigest, []);
    while (true) {
      const result = await traversal.advance(async (digest, _expectedKind, _signal, path) => {
        expect(Object.isFrozen(path)).toBe(true);
        requestedPaths.push([...path]);
        expect(digestByPath.get(JSON.stringify(path))).toBe(digest);
        const pathDigest = digestByPath.get(JSON.stringify(path))!;
        const stored = snapshot.objects.get(pathDigest)!;
        if (stored.objectKind === 'inventory-leaf') discoveredLeaves += 1;
        return loadedInventoryObject(stored);
      }, {
        maxRequests: 1,
        maxWireBytes: 2 * 1024 * 1024,
        deadlineMs: Date.now() + 3_000,
      });
      slices += 1;
      totalWireBytes += result.wireBytes;
      discoveredRows.push(...result.sliceRows);
      expect(Object.isFrozen(result.sliceRows)).toBe(true);
      expect(result.progress.totalValidatedRows).toBe(discoveredRows.length);
      expect(result.progress.totalValidatedLeaves).toBe(discoveredLeaves);
      if (result.progress.totalValidatedRows > result.sliceRows.length) {
        sawCumulativeProgressBeyondSlice = true;
      }
      expect(result.requests).toBeLessThanOrEqual(1);
      expect(result.wireBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
      if (result.status === 'complete') break;
    }
    expect(slices).toBeGreaterThan(1);
    expect(sawCumulativeProgressBeyondSlice).toBe(true);
    expect(totalWireBytes).toBe([...snapshot.objects.values()].reduce(
      (sum, stored) => sum + loadedInventoryObject(stored).wireBytes,
      0,
    ));
    expect(requestedPaths[0]).toEqual([]);
    expect(new Set(requestedPaths.map((path) => JSON.stringify(path))).size)
      .toBe(snapshot.objects.size);
    expect(discoveredRows).toHaveLength(513);
    expect(new Set(discoveredRows.map(({ stableKeyHash }) => stableKeyHash)).size).toBe(513);

    const rejected = createSystemRecordInventoryRowTraversalV1(snapshot.descriptor);
    await expect(rejected.advance(async () => ({
      outcome: 'rejected', wireBytes: 8_196, rejection: 'busy',
    }), {
      maxRequests: 1,
      maxWireBytes: 2 * 1024 * 1024,
      deadlineMs: Date.now() + 3_000,
    })).resolves.toEqual({
      status: 'rejected', requests: 1, wireBytes: 8_196,
      progress: { totalValidatedRows: 0, totalValidatedLeaves: 0 },
      sliceRows: [], rejection: 'busy',
    });

    const zeroByteReset = createSystemRecordInventoryRowTraversalV1(snapshot.descriptor);
    await expect(zeroByteReset.advance(async () => ({
      outcome: 'rejected', wireBytes: 0, rejection: 'transport',
    }), {
      maxRequests: 1,
      maxWireBytes: 2 * 1024 * 1024,
      deadlineMs: Date.now() + 3_000,
    })).resolves.toEqual({
      status: 'rejected', requests: 1, wireBytes: 0,
      progress: { totalValidatedRows: 0, totalValidatedLeaves: 0 },
      sliceRows: [], rejection: 'transport',
    });

    const zeroByteFramedRejection = createSystemRecordInventoryRowTraversalV1(
      snapshot.descriptor,
    );
    await expect(zeroByteFramedRejection.advance(async () => ({
      outcome: 'rejected', wireBytes: 0, rejection: 'busy',
    }), {
      maxRequests: 1,
      maxWireBytes: 2 * 1024 * 1024,
      deadlineMs: Date.now() + 3_000,
    })).resolves.toMatchObject({
      status: 'failed', requests: 1, wireBytes: 0,
      progress: { totalValidatedRows: 0, totalValidatedLeaves: 0 },
      sliceRows: [],
      failure: {
        reason: 'invalid-response',
        message: expect.stringMatching(/wire accounting/),
      },
    });

    const aborted = createSystemRecordInventoryRowTraversalV1(snapshot.descriptor);
    const controller = new AbortController();
    const requested = Promise.withResolvers<void>();
    const delivery = Promise.withResolvers<ReturnType<typeof loadedInventoryObject>>();
    const rootLoaded = loadedInventoryObject(
      snapshot.objects.get(snapshot.descriptor.treeRootDigest)!,
    );
    const abortedAdvance = aborted.advance(() => {
      requested.resolve();
      return delivery.promise;
    }, {
      signal: controller.signal,
      maxRequests: 1,
      maxWireBytes: 2 * 1024 * 1024,
      deadlineMs: Date.now() + 3_000,
    });
    await requested.promise;
    delivery.resolve(rootLoaded);
    // Settle the response through the loader boundary before cancellation is observed.
    await Promise.resolve();
    await Promise.resolve();
    controller.abort(new Error('aborted-after-load'));
    await expect(abortedAdvance).resolves.toMatchObject({
      status: 'failed',
      requests: 1,
      wireBytes: rootLoaded.wireBytes,
      failure: {
        reason: 'aborted',
        message: expect.stringMatching(/aborted-after-load/),
      },
    });

    const interrupted = createSystemRecordInventoryRowTraversalV1(snapshot.descriptor);
    await expect(interrupted.advance(async (digest) => (
      loadedInventoryObject(snapshot.objects.get(digest)!)
    ), {
      maxRequests: 1,
      maxWireBytes: 2 * 1024 * 1024,
      deadlineMs: Date.now() + 3_000,
    })).resolves.toMatchObject({ status: 'paused', requests: 1, sliceRows: [] });
    const interruptedController = new AbortController();
    let childRequests = 0;
    const interruptedResult = await interrupted.advance(async (digest) => {
      childRequests += 1;
      if (childRequests === 2) {
        interruptedController.abort(new Error('abort-after-validated-leaf'));
        return new Promise<never>(() => undefined);
      }
      return loadedInventoryObject(snapshot.objects.get(digest)!);
    }, {
      signal: interruptedController.signal,
      maxRequests: 2,
      maxWireBytes: 2 * 1024 * 1024,
      deadlineMs: Date.now() + 3_000,
    });
    expect(interruptedResult).toMatchObject({
      status: 'failed',
      requests: 2,
      failure: {
        reason: 'aborted',
        message: expect.stringMatching(/abort-after-validated-leaf/),
      },
    });
    expect(interruptedResult.sliceRows.length).toBeGreaterThan(0);
    expect(interruptedResult.sliceRows)
      .toHaveLength(interruptedResult.progress.totalValidatedRows);
    const resumedRows = [...interruptedResult.sliceRows];
    while (true) {
      const resumed = await interrupted.advance(async (digest) => (
        loadedInventoryObject(snapshot.objects.get(digest)!)
      ), {
        maxRequests: 1,
        maxWireBytes: 2 * 1024 * 1024,
        deadlineMs: Date.now() + 3_000,
      });
      resumedRows.push(...resumed.sliceRows);
      if (resumed.status === 'complete') break;
    }
    expect(resumedRows).toHaveLength(513);
    expect(new Set(resumedRows.map(({ stableKeyHash }) => stableKeyHash)).size).toBe(513);

    const malformed = createSystemRecordInventoryRowTraversalV1(snapshot.descriptor);
    await expect(malformed.advance(async () => ({
      ...rootLoaded,
      canonicalBytes: Uint8Array.from([0, ...rootLoaded.canonicalBytes.subarray(1)]),
    }), {
      maxRequests: 1,
      maxWireBytes: 2 * 1024 * 1024,
      deadlineMs: Date.now() + 3_000,
    })).resolves.toMatchObject({
      status: 'failed',
      requests: 1,
      wireBytes: rootLoaded.wireBytes,
      failure: { reason: 'invalid-response' },
    });

    const transportSentinel = new Error('row traversal socket closed');
    const thrownTransport = createSystemRecordInventoryRowTraversalV1(snapshot.descriptor);
    const transportResult = await thrownTransport.advance(async () => {
      throw transportSentinel;
    }, {
      maxRequests: 1,
      maxWireBytes: 2 * 1024 * 1024,
      deadlineMs: Date.now() + 3_000,
    });
    expect(transportResult).toMatchObject({
      status: 'failed',
      requests: 1,
      wireBytes: 0,
      sliceRows: [],
      failure: { reason: 'transport' },
    });
    if (transportResult.status !== 'failed') throw new Error('expected failed row traversal');
    expect(transportResult.failure.cause).toBe(transportSentinel);
  });

  it('pins slice admission while an awaited loader mutates its source object', async () => {
    const snapshot = buildSystemRecordInventoryTreeV1(NETWORK, deterministicPeers(513).map(row));
    const requestBoundTraversal = createSystemRecordInventoryRowTraversalV1(snapshot.descriptor);
    const requestBoundSlice = {
      maxRequests: 1,
      maxWireBytes: 2 * 1024 * 1024,
      deadlineMs: Date.now() + 3_000,
    };
    const requestBound = await requestBoundTraversal.advance(async (digest) => {
      requestBoundSlice.maxRequests = 12;
      const stored = snapshot.objects.get(digest)!;
      return loadedInventoryObject(stored);
    }, requestBoundSlice);
    expect(requestBound).toMatchObject({ status: 'paused', requests: 1 });

    const deadlineTraversal = createSystemRecordInventoryRowTraversalV1(snapshot.descriptor);
    let nowMs = 0;
    const deadlineSlice = {
      maxRequests: 1,
      maxWireBytes: 2 * 1024 * 1024,
      deadlineMs: 1,
      nowMs: () => nowMs,
    };
    await expect(deadlineTraversal.advance(async (digest) => {
      nowMs = 2;
      deadlineSlice.deadlineMs = 3;
      const stored = snapshot.objects.get(digest)!;
      return loadedInventoryObject(stored);
    }, deadlineSlice)).resolves.toMatchObject({
      status: 'failed',
      failure: { reason: 'deadline', message: expect.stringMatching(/deadline expired/) },
    });

    const abortTraversal = createSystemRecordInventoryRowTraversalV1(snapshot.descriptor);
    const admitted = new AbortController();
    const replacement = new AbortController();
    const abortSlice = {
      signal: admitted.signal,
      maxRequests: 1,
      maxWireBytes: 2 * 1024 * 1024,
      deadlineMs: Date.now() + 3_000,
    };
    await expect(abortTraversal.advance(async (digest) => {
      admitted.abort(new Error('admitted-signal-aborted'));
      abortSlice.signal = replacement.signal;
      const stored = snapshot.objects.get(digest)!;
      return loadedInventoryObject(stored);
    }, abortSlice)).resolves.toMatchObject({
      status: 'failed',
      failure: { reason: 'aborted', message: expect.stringMatching(/admitted-signal-aborted/) },
    });
  });

  it('preserves the validation-only traversal rejection and result contract', async () => {
    const snapshot = buildSystemRecordInventoryTreeV1(NETWORK, [row(PEER_A)]);
    const root = snapshot.objects.get(snapshot.descriptor.treeRootDigest)!;
    const expectedKinds: Array<'inventory-internal' | 'inventory-leaf' | undefined> = [];
    const traversal = createSystemRecordInventoryTraversalV1(snapshot.descriptor);
    const completed = await traversal.advance(async (_digest, expectedKind) => {
      expectedKinds.push(expectedKind);
      return loadedInventoryObject(root);
    }, {
      maxRequests: 1,
      maxWireBytes: 2 * 1024 * 1024,
      deadlineMs: Date.now() + 3_000,
    });
    expect(completed.status).toBe('complete');
    expect(expectedKinds).toEqual([undefined]);
    expect(completed).not.toHaveProperty('rows');
    expect(completed).not.toHaveProperty('progress');
    expect(completed).not.toHaveProperty('sliceRows');
    expect(completed).not.toHaveProperty('failure');

    const malformed = createSystemRecordInventoryTraversalV1(snapshot.descriptor);
    await expect(malformed.advance(async () => ({
      ...loadedInventoryObject(root),
      canonicalBytes: Uint8Array.from([0, ...root.canonicalBytes.subarray(1)]),
    }), {
      maxRequests: 1,
      maxWireBytes: 2 * 1024 * 1024,
      deadlineMs: Date.now() + 3_000,
    })).rejects.toThrow();

    const sentinel = new Error('validation loader database closed');
    const loaderFailure = createSystemRecordInventoryTraversalV1(snapshot.descriptor);
    await expect(loaderFailure.advance(async () => {
      throw sentinel;
    }, {
      maxRequests: 1,
      maxWireBytes: 2 * 1024 * 1024,
      deadlineMs: Date.now() + 3_000,
    })).rejects.toBe(sentinel);

    const ambiguous = createSystemRecordInventoryTraversalV1(Object.freeze({
      ...snapshot.descriptor,
      totalRows: '256',
    }));
    await expect(ambiguous.advance(async (_digest, expectedKind) => {
      expect(expectedKind).toBeUndefined();
      return Object.freeze({
        outcome: 'rejected' as const,
        wireBytes: 6,
        rejection: 'not-found' as const,
      });
    }, {
      maxRequests: 1,
      maxWireBytes: 2 * 1024 * 1024,
      deadlineMs: Date.now() + 3_000,
    })).resolves.toMatchObject({
      status: 'rejected',
      requests: 1,
      wireBytes: 6,
      rejection: 'not-found',
    });

    const abortReason = new Error('public traversal caller aborted');
    const abortController = new AbortController();
    abortController.abort(abortReason);
    const aborted = createSystemRecordInventoryTraversalV1(snapshot.descriptor);
    await expect(aborted.advance(async () => {
      throw new Error('pre-aborted traversal must not load');
    }, {
      signal: abortController.signal,
      maxRequests: 1,
      maxWireBytes: 2 * 1024 * 1024,
      deadlineMs: Date.now() + 3_000,
    })).rejects.toBe(abortReason);
  });

  it('latches traversal admission before invoking a reentrant clock', async () => {
    const snapshot = buildSystemRecordInventoryTreeV1(NETWORK, [row(PEER_A)]);
    const traversal = createSystemRecordInventoryRowTraversalV1(snapshot.descriptor);
    let nested: Promise<unknown> | undefined;
    let nestedLoads = 0;
    let reentered = false;
    const outer = traversal.advance(async (digest) => (
      loadedInventoryObject(snapshot.objects.get(digest)!)
    ), {
      maxRequests: 1,
      maxWireBytes: 2 * 1024 * 1024,
      deadlineMs: SYSTEM_RECORD_SLICE_TIMEOUT_MS,
      nowMs: () => {
        if (!reentered) {
          reentered = true;
          nested = traversal.advance(async () => {
            nestedLoads += 1;
            throw new Error('nested loader must not run');
          }, {
            maxRequests: 1,
            maxWireBytes: 2 * 1024 * 1024,
            deadlineMs: SYSTEM_RECORD_SLICE_TIMEOUT_MS,
            nowMs: () => 0,
          });
        }
        return 0;
      },
    });
    await expect(nested).rejects.toThrow(/already has an active slice/);
    expect(nestedLoads).toBe(0);
    await expect(outer).resolves.toMatchObject({ status: 'complete', requests: 1 });
  });

  it('enforces the three-second admitted slice ceiling', async () => {
    const snapshot = buildSystemRecordInventoryTreeV1(NETWORK, [row(PEER_A)]);
    const overlong = createSystemRecordInventoryRowTraversalV1(snapshot.descriptor);
    let loads = 0;
    await expect(overlong.advance(async (digest) => {
      loads += 1;
      return loadedInventoryObject(snapshot.objects.get(digest)!);
    }, {
      maxRequests: 1,
      maxWireBytes: 2 * 1024 * 1024,
      deadlineMs: SYSTEM_RECORD_SLICE_TIMEOUT_MS + 1,
      nowMs: () => 0,
    })).resolves.toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-slice', message: expect.stringMatching(/slice budget/) },
    });
    expect(loads).toBe(0);

    const boundary = createSystemRecordInventoryRowTraversalV1(snapshot.descriptor);
    await expect(boundary.advance(async (digest) => (
      loadedInventoryObject(snapshot.objects.get(digest)!)
    ), {
      maxRequests: 1,
      maxWireBytes: 2 * 1024 * 1024,
      deadlineMs: SYSTEM_RECORD_SLICE_TIMEOUT_MS,
      nowMs: () => 0,
    })).resolves.toMatchObject({ status: 'complete', requests: 1 });
  });

  it('times out a stalled loader and permits a later retry on the same traversal', async () => {
    const leaf = leafFor([row(PEER_A)]);
    const digest = computeSystemRecordInventoryLeafDigestV1(leaf, NETWORK, true);
    const descriptor = {
      objectType: 'root-descriptor', kind: 'agents', networkId: NETWORK,
      epoch: '0', version: '0', treeRootDigest: digest, totalRows: '1',
    } as const;
    const traversal = createSystemRecordInventoryRowTraversalV1(descriptor);
    await expect(traversal.advance(
      async () => new Promise(() => undefined),
      {
        maxRequests: 1,
        maxWireBytes: 2 * 1024 * 1024,
        deadlineMs: Date.now() + 20,
      },
    )).resolves.toMatchObject({
      status: 'failed',
      failure: { reason: 'deadline', message: expect.stringMatching(/deadline expired/) },
    });

    const recovered = await traversal.advance(
      async () => loadedInventoryObject({
        objectKind: 'inventory-leaf',
        object: leaf,
        canonicalBytes: canonicalizeSystemRecordInventoryLeafObjectV1(leaf, NETWORK, true),
      }),
      {
        maxRequests: 1,
        maxWireBytes: 2 * 1024 * 1024,
        deadlineMs: Date.now() + 1_000,
      },
    );
    expect(recovered.status).toBe('complete');
  });

  it('does not dispatch loader work when the admitted signal aborts before its microtask', async () => {
    const leaf = leafFor([row(PEER_A)]);
    const digest = computeSystemRecordInventoryLeafDigestV1(leaf, NETWORK, true);
    const traversal = createSystemRecordInventoryRowTraversalV1({
      objectType: 'root-descriptor', kind: 'agents', networkId: NETWORK,
      epoch: '0', version: '0', treeRootDigest: digest, totalRows: '1',
    });
    const controller = new AbortController();
    let clockReads = 0;
    let loaderCalls = 0;
    await expect(traversal.advance(async () => {
      loaderCalls += 1;
      return undefined;
    }, {
      signal: controller.signal,
      maxRequests: 1,
      maxWireBytes: 2 * 1024 * 1024,
      deadlineMs: 1_000,
      nowMs: () => {
        clockReads += 1;
        if (clockReads === 3) controller.abort(new Error('test abort'));
        return 0;
      },
    })).resolves.toMatchObject({
      status: 'failed',
      failure: { reason: 'aborted', message: expect.stringMatching(/test abort/) },
    });
    expect(loaderCalls).toBe(0);
  });

  it('exact-snapshots loader unions and does not retain caller-mutable completion sets', async () => {
    class MisleadingSliceBytes extends Uint8Array {
      override slice(): Uint8Array { return new Uint8Array(); }
    }
    const snapshot = buildSystemRecordInventoryTreeV1(NETWORK, [row(PEER_A)]);
    const slice = {
      maxRequests: 1,
      maxWireBytes: 2 * 1024 * 1024,
      deadlineMs: SYSTEM_RECORD_SLICE_TIMEOUT_MS,
      nowMs: () => 0,
    };
    const invalidOutcome = createSystemRecordInventoryRowTraversalV1(snapshot.descriptor);
    await expect(invalidOutcome.advance(async () => ({
      outcome: 'unexpected', wireBytes: 128,
    } as never), slice)).resolves.toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-response', message: expect.stringMatching(/invalid outcome/) },
    });

    const extraField = createSystemRecordInventoryRowTraversalV1(snapshot.descriptor);
    await expect(extraField.advance(async (digest) => ({
      ...loadedInventoryObject(snapshot.objects.get(digest)!),
      unexpected: true,
    }), slice)).resolves.toMatchObject({
      status: 'failed',
      failure: {
        reason: 'invalid-response',
        message: expect.stringMatching(/unknown or missing fields/),
      },
    });

    const accessor = createSystemRecordInventoryRowTraversalV1(snapshot.descriptor);
    await expect(accessor.advance(async (digest) => {
      const loaded = loadedInventoryObject(snapshot.objects.get(digest)!);
      return Object.defineProperty({ ...loaded }, 'canonicalBytes', {
        enumerable: true,
        get: () => loaded.canonicalBytes,
      });
    }, slice)).resolves.toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-response', message: expect.stringMatching(/data properties/) },
    });

    const undercounted = createSystemRecordInventoryRowTraversalV1(snapshot.descriptor);
    await expect(undercounted.advance(async (digest) => {
      const stored = snapshot.objects.get(digest)!;
      return {
        outcome: 'ok' as const,
        objectKind: stored.objectKind,
        canonicalBytes: stored.canonicalBytes,
        wireBytes: 4 + stored.canonicalBytes.byteLength,
      };
    }, slice)).resolves.toMatchObject({
      status: 'failed',
      failure: { reason: 'invalid-response', message: expect.stringMatching(/over-cap object/) },
    });

    const subclassBytes = createSystemRecordInventoryRowTraversalV1(snapshot.descriptor);
    await expect(subclassBytes.advance(async (digest) => {
      const loaded = loadedInventoryObject(snapshot.objects.get(digest)!);
      return {
        ...loaded,
        canonicalBytes: new MisleadingSliceBytes(loaded.canonicalBytes),
      };
    }, slice)).resolves.toMatchObject({ status: 'complete', requests: 1 });

    const completed = createSystemRecordInventoryRowTraversalV1(snapshot.descriptor);
    const first = await completed.advance(async (digest) => (
      loadedInventoryObject(snapshot.objects.get(digest)!)
    ), slice);
    expect(first.status).toBe('complete');
    expect(first.sliceRows).toEqual([row(PEER_A)]);
    (first.result!.objectDigests as Set<string>).clear();
    const repeated = await completed.advance(async () => {
      throw new Error('completed traversal must not load again');
    }, slice);
    expect(repeated.result?.objectDigests.size).toBe(1);
  });

  it('accepts the actual ambiguous root kind from a digest-addressed loader', async () => {
    const sorted = deterministicPeers(256).map(row)
      .sort((left, right) => left.stableKeyHash.localeCompare(right.stableKeyHash));
    const snapshot = twoLeafSnapshot(sorted.slice(0, 128), sorted.slice(128));
    const traversal = createSystemRecordInventoryRowTraversalV1(snapshot.descriptor);
    const requestedKinds: string[] = [];
    let result: Awaited<ReturnType<typeof traversal.advance>>;
    do {
      result = await traversal.advance(async (digest, expectedKind) => {
        requestedKinds.push(expectedKind);
        return loadedInventoryObject(snapshot.objects.get(digest)!);
      }, {
        maxRequests: 1,
        maxWireBytes: 2 * 1024 * 1024,
        deadlineMs: Date.now() + 3_000,
      });
    } while (result.status === 'paused');

    expect(result).toMatchObject({
      status: 'complete',
      progress: { totalValidatedRows: 256 },
    });
    expect(requestedKinds).toEqual([
      'inventory-leaf',
      'inventory-leaf',
      'inventory-leaf',
    ]);

    const missingProbe = createSystemRecordInventoryRowTraversalV1(snapshot.descriptor);
    const probedKinds: string[] = [];
    const firstProbe = await missingProbe.advance(async (digest, expectedKind) => {
      probedKinds.push(expectedKind);
      if (digest === snapshot.descriptor.treeRootDigest && expectedKind === 'inventory-leaf') {
        return undefined;
      }
      return loadedInventoryObject(snapshot.objects.get(digest)!);
    }, {
      maxRequests: 1,
      maxWireBytes: 2 * 1024 * 1024,
      deadlineMs: Date.now() + 3_000,
    });
    expect(firstProbe).toMatchObject({ status: 'paused', requests: 1, wireBytes: 0 });
    let probedResult: Awaited<ReturnType<typeof missingProbe.advance>> = firstProbe;
    do {
      probedResult = await missingProbe.advance(async (digest, expectedKind) => {
        probedKinds.push(expectedKind);
        return loadedInventoryObject(snapshot.objects.get(digest)!);
      }, {
        maxRequests: 1,
        maxWireBytes: 2 * 1024 * 1024,
        deadlineMs: Date.now() + 3_000,
      });
    } while (probedResult.status === 'paused');
    expect(probedResult).toMatchObject({
      status: 'complete',
      progress: { totalValidatedRows: 256 },
    });
    expect(probedKinds).toEqual([
      'inventory-leaf',
      'inventory-internal',
      'inventory-leaf',
      'inventory-leaf',
    ]);
  });

  it('rejects mixed child kinds before traversal', () => {
    expect(() => canonicalizeSystemRecordInventoryInternalObjectV1({
      objectType: 'inventory-internal',
      firstKeyHash: `0x${'01'.repeat(32)}`,
      lastKeyHash: `0x${'02'.repeat(32)}`,
      entries: [
        { separatorKeyHash: `0x${'01'.repeat(32)}`, childDigest: HEAD, childKind: 'inventory-leaf' },
        { separatorKeyHash: `0x${'02'.repeat(32)}`, childDigest: EVIDENCE, childKind: 'inventory-internal' },
      ],
    }, true)).toThrow(/mix/);
  });

  it('rejects caller-owned behavior on persisted inventory arrays', () => {
    const encoded = encodeInventoryRowBase64UrlV1(NETWORK, row(PEER_A));
    const rows = Object.assign([encoded], { map: () => [] });
    expect(() => canonicalizeSystemRecordInventoryLeafObjectV1({
      objectType: 'inventory-leaf',
      firstKeyHash: computeSystemRecordStableKeyHashV1(NETWORK, PEER_A),
      lastKeyHash: computeSystemRecordStableKeyHashV1(NETWORK, PEER_A),
      rows,
    }, NETWORK, true)).toThrow(/closed|non-index/);

    const entries = [{}, {}];
    Object.defineProperty(entries, Symbol.iterator, { value: function* () { yield {}; } });
    expect(() => canonicalizeSystemRecordInventoryInternalObjectV1({
      objectType: 'inventory-internal',
      firstKeyHash: HEAD,
      lastKeyHash: EVIDENCE,
      entries,
    } as unknown as SystemRecordInventoryInternalObjectV1, true)).toThrow(/dense closed array/);

    const builderRows = [row(PEER_A)];
    Object.defineProperty(builderRows, Symbol.iterator, {
      value: function* () { yield row(PEER_A); yield row(PEER_B); },
    });
    expect(() => buildSystemRecordInventoryTreeV1(NETWORK, builderRows)).toThrow(/dense closed array/);
  });

  it('uses deterministic split/rebalance choices and enforces the COW budget', () => {
    expect(chooseSystemRecordByteAwareSplitIndexV1([10, 10, 80, 10, 10], 2, 2)).toBe(2);
    expect(chooseSystemRecordRebalanceV1(129, 200, 128)).toBe('borrow-left');
    expect(chooseSystemRecordRebalanceV1(128, 129, 128)).toBe('borrow-right');
    expect(chooseSystemRecordRebalanceV1(128, 128, 128)).toBe('merge-left');
    expect(() => assertSystemRecordInventoryCowUpdateBoundV1({
      leafObjects: 2, internalObjects: 2, rootObjects: 1, descriptorObjects: 1,
      encodedBytes: 1024 * 1024,
    })).not.toThrow();
    expect(() => assertSystemRecordInventoryCowUpdateBoundV1({
      leafObjects: 3, internalObjects: 2, rootObjects: 1, descriptorObjects: 1,
      encodedBytes: 1024 * 1024,
    })).toThrow(/six-object/);

    class MisleadingLengths extends Array<number> {
      override some(): boolean { return true; }
      override reduce(): number { return Number.MAX_VALUE; }
      override slice(): this { return new MisleadingLengths() as this; }
    }
    expect(chooseSystemRecordByteAwareSplitIndexV1(
      new MisleadingLengths(10, 10, 80, 10, 10),
      2,
      2,
    )).toBe(2);
    const accounting = {
      leafObjects: 2, internalObjects: 2, rootObjects: 1, descriptorObjects: 1,
      encodedBytes: 1024 * 1024,
    };
    const hostileAccounting = new Proxy(accounting, {
      get: () => Number.MAX_SAFE_INTEGER,
    });
    expect(() => assertSystemRecordInventoryCowUpdateBoundV1(hostileAccounting)).not.toThrow();
  });

  it('performs localized immutable upsert/update/delete publications', async () => {
    const peers = deterministicPeers(520);
    let snapshot = buildSystemRecordInventoryTreeV1(NETWORK, peers.slice(0, 519).map(row));
    const firstRoot = snapshot.descriptor.treeRootDigest;
    const insert = updateSystemRecordInventoryTreeV1(snapshot, { operation: 'upsert', row: row(peers[519]) });
    expect(insert.changed).toBe(true);
    expect(insert.accounting.descriptorObjects).toBe(1);
    expect(insert.accounting.leafObjects).toBeLessThanOrEqual(2);
    expect(insert.accounting.encodedBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(insert.descriptor.treeRootDigest).not.toBe(firstRoot);
    expect(insert.loadedObjectDigests.size).toBeLessThanOrEqual(4);
    snapshot = applyUpdate(snapshot, insert);

    const changedRow = { ...row(peers[519]), version: '1' as const, headDigest: EVIDENCE };
    const update = updateSystemRecordInventoryTreeV1(snapshot, { operation: 'upsert', row: changedRow });
    expect(update.changed).toBe(true);
    expect(update.writes.length + 1).toBeLessThanOrEqual(6);
    snapshot = applyUpdate(snapshot, update);

    const deletion = updateSystemRecordInventoryTreeV1(snapshot, {
      operation: 'delete', stableKeyHash: changedRow.stableKeyHash, peerId: changedRow.peerId,
    });
    expect(deletion.changed).toBe(true);
    expect(deletion.writes.length + 1).toBeLessThanOrEqual(6);
    const deletionSnapshot = applyUpdate(snapshot, deletion);
    const validated = await validateTree(
      deletion.descriptor,
      async (digest) => deletionSnapshot.objects.get(digest)?.object,
    );
    expect(validated.totalRows).toBe(519);
  });

  it('pins the COW snapshot shell and ignores overridden map methods', () => {
    const peers = deterministicPeers(3);
    const source = buildSystemRecordInventoryTreeV1(NETWORK, peers.slice(0, 2).map(row));
    class MisleadingObjectMap extends Map<
      `0x${string}`,
      SystemRecordInventoryStoredObjectV1
    > {
      override has(): boolean { return true; }
      override get(): SystemRecordInventoryStoredObjectV1 | undefined { return undefined; }
    }
    const hostileMap = new MisleadingObjectMap(source.objects);
    const hostileSnapshot = new Proxy({ ...source, objects: hostileMap }, {
      get() { throw new Error('COW updater must not invoke snapshot getters'); },
    });
    const update = updateSystemRecordInventoryTreeV1(hostileSnapshot, {
      operation: 'upsert', row: row(peers[2]),
    });
    expect(update.changed).toBe(true);
    expect(update.writes.length).toBeGreaterThan(0);
  });

  it('rejects a corrupt untouched sibling before publishing a reused root range', () => {
    const peers = deterministicPeers(520);
    const source = buildSystemRecordInventoryTreeV1(NETWORK, peers.map(row));
    const objects = new Map(source.objects);
    const rootObject = objects.get(source.descriptor.treeRootDigest)?.object;
    if (rootObject?.objectType !== 'inventory-internal') throw new Error('expected a multi-leaf root');
    const siblingDigest = rootObject.entries.at(-1)!.childDigest;
    const sibling = objects.get(siblingDigest);
    if (sibling?.object.objectType !== 'inventory-leaf') throw new Error('expected a leaf sibling');
    objects.set(siblingDigest, Object.freeze({
      ...sibling,
      object: Object.freeze({
        ...sibling.object,
        lastKeyHash: `0x${'ff'.repeat(32)}`,
      }),
    }));
    const target = peers.map(row).sort((left, right) =>
      left.stableKeyHash.localeCompare(right.stableKeyHash))[0];
    expect(() => updateSystemRecordInventoryTreeV1({ ...source, objects }, {
      operation: 'upsert',
      row: { ...target, version: '1', headDigest: EVIDENCE },
    })).toThrow(/key range|digest/);

    const mismatchedBytes = new Map(source.objects);
    const validSibling = mismatchedBytes.get(siblingDigest)!;
    mismatchedBytes.set(siblingDigest, Object.freeze({
      ...validSibling,
      canonicalBytes: Uint8Array.of(0),
    }));
    expect(() => updateSystemRecordInventoryTreeV1({ ...source, objects: mismatchedBytes }, {
      operation: 'upsert',
      row: { ...target, version: '1', headDigest: EVIDENCE },
    })).toThrow(/canonical bytes/);
  });

  it('keeps unchanged mutations path-bounded without enumerating the snapshot', () => {
    const peers = deterministicPeers(513);
    const snapshot = buildSystemRecordInventoryTreeV1(NETWORK, peers.map(row));
    const update = updateSystemRecordInventoryTreeV1(snapshot, {
      operation: 'upsert',
      row: row(peers[256]),
    });

    expect(update.changed).toBe(false);
    expect(update.writes).toHaveLength(0);
    expect(update.reusedObjectDigests.size).toBe(0);
    expect(update.loadedObjectDigests.size).toBeLessThanOrEqual(3);
  });

  it('keeps split, borrow, and merge publications within the physical write bound', async () => {
    const peers = deterministicPeers(513);
    let snapshot = buildSystemRecordInventoryTreeV1(NETWORK, peers.slice(0, 512).map(row));
    const split = updateSystemRecordInventoryTreeV1(snapshot, { operation: 'upsert', row: row(peers[512]) });
    expect(split.accounting).toMatchObject({ leafObjects: 2, rootObjects: 1, descriptorObjects: 1 });
    const sorted = peers.slice(0, 257).map(row).sort((a, b) => a.stableKeyHash.localeCompare(b.stableKeyHash));
    const borrowSnapshot = twoLeafSnapshot(sorted.slice(0, 128), sorted.slice(128));
    const borrowed = updateSystemRecordInventoryTreeV1(borrowSnapshot, {
      operation: 'delete', stableKeyHash: sorted[0].stableKeyHash, peerId: sorted[0].peerId,
    });
    expect(leafRows(applyUpdate(borrowSnapshot, borrowed)).map((group) => group.length)).toEqual([128, 128]);
    expect(borrowed.writes.length + 1).toBeLessThanOrEqual(6);

    const mergeSnapshot = twoLeafSnapshot(sorted.slice(0, 128), sorted.slice(128, 256));
    const finalUpdate = updateSystemRecordInventoryTreeV1(mergeSnapshot, {
      operation: 'delete', stableKeyHash: sorted[0].stableKeyHash, peerId: sorted[0].peerId,
    });
    snapshot = applyUpdate(mergeSnapshot, finalUpdate);
    expect(finalUpdate.writes.length + 1).toBeLessThanOrEqual(6);
    expect(snapshot.objects.get(snapshot.descriptor.treeRootDigest)?.objectKind).toBe('inventory-leaf');
    const validated = await validateTree(
      snapshot.descriptor,
      async (digest) => snapshot.objects.get(digest)?.object,
    );
    expect(validated).toMatchObject({ leaves: 1, height: 1, totalRows: 255 });
  });

  it('borrows from the right before merging left when both siblings exist', () => {
    const sorted = deterministicPeers(385).map(row)
      .sort((left, right) => left.stableKeyHash.localeCompare(right.stableKeyHash));
    const snapshot = multiLeafSnapshot([sorted.slice(0, 128), sorted.slice(128, 256), sorted.slice(256)]);
    const target = sorted[128];
    const update = updateSystemRecordInventoryTreeV1(snapshot, {
      operation: 'delete', stableKeyHash: target.stableKeyHash, peerId: target.peerId,
    });
    const next = applyUpdate(snapshot, update);
    expect(leafRows(next).map((group) => group.length)).toEqual([128, 128, 128]);
  });

  it('keeps ascending, descending, deterministic-random, and repeated mutations path-local', async () => {
    const all = deterministicPeers(580).map(row)
      .sort((left, right) => left.stableKeyHash.localeCompare(right.stableKeyHash));
    let snapshot = buildSystemRecordInventoryTreeV1(NETWORK, all.slice(0, 520));
    const mutations = [
      ...all.slice(520, 530).map((candidate) => ({ operation: 'upsert' as const, row: candidate })),
      ...all.slice(0, 10).reverse().map((candidate, index) => ({
        operation: 'upsert' as const,
        row: { ...candidate, version: '1' as const, headDigest: index % 2 === 0 ? EVIDENCE : HEAD },
      })),
      ...all.slice(40, 50).sort((left, right) => left.peerId.localeCompare(right.peerId)).map((candidate) => ({
        operation: 'delete' as const, stableKeyHash: candidate.stableKeyHash, peerId: candidate.peerId,
      })),
    ];
    for (const mutation of mutations) {
      const update = updateSystemRecordInventoryTreeV1(snapshot, mutation);
      expect(update.writes.length + (update.changed ? 1 : 0)).toBeLessThanOrEqual(6);
      expect(update.accounting.encodedBytes).toBeLessThanOrEqual(1024 * 1024);
      if (update.changed && snapshot.objects.size > 2) expect(update.reusedObjectDigests.size).toBeGreaterThan(0);
      snapshot = applyUpdate(snapshot, update);
      await validateSnapshotTree(snapshot);
    }
  }, 30_000);

  it('refuses an insertion above the signed inventory record cap', () => {
    const peers = deterministicPeers(521);
    const initial = buildSystemRecordInventoryTreeV1(NETWORK, peers.slice(0, 520).map(row));
    const descriptor = {
      ...initial.descriptor,
      totalRows: SYSTEM_RECORD_MAX_INVENTORY_RECORDS.toString() as typeof initial.descriptor.totalRows,
    };
    const saturated = {
      ...initial,
      descriptor,
      descriptorDigest: computeSystemRecordRootDescriptorDigestV1(descriptor),
    };
    expect(() => updateSystemRecordInventoryTreeV1(saturated, {
      operation: 'upsert', row: row(peers[520]),
    })).toThrow(/row cap/);
  }, 30_000);

  it.runIf(process.env.DKG_SYSTEM_RECORD_EXHAUSTIVE === '1')(
    'handles complete height-three right-borrow then non-collapsing merge publications', async () => {
    const borrowSnapshot = heightThreeSnapshot([128, 128, 128], { internalIndex: 1, leafIndex: 1 });
    expect(await validateSnapshotTree(borrowSnapshot)).toMatchObject({
      leaves: 384, height: 3, totalRows: 49_153,
    });
    const initialRoot = borrowSnapshot.objects.get(
      borrowSnapshot.descriptor.treeRootDigest,
    )!.object as SystemRecordInventoryInternalObjectV1;
    const borrowTarget = firstRowOfInternalLeaf(borrowSnapshot, 1, 0);
    const borrowed = updateSystemRecordInventoryTreeV1(borrowSnapshot, {
      operation: 'delete', stableKeyHash: borrowTarget.stableKeyHash, peerId: borrowTarget.peerId,
    });
    expect(borrowed.accounting).toMatchObject({
      leafObjects: 2, internalObjects: 1, rootObjects: 1, descriptorObjects: 1,
    });
    expect(borrowed.writes.length + 1).toBeLessThanOrEqual(6);
    const borrowedSnapshot = applyUpdate(borrowSnapshot, borrowed);
    expect(rootInternalChildCounts(borrowedSnapshot)).toEqual([128, 128, 128]);
    expect(borrowed.reusedObjectDigests.has(initialRoot.entries[0].childDigest)).toBe(true);
    expect(borrowed.descriptor.totalRows).toBe('49152');
    const borrowedRoot = borrowedSnapshot.objects.get(
      borrowedSnapshot.descriptor.treeRootDigest,
    )!.object as SystemRecordInventoryInternalObjectV1;
    const mergeTarget = firstRowOfInternalLeaf(borrowedSnapshot, 1, 0);
    const merged = updateSystemRecordInventoryTreeV1(borrowedSnapshot, {
      operation: 'delete', stableKeyHash: mergeTarget.stableKeyHash, peerId: mergeTarget.peerId,
    });
    expect(merged.accounting).toMatchObject({ internalObjects: 1, rootObjects: 1, descriptorObjects: 1 });
    expect(merged.writes.length + 1).toBeLessThanOrEqual(6);
    const mergedSnapshot = applyUpdate(borrowedSnapshot, merged);
    expect(rootInternalChildCounts(mergedSnapshot)).toEqual([255, 128]);
    expect(merged.reusedObjectDigests.has(borrowedRoot.entries[2].childDigest)).toBe(true);
    expect(merged.descriptor).toMatchObject({
      priorRootDigest: borrowedSnapshot.descriptorDigest,
      treeRootDigest: mergedSnapshot.descriptor.treeRootDigest,
      totalRows: '49151',
      version: '2',
    });
    expectCowPublicationArtifacts(borrowedSnapshot, merged);
    const mergedLeaf = merged.writes.find((write) => write.role === 'leaf')!
      .object as SystemRecordInventoryLeafObjectV1;
    expect(mergedLeaf.rows).toHaveLength(255);
    expect(mergedLeaf.rows).not.toContain(encodeInventoryRowBase64UrlV1(NETWORK, mergeTarget));
    }, 120_000,
  );
});

function row(peerId: string): SystemRecordInventoryRowV1 {
  return {
    stableKeyHash: computeSystemRecordStableKeyHashV1(NETWORK, peerId),
    peerId,
    authoritySequence: '0',
    version: '0',
    headDigest: HEAD,
    tombstone: false,
    quarantined: false,
  };
}

function leafFor(rows: readonly SystemRecordInventoryRowV1[]): SystemRecordInventoryLeafObjectV1 {
  return {
    objectType: 'inventory-leaf',
    firstKeyHash: rows[0].stableKeyHash,
    lastKeyHash: rows[rows.length - 1].stableKeyHash,
    rows: rows.map((row) => encodeInventoryRowBase64UrlV1(NETWORK, row)),
  };
}


const DETERMINISTIC_PEER_CACHE: string[] = [];

function deterministicPeers(count: number): string[] {
  while (DETERMINISTIC_PEER_CACHE.length < count) {
    const index = DETERMINISTIC_PEER_CACHE.length;
    const raw = new Uint8Array(32);
    new DataView(raw.buffer).setUint32(28, index + 1, false);
    const encodedEd25519PublicKey = new Uint8Array(36);
    encodedEd25519PublicKey.set([0x08, 0x01, 0x12, 0x20]);
    encodedEd25519PublicKey.set(raw, 4);
    DETERMINISTIC_PEER_CACHE.push(peerIdFromMultihash(
      createMultihashDigest(0x00, encodedEd25519PublicKey),
    ).toString());
  }
  return DETERMINISTIC_PEER_CACHE.slice(0, count);
}

function leafRows(snapshot: ReturnType<typeof buildSystemRecordInventoryTreeV1>): SystemRecordInventoryRowV1[][] {
  const root = snapshot.objects.get(snapshot.descriptor.treeRootDigest)!;
  if (root.objectKind === 'inventory-leaf') {
    return [(root.object as SystemRecordInventoryLeafObjectV1).rows.map((encoded) =>
      decodeSystemRecordInventoryRowV1(NETWORK, Uint8Array.from(Buffer.from(encoded, 'base64url'))))];
  }
  return (root.object as import('../src/system-record-inventory-v1.js').SystemRecordInventoryInternalObjectV1)
    .entries.map((entry) => {
      const leaf = snapshot.objects.get(entry.childDigest)!.object as SystemRecordInventoryLeafObjectV1;
      return leaf.rows.map((encoded) => decodeSystemRecordInventoryRowV1(
        NETWORK,
        Uint8Array.from(Buffer.from(encoded, 'base64url')),
      ));
    });
}

function twoLeafSnapshot(
  leftRows: readonly SystemRecordInventoryRowV1[],
  rightRows: readonly SystemRecordInventoryRowV1[],
): SystemRecordInventoryTreeSnapshotV1 {
  const objects = new Map();
  const leaves = [leafFor(leftRows), leafFor(rightRows)].map((leaf) => {
    const canonicalBytes = canonicalizeSystemRecordInventoryLeafObjectV1(leaf, NETWORK, false);
    const digest = computeSystemRecordInventoryLeafDigestV1(leaf, NETWORK, false);
    objects.set(digest, { objectKind: 'inventory-leaf', object: leaf, canonicalBytes });
    return { leaf, digest };
  });
  const root: SystemRecordInventoryInternalObjectV1 = {
    objectType: 'inventory-internal', firstKeyHash: leaves[0].leaf.firstKeyHash!,
    lastKeyHash: leaves[1].leaf.lastKeyHash!, entries: leaves.map(({ leaf, digest }) => ({
      separatorKeyHash: leaf.firstKeyHash!, childDigest: digest, childKind: 'inventory-leaf',
    })),
  };
  const rootBytes = canonicalizeSystemRecordInventoryInternalObjectV1(root, true);
  const rootDigest = computeSystemRecordInventoryInternalDigestV1(root, true);
  objects.set(rootDigest, { objectKind: 'inventory-internal', object: root, canonicalBytes: rootBytes });
  const descriptor = {
    objectType: 'root-descriptor', kind: 'agents', networkId: NETWORK, epoch: '0', version: '0',
    treeRootDigest: rootDigest, totalRows: (leftRows.length + rightRows.length).toString(),
  } as const;
  return { networkId: NETWORK, descriptor, descriptorDigest: computeSystemRecordRootDescriptorDigestV1(descriptor), objects };
}

function multiLeafSnapshot(
  groups: readonly (readonly SystemRecordInventoryRowV1[])[],
): SystemRecordInventoryTreeSnapshotV1 {
  const objects = new Map();
  const leaves = groups.map((rows) => {
    const leaf = leafFor(rows);
    const canonicalBytes = canonicalizeSystemRecordInventoryLeafObjectV1(leaf, NETWORK, false);
    const digest = computeSystemRecordInventoryLeafDigestV1(leaf, NETWORK, false);
    objects.set(digest, { objectKind: 'inventory-leaf', object: leaf, canonicalBytes });
    return { leaf, digest };
  });
  const root: SystemRecordInventoryInternalObjectV1 = {
    objectType: 'inventory-internal', firstKeyHash: leaves[0].leaf.firstKeyHash!,
    lastKeyHash: leaves.at(-1)!.leaf.lastKeyHash!, entries: leaves.map(({ leaf, digest }) => ({
      separatorKeyHash: leaf.firstKeyHash!, childDigest: digest, childKind: 'inventory-leaf',
    })),
  };
  const rootBytes = canonicalizeSystemRecordInventoryInternalObjectV1(root, true);
  const rootDigest = computeSystemRecordInventoryInternalDigestV1(root, true);
  objects.set(rootDigest, { objectKind: 'inventory-internal', object: root, canonicalBytes: rootBytes });
  const descriptor = {
    objectType: 'root-descriptor', kind: 'agents', networkId: NETWORK, epoch: '0', version: '0',
    treeRootDigest: rootDigest, totalRows: groups.reduce((sum, rows) => sum + rows.length, 0).toString(),
  } as const;
  return { networkId: NETWORK, descriptor, descriptorDigest: computeSystemRecordRootDescriptorDigestV1(descriptor), objects };
}

function heightThreeSnapshot(
  internalLeafCounts: readonly number[],
  oversizedLeaf?: Readonly<{ internalIndex: number; leafIndex: number }>,
): SystemRecordInventoryTreeSnapshotV1 {
  const totalLeaves = internalLeafCounts.reduce((sum, count) => sum + count, 0);
  const totalRows = totalLeaves * 128 + (oversizedLeaf === undefined ? 0 : 1);
  const sorted = deterministicPeers(totalRows).map(row)
    .sort((left, right) => left.stableKeyHash.localeCompare(right.stableKeyHash));
  const objects = new Map();
  let rowOffset = 0;
  const internalRefs = internalLeafCounts.map((leafCount, internalIndex) => {
    const entries = Array.from({ length: leafCount }, (_, leafIndex) => {
      const rowCount = oversizedLeaf?.internalIndex === internalIndex
        && oversizedLeaf.leafIndex === leafIndex ? 129 : 128;
      const rows = sorted.slice(rowOffset, rowOffset + rowCount);
      rowOffset += rowCount;
      const leaf = leafFor(rows);
      const canonicalBytes = canonicalizeSystemRecordInventoryLeafObjectV1(leaf, NETWORK, false);
      const digest = computeSystemRecordInventoryLeafDigestV1(leaf, NETWORK, false);
      objects.set(digest, { objectKind: 'inventory-leaf', object: leaf, canonicalBytes });
      return {
        separatorKeyHash: leaf.firstKeyHash!, childDigest: digest, childKind: 'inventory-leaf' as const,
      };
    });
    const lastLeaf = objects.get(entries.at(-1)!.childDigest)!.object as SystemRecordInventoryLeafObjectV1;
    const internal: SystemRecordInventoryInternalObjectV1 = {
      objectType: 'inventory-internal', firstKeyHash: entries[0].separatorKeyHash,
      lastKeyHash: lastLeaf.lastKeyHash!, entries,
    };
    const canonicalBytes = canonicalizeSystemRecordInventoryInternalObjectV1(internal, false);
    const digest = computeSystemRecordInventoryInternalDigestV1(internal, false);
    objects.set(digest, { objectKind: 'inventory-internal', object: internal, canonicalBytes });
    return { internal, digest };
  });
  const root: SystemRecordInventoryInternalObjectV1 = {
    objectType: 'inventory-internal', firstKeyHash: internalRefs[0].internal.firstKeyHash,
    lastKeyHash: internalRefs.at(-1)!.internal.lastKeyHash,
    entries: internalRefs.map(({ internal, digest }) => ({
      separatorKeyHash: internal.firstKeyHash, childDigest: digest, childKind: 'inventory-internal',
    })),
  };
  const rootBytes = canonicalizeSystemRecordInventoryInternalObjectV1(root, true);
  const rootDigest = computeSystemRecordInventoryInternalDigestV1(root, true);
  objects.set(rootDigest, { objectKind: 'inventory-internal', object: root, canonicalBytes: rootBytes });
  const descriptor = {
    objectType: 'root-descriptor', kind: 'agents', networkId: NETWORK, epoch: '0', version: '0',
    treeRootDigest: rootDigest,
    totalRows: sorted.length.toString(),
  } as const;
  return { networkId: NETWORK, descriptor, descriptorDigest: computeSystemRecordRootDescriptorDigestV1(descriptor), objects };
}

function firstRowOfInternalLeaf(
  snapshot: SystemRecordInventoryTreeSnapshotV1,
  internalIndex: number,
  leafIndex: number,
): SystemRecordInventoryRowV1 {
  const root = snapshot.objects.get(snapshot.descriptor.treeRootDigest)!.object as SystemRecordInventoryInternalObjectV1;
  const internal = snapshot.objects.get(root.entries[internalIndex].childDigest)!.object as SystemRecordInventoryInternalObjectV1;
  const leaf = snapshot.objects.get(internal.entries[leafIndex].childDigest)!.object as SystemRecordInventoryLeafObjectV1;
  return decodeSystemRecordInventoryRowV1(NETWORK, Uint8Array.from(Buffer.from(leaf.rows[0], 'base64url')));
}

function rootInternalChildCounts(snapshot: SystemRecordInventoryTreeSnapshotV1): number[] {
  const root = snapshot.objects.get(snapshot.descriptor.treeRootDigest)!.object as SystemRecordInventoryInternalObjectV1;
  return root.entries.map((entry) => (
    snapshot.objects.get(entry.childDigest)!.object as SystemRecordInventoryInternalObjectV1
  ).entries.length);
}

function applyUpdate(
  snapshot: SystemRecordInventoryTreeSnapshotV1,
  update: SystemRecordInventoryCowUpdateV1,
): SystemRecordInventoryTreeSnapshotV1 {
  const objects = new Map(snapshot.objects);
  for (const write of update.writes) {
    objects.set(write.digest, {
      objectKind: write.objectKind,
      object: write.object,
      canonicalBytes: write.canonicalBytes,
    });
  }
  return {
    networkId: snapshot.networkId,
    descriptor: update.descriptor,
    descriptorDigest: update.descriptorDigest,
    objects,
  };
}

function expectCowPublicationArtifacts(
  snapshot: SystemRecordInventoryTreeSnapshotV1,
  update: SystemRecordInventoryCowUpdateV1,
): void {
  expect(update.descriptorDigest).toBe(computeSystemRecordRootDescriptorDigestV1(update.descriptor));
  expect(update.descriptorBytes).toEqual(canonicalizeSystemRecordRootDescriptorObjectV1(update.descriptor));
  expect(update.accounting.encodedBytes).toBe(
    update.descriptorBytes!.byteLength
      + update.writes.reduce((total, write) => total + write.canonicalBytes.byteLength, 0),
  );

  const overlay = new Map(snapshot.objects);
  for (const write of update.writes) {
    const root = write.role === 'root';
    const expectedBytes = write.objectKind === 'inventory-leaf'
      ? canonicalizeSystemRecordInventoryLeafObjectV1(
          write.object as SystemRecordInventoryLeafObjectV1,
          snapshot.networkId,
          root,
        )
      : canonicalizeSystemRecordInventoryInternalObjectV1(
          write.object as SystemRecordInventoryInternalObjectV1,
          root,
        );
    const expectedDigest = write.objectKind === 'inventory-leaf'
      ? computeSystemRecordInventoryLeafDigestV1(
          write.object as SystemRecordInventoryLeafObjectV1,
          snapshot.networkId,
          root,
        )
      : computeSystemRecordInventoryInternalDigestV1(
          write.object as SystemRecordInventoryInternalObjectV1,
          root,
        );
    expect(write.canonicalBytes).toEqual(expectedBytes);
    expect(write.digest).toBe(expectedDigest);
    overlay.set(write.digest, write);
  }

  const root = overlay.get(update.descriptor.treeRootDigest);
  expect(root).toBeDefined();
  for (const write of update.writes) {
    if (write.objectKind !== 'inventory-internal') continue;
    const internal = write.object as SystemRecordInventoryInternalObjectV1;
    for (const entry of internal.entries) {
      const child = overlay.get(entry.childDigest);
      expect(child?.objectKind).toBe(entry.childKind);
      expect(child?.object.firstKeyHash).toBe(entry.separatorKeyHash);
    }
    expect(internal.lastKeyHash).toBe(
      overlay.get(internal.entries.at(-1)!.childDigest)?.object.lastKeyHash,
    );
  }
}

async function validateTree(
  descriptor: SystemRecordInventoryTreeSnapshotV1['descriptor'],
  load: (digest: `0x${string}`) => Promise<
    SystemRecordInventoryLeafObjectV1 | SystemRecordInventoryInternalObjectV1 | undefined
  >,
  signal?: AbortSignal,
) {
  return validateTreeArtifacts(descriptor, async (digest) => {
    const object = await load(digest);
    if (object === undefined) return undefined;
    const root = digest === descriptor.treeRootDigest;
    return object.objectType === 'inventory-leaf'
      ? {
          objectKind: 'inventory-leaf' as const,
          canonicalBytes: canonicalizeSystemRecordInventoryLeafObjectV1(object, NETWORK, root),
        }
      : {
          objectKind: 'inventory-internal' as const,
          canonicalBytes: canonicalizeSystemRecordInventoryInternalObjectV1(object, root),
        };
  }, signal);
}

async function validateSnapshotTree(snapshot: SystemRecordInventoryTreeSnapshotV1) {
  return validateTreeArtifacts(snapshot.descriptor, async (digest) => snapshot.objects.get(digest));
}

async function validateTreeArtifacts(
  descriptor: SystemRecordInventoryTreeSnapshotV1['descriptor'],
  load: (digest: `0x${string}`) => Promise<SystemRecordInventoryStoredObjectV1 | undefined>,
  signal?: AbortSignal,
) {
  const traversal = createSystemRecordInventoryTraversalV1(descriptor);
  while (true) {
    const result = await traversal.advance(async (digest) => {
      const stored = await load(digest);
      return stored === undefined
        ? undefined
        : loadedInventoryObject(stored);
    }, {
      signal,
      maxRequests: 12,
      maxWireBytes: 2 * 1024 * 1024,
      deadlineMs: 3_000,
      nowMs: () => 0,
    });
    if (result.status === 'complete') return result.result!;
  }
}

function loadedInventoryObject(stored: SystemRecordInventoryStoredObjectV1) {
  return {
    outcome: 'ok' as const,
    objectKind: stored.objectKind,
    canonicalBytes: stored.canonicalBytes,
    wireBytes: 4 + 128 + stored.canonicalBytes.byteLength,
  };
}
