import { describe, expect, it, vi } from 'vitest';
import {
  SnapshotStorageCapacityError,
  SnapshotWriteCapacityCoordinator,
  type SnapshotWriteCapacityPorts,
} from '../src/workspace-snapshot-write-capacity.js';

const HARD_RESERVE = 1_000;
const WRITE = 400;

function ports(
  available: () => number | Promise<number>,
  overrides: Partial<SnapshotWriteCapacityPorts> = {},
): SnapshotWriteCapacityPorts {
  return {
    readFilesystemSpace: async () => ({ availableBytes: await available(), totalBytes: 10 * HARD_RESERVE }),
    watermarks: () => ({ triggerFreeBytes: HARD_RESERVE + 1, hardReserveBytes: HARD_RESERVE }),
    collectGarbage: async () => {},
    ...overrides,
  };
}

describe('SnapshotWriteCapacityCoordinator', () => {
  it('admits concurrent reservations only while their aggregate stays above the hard reserve', async () => {
    // Nothing is published during the test, so only the reservations themselves
    // can stop the third and fourth writes from being admitted.
    const capacity = HARD_RESERVE + Math.floor(WRITE * 2.5);
    const collectGarbage = vi.fn(async () => {});
    const coordinator = new SnapshotWriteCapacityCoordinator(ports(() => capacity, { collectGarbage }));
    const outcomes = await Promise.allSettled([1, 2, 3, 4].map(() => coordinator.reserve(WRITE)));
    const leases = outcomes.flatMap(outcome => outcome.status === 'fulfilled' ? [outcome.value] : []);
    const rejected = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason] : []);
    expect(leases).toHaveLength(2);
    expect(rejected).toHaveLength(2);
    expect(rejected.every(error => error instanceof SnapshotStorageCapacityError)).toBe(true);
    expect(coordinator.reservedWriteBytes).toBe(2 * WRITE);
    // The collector is asked for this write plus every outstanding reservation.
    expect(collectGarbage.mock.calls.map(([bytes]) => bytes)).toEqual([3 * WRITE, 3 * WRITE]);
    // A rejection leaves the lane open, and a retired lease returns its bytes.
    await expect(coordinator.reserve(WRITE)).rejects.toBeInstanceOf(SnapshotStorageCapacityError);
    leases[0]!.release();
    expect(coordinator.reservedWriteBytes).toBe(WRITE);
    await expect(coordinator.reserve(WRITE)).resolves.toBeTruthy();
    expect(coordinator.reservedWriteBytes).toBe(2 * WRITE);
  });

  it('retires a lease once, however many times it is released', async () => {
    const coordinator = new SnapshotWriteCapacityCoordinator(ports(() => HARD_RESERVE + 3 * WRITE));
    const first = await coordinator.reserve(WRITE);
    const second = await coordinator.reserve(WRITE);
    expect(coordinator.reservedWriteBytes).toBe(2 * WRITE);
    first.markMaterialized();
    first.markMaterialized();
    expect(coordinator.reservedWriteBytes).toBe(WRITE);
    first.release();
    first.release();
    expect(coordinator.reservedWriteBytes).toBe(WRITE);
    second.release();
    expect(coordinator.reservedWriteBytes).toBe(0);
  });

  it('does not charge a complete temporary file as an outstanding reservation', async () => {
    let materializedBytes = 0;
    const collectGarbage = vi.fn(async () => {});
    const coordinator = new SnapshotWriteCapacityCoordinator(ports(
      () => HARD_RESERVE + 2 * WRITE - materializedBytes,
      { collectGarbage },
    ));
    const first = await coordinator.reserve(WRITE);
    materializedBytes = WRITE;
    first.markMaterialized();

    const second = await coordinator.reserve(WRITE);
    expect(coordinator.reservedWriteBytes).toBe(WRITE);
    expect(collectGarbage).not.toHaveBeenCalled();
    first.release();
    second.release();
  });

  it('re-reads the filesystem when a reservation retires during a reading', async () => {
    // A reading taken before a sibling published does not see its bytes; pairing
    // it with the smaller reservation that followed would count that space twice.
    const capacity = HARD_RESERVE + Math.floor(WRITE * 1.5);
    let committed = 0;
    let reads = 0;
    let releaseRead!: () => void;
    const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
    const readings: number[] = [];
    const coordinator = new SnapshotWriteCapacityCoordinator(ports(async () => {
      const available = capacity - committed;
      readings.push(available);
      if (++reads === 2) await readGate;
      return available;
    }));
    const first = await coordinator.reserve(WRITE);
    const second = coordinator.reserve(WRITE).then(() => 'admitted', (error: unknown) => error);
    await vi.waitFor(() => expect(reads).toBe(2));
    // The first write publishes and retires while the second reading is in flight.
    committed = WRITE;
    first.release();
    releaseRead();
    const outcome = await second;
    expect(outcome).toBeInstanceOf(SnapshotStorageCapacityError);
    expect(outcome).toMatchObject({ availableBytes: capacity - WRITE, requiredBytes: WRITE, hardReserveBytes: HARD_RESERVE });
    // The stale reading is discarded; the collector then gets its own fresh one.
    expect(readings).toEqual([capacity, capacity, capacity - WRITE, capacity - WRITE]);
    expect(coordinator.reservedWriteBytes).toBe(0);
  });

  it('collects before admission and re-reads the resulting capacity', async () => {
    let available = HARD_RESERVE + WRITE - 1;
    let reclaimable = WRITE;
    const collectGarbage = vi.fn(async () => { available += reclaimable; });
    const coordinator = new SnapshotWriteCapacityCoordinator(ports(() => available, {
      collectGarbage,
    }));
    await expect(coordinator.reserve(WRITE)).resolves.toBeTruthy();
    expect(collectGarbage).toHaveBeenCalledTimes(1);
    reclaimable = 0;
    await expect(coordinator.reserve(WRITE)).rejects.toBeInstanceOf(SnapshotStorageCapacityError);
    expect(collectGarbage).toHaveBeenCalledTimes(2);
  });
});
