import { mkdir, mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  FileWorkspacePublicSnapshotStore,
  SnapshotStorageCapacityError,
  serializeWorkspacePublicSnapshotQuads,
} from '../src/workspace-snapshot-store.js';
import {
  snapshotStoreOptionsWithAdmission,
  SnapshotWriteCapacityCoordinator,
  type SnapshotWriteCapacityLease,
} from '../src/workspace-snapshot-write-capacity.js';

import { MemoryPageIndexStore, makeQuads, digestFor, snapshotPath } from './_helpers/workspace-snapshot-store.js';

/**
 * Bytes these snapshots currently occupy on the snapshot filesystem; a digest
 * with no published file counts zero.
 *
 * Every scenario below drives admission off real committed size rather than a
 * projected figure, so that a reservation the coordinator still holds is
 * distinguishable from bytes the filesystem has already accounted for.
 */
async function snapshotBytesOnDisk(directory: string, digests: readonly string[]): Promise<number> {
  const sizes = await Promise.all(digests.map(async (digest) => {
    try { return (await stat(snapshotPath(directory, digest))).size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  }));
  return sizes.reduce((sum, size) => sum + size, 0);
}

describe('FileWorkspacePublicSnapshotStore write capacity', () => {
  it('overlaps distinct snapshot writes through gated index persistence and protects active files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-write-overlap-'));
    const inputs = Array.from({ length: 4 }, (_, i) => ({ digest: digestFor(900 + i), quads: makeQuads(3, `overlap-${i}`) }));
    const releases: Array<() => void> = [];
    const gates = inputs.map(() => new Promise<void>(resolve => { releases.push(resolve); }));
    const entered: string[] = [];
    const indexes = new MemoryPageIndexStore();
    const upsert = indexes.upsert.bind(indexes);
    vi.spyOn(indexes, 'upsert').mockImplementation(async record => {
      entered.push(record.snapshotDigest);
      await gates[inputs.findIndex(input => input.digest === record.snapshotDigest)];
      await upsert(record);
    });
    let availableBytes = 1_000_000;
    const store = new FileWorkspacePublicSnapshotStore(directory, indexes, {
      gc: { enabled: true, intervalMs: 60_000, triggerFreeBytes: 1000,
        targetFreeBytes: 2000, hardReserveBytes: 500, minAgeMs: 0 },
      getAvailableBytes: async () => availableBytes,
      now: () => Date.now() + 60_000,
    });
    const writes = inputs.map(input => store.putSnapshot(input));
    const duplicate = store.putSnapshot(inputs[0]!);
    let settled = 0;
    writes.forEach(write => { void write.then(() => { settled++; }, () => { settled++; }); });
    try {
      await vi.waitFor(() => expect(entered).toHaveLength(4));
      expect(new Set(entered)).toEqual(new Set(inputs.map(input => input.digest)));
      expect(settled).toBe(0);
      for (const input of inputs) await expect(stat(snapshotPath(directory, input.digest))).resolves.toBeTruthy();
      availableBytes = 0;
      expect(await store.collectGarbage()).toMatchObject({ deletedSnapshots: 0, skippedActiveFiles: 4 });
      availableBytes = 1_000_000;
      releases.forEach(release => release());
      expect(await Promise.all([...writes, duplicate])).toHaveLength(5);
      expect(indexes.upsert).toHaveBeenCalledTimes(4);
    } finally {
      releases.forEach(release => release());
      await Promise.allSettled([...writes, duplicate]);
      store.stopGarbageCollection();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retires byte capacity after publication while index persistence remains active', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-index-capacity-'));
    const inputs = [940, 941].map(i => ({ digest: digestFor(i), quads: makeQuads(3, `index-capacity-${i}`) }));
    const writeBytes = Buffer.byteLength(serializeWorkspacePublicSnapshotQuads(inputs[0]!.quads), 'utf8');
    const hardReserveBytes = 1_000;
    const totalCapacity = hardReserveBytes + 2 * writeBytes;
    const committedBytes = () => snapshotBytesOnDisk(directory, inputs.map(input => input.digest));
    let releaseFirstIndex!: () => void;
    let firstIndexEntered!: () => void;
    const firstIndexGate = new Promise<void>(resolve => { releaseFirstIndex = resolve; });
    const firstIndexEnteredGate = new Promise<void>(resolve => { firstIndexEntered = resolve; });
    const indexes = new MemoryPageIndexStore();
    const upsert = indexes.upsert.bind(indexes);
    vi.spyOn(indexes, 'upsert').mockImplementation(async record => {
      if (record.snapshotDigest === inputs[0]!.digest) {
        firstIndexEntered();
        await firstIndexGate;
      }
      await upsert(record);
    });
    const store = new FileWorkspacePublicSnapshotStore(directory, indexes, {
      gc: { enabled: true, intervalMs: 60_000, triggerFreeBytes: hardReserveBytes + 1,
        targetFreeBytes: hardReserveBytes + 2, hardReserveBytes, minAgeMs: Number.MAX_SAFE_INTEGER },
      getAvailableBytes: async () => totalCapacity - await committedBytes(),
    });
    const firstWrite = store.putSnapshot(inputs[0]!);
    let firstSettled = false;
    void firstWrite.then(() => { firstSettled = true; }, () => { firstSettled = true; });
    try {
      await firstIndexEnteredGate;
      expect(firstSettled).toBe(false);
      await expect(stat(snapshotPath(directory, inputs[0]!.digest))).resolves.toBeTruthy();
      await expect(store.putSnapshot(inputs[1]!)).resolves.toMatchObject({ ref: inputs[1]!.digest });
      expect(firstSettled).toBe(false);
      expect(totalCapacity - await committedBytes()).toBe(hardReserveBytes);
    } finally {
      releaseFirstIndex();
      await firstWrite;
      store.stopGarbageCollection();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('releases a write reservation and same-digest ownership after physical persistence fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-write-failure-'));
    const input = { digest: digestFor(910), quads: makeQuads(3, 'failed-write') };
    const bytes = Buffer.byteLength(serializeWorkspacePublicSnapshotQuads(input.quads), 'utf8');
    const hardReserveBytes = 1000;
    const now = Date.now();
    const tempPath = `${snapshotPath(directory, input.digest)}.${process.pid}.${now}.tmp`;
    const store = new FileWorkspacePublicSnapshotStore(directory, undefined, {
      gc: { enabled: true, intervalMs: 60_000, triggerFreeBytes: hardReserveBytes + 1,
        targetFreeBytes: hardReserveBytes + 2, hardReserveBytes },
      getAvailableBytes: async () => hardReserveBytes + Math.floor(bytes * 1.5),
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await mkdir(tempPath, { recursive: true });
      const failure = await store.putSnapshot(input).catch(error => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(SnapshotStorageCapacityError);
      await rm(tempPath, { recursive: true });
      await expect(store.putSnapshot(input)).resolves.toMatchObject({ ref: input.digest, byteLength: bytes });
    } finally {
      clock.mockRestore(); store.stopGarbageCollection();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps concurrent distinct writes above the aggregate hard reserve and recovers after rejection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-concurrent-capacity-'));
    const inputs = Array.from({ length: 4 }, (_, i) => ({ digest: digestFor(800 + i), quads: makeQuads(3, `concurrent-${i}`) }));
    const writeBytes = Buffer.byteLength(serializeWorkspacePublicSnapshotQuads(inputs[0]!.quads), 'utf8');
    const hardReserveBytes = 1000;
    let capacity = hardReserveBytes + Math.floor(writeBytes * 2.5);
    const committedBytes = () => snapshotBytesOnDisk(directory, inputs.map(input => input.digest));
    // Hold publication after real capacity admission so filesystem usage is
    // still zero when all four writes compete for only two reservations.
    let releaseWrites!: () => void;
    const writesBlocked = new Promise<void>(resolve => { releaseWrites = resolve; });
    let decisions = 0; let accepted = 0;
    const store = new FileWorkspacePublicSnapshotStore(directory, undefined, snapshotStoreOptionsWithAdmission(
      ports => {
        const coordinator = new SnapshotWriteCapacityCoordinator(ports);
        return {
          reserve: async bytes => {
            let lease: SnapshotWriteCapacityLease;
            try { lease = await coordinator.reserve(bytes); }
            catch (error) { decisions++; throw error; }
            accepted++; decisions++;
            await writesBlocked;
            return lease;
          },
        };
      },
      {
        gc: { enabled: true, intervalMs: 60_000, triggerFreeBytes: hardReserveBytes + 1,
          targetFreeBytes: hardReserveBytes + 1, hardReserveBytes, minAgeMs: Number.MAX_SAFE_INTEGER },
        getAvailableBytes: async () => capacity - await committedBytes(),
      },
    ));
    const writes = Promise.allSettled(inputs.map(input => store.putSnapshot(input)));
    try {
      await vi.waitFor(() => expect(decisions).toBe(4));
      expect(accepted).toBe(2);
      expect(await committedBytes()).toBe(0);
      releaseWrites();
      const outcomes = await writes;
      expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(2);
      const rejected = outcomes.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      expect(rejected).toHaveLength(2);
      expect(rejected.every(error => error instanceof SnapshotStorageCapacityError)).toBe(true);
      expect(capacity - await committedBytes()).toBeGreaterThanOrEqual(hardReserveBytes);
      // A failed admission must release the write queue for later recovery.
      capacity += writeBytes;
      const retry = inputs[outcomes.findIndex(result => result.status === 'rejected')]!;
      await expect(store.putSnapshot(retry)).resolves.toMatchObject({ ref: retry.digest });
      expect(capacity - await committedBytes()).toBeGreaterThanOrEqual(hardReserveBytes);
    } finally {
      releaseWrites(); await writes;
      store.stopGarbageCollection(); await rm(directory, { recursive: true, force: true });
    }
  });

  it('rechecks capacity when a reservation retires during a filesystem reading', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-capacity-reading-'));
    const inputs = [920, 921].map(i => ({ digest: digestFor(i), quads: makeQuads(3, `reading-${i}`) }));
    const bytes = Buffer.byteLength(serializeWorkspacePublicSnapshotQuads(inputs[0]!.quads), 'utf8');
    const hardReserveBytes = 1000;
    const capacity = hardReserveBytes + Math.floor(bytes * 1.5);
    const committedBytes = () => snapshotBytesOnDisk(directory, inputs.map(input => input.digest));
    let releaseWrite!: () => void; let reserved!: () => void;
    let releaseRead!: () => void; let readStarted!: () => void;
    const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
    const reservedGate = new Promise<void>(resolve => { reserved = resolve; });
    const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
    const readStartedGate = new Promise<void>(resolve => { readStarted = resolve; });
    let reads = 0;
    let first = true;
    const store = new FileWorkspacePublicSnapshotStore(directory, undefined, snapshotStoreOptionsWithAdmission(
      ports => {
        const coordinator = new SnapshotWriteCapacityCoordinator(ports);
        return {
          reserve: async requiredBytes => {
            const lease = await coordinator.reserve(requiredBytes);
            if (first) { first = false; reserved(); await writeGate; }
            return lease;
          },
        };
      },
      {
        gc: { enabled: true, intervalMs: 60_000, triggerFreeBytes: hardReserveBytes + 1,
          targetFreeBytes: hardReserveBytes + 2, hardReserveBytes, minAgeMs: Number.MAX_SAFE_INTEGER },
        getAvailableBytes: async () => {
          const reading = ++reads;
          const available = capacity - await committedBytes();
          if (reading === 2) { readStarted(); await readGate; }
          return available;
        },
      },
    ));
    const firstWrite = store.putSnapshot(inputs[0]!);
    let secondWrite: Promise<unknown> | undefined;
    try {
      await reservedGate;
      secondWrite = store.putSnapshot(inputs[1]!).then(value => ({ value }), error => ({ error }));
      await readStartedGate;
      releaseWrite(); await firstWrite;
      releaseRead();
      const outcome = await secondWrite;
      expect(outcome).toMatchObject({ error: expect.any(SnapshotStorageCapacityError) });
      expect(capacity - await committedBytes()).toBeGreaterThanOrEqual(hardReserveBytes);
      await expect(stat(snapshotPath(directory, inputs[1]!.digest))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      releaseWrite(); releaseRead();
      await Promise.allSettled([firstWrite, secondWrite]);
      store.stopGarbageCollection(); await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports a collection that admitted the write behind it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-gc-admit-'));
    const evictable = { digest: digestFor(930), quads: makeQuads(3, 'evictable') };
    const input = { digest: digestFor(931), quads: makeQuads(3, 'admitted-after-gc') };
    const bytes = Buffer.byteLength(serializeWorkspacePublicSnapshotQuads(input.quads), 'utf8');
    const hardReserveBytes = 1000;
    const now = Date.now();
    const committedBytes = () => snapshotBytesOnDisk(directory, [evictable.digest, input.digest]);
    const logs: string[] = [];
    await new FileWorkspacePublicSnapshotStore(directory).putSnapshot(evictable);
    await utimes(snapshotPath(directory, evictable.digest), new Date(now - 20_000), new Date(now - 20_000));
    // Only the evictable snapshot stands between the new write and the hard reserve.
    const capacity = hardReserveBytes + bytes + Math.floor(await committedBytes() / 2);
    const store = new FileWorkspacePublicSnapshotStore(directory, undefined, {
      gc: { enabled: true, intervalMs: 60_000, triggerFreeBytes: hardReserveBytes + 1,
        targetFreeBytes: hardReserveBytes + 2, hardReserveBytes, minAgeMs: 10_000 },
      getAvailableBytes: async () => capacity - await committedBytes(),
      now: () => now,
      log: message => { logs.push(message); },
    });
    try {
      await expect(store.putSnapshot(input)).resolves.toMatchObject({ ref: input.digest, byteLength: bytes });
      await expect(stat(snapshotPath(directory, evictable.digest))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(logs).toEqual([expect.stringMatching(/^\[SWM-SNAPSHOT-GC\] triggered=true snapshots=1 /)]);
    } finally {
      store.stopGarbageCollection();
      await rm(directory, { recursive: true, force: true });
    }
  });

  /**
   * Admission belongs to ONE store: the seam travels on the options that store
   * was built from, so neither a sibling nor a store constructed while those
   * options are in hand can be given — or steal — another store's coordinator.
   */
  it('gives each store the admission its own options name, nested or plain', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-snapshot-admission-isolation-'));
    const inputs = Array.from({ length: 3 }, (_, i) => ({ digest: digestFor(940 + i), quads: makeQuads(3, `isolated-${i}`) }));
    const writeBytes = inputs.map(input => Buffer.byteLength(serializeWorkspacePublicSnapshotQuads(input.quads), 'utf8'));
    const policy = {
      gc: { enabled: true, intervalMs: 60_000, triggerFreeBytes: 1_000,
        targetFreeBytes: 2_000, hardReserveBytes: 500, minAgeMs: Number.MAX_SAFE_INTEGER },
      getAvailableBytes: async () => 1_000_000,
    };
    const reservedByFirst: number[] = [];
    const reservedBySecond: number[] = [];
    const gated = (reserved: number[]) => snapshotStoreOptionsWithAdmission(
      ports => {
        const coordinator = new SnapshotWriteCapacityCoordinator(ports);
        return { reserve: async bytes => { reserved.push(bytes); return coordinator.reserve(bytes); } };
      },
      { ...policy },
    );
    let second!: FileWorkspacePublicSnapshotStore;
    let ungated!: FileWorkspacePublicSnapshotStore;
    // The other two GC-enabled stores are constructed WHILE the first store's
    // options are already in hand — the shape that let a construction-ordered
    // override reach the wrong store.
    const first = new FileWorkspacePublicSnapshotStore(directory, undefined, ((options) => {
      second = new FileWorkspacePublicSnapshotStore(directory, undefined, gated(reservedBySecond));
      ungated = new FileWorkspacePublicSnapshotStore(directory, undefined, { ...policy });
      return options;
    })(gated(reservedByFirst)));
    try {
      await expect(first.putSnapshot(inputs[0]!)).resolves.toMatchObject({ ref: inputs[0]!.digest });
      await expect(second.putSnapshot(inputs[1]!)).resolves.toMatchObject({ ref: inputs[1]!.digest });
      // The store with no seam admitted its own write through the coordinator.
      await expect(ungated.putSnapshot(inputs[2]!)).resolves.toMatchObject({ ref: inputs[2]!.digest });
      expect(reservedByFirst).toEqual([writeBytes[0]]);
      expect(reservedBySecond).toEqual([writeBytes[1]]);
      await expect(stat(snapshotPath(directory, inputs[2]!.digest))).resolves.toMatchObject({ size: writeBytes[2] });
    } finally {
      [first, second, ungated].forEach(store => { store.stopGarbageCollection(); });
      await rm(directory, { recursive: true, force: true });
    }
  });
});
