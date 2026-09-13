import type { SnapshotGarbageCollectionResult } from './workspace-snapshot-store.js';

/** A filesystem reading. Only `availableBytes` is corrected for reservations. */
export interface SnapshotWriteCapacityReading {
  readonly availableBytes: number;
  readonly totalBytes: number;
}

export interface SnapshotWriteCapacityWatermarks {
  readonly triggerFreeBytes: number;
  readonly hardReserveBytes: number;
}

/** Filesystem and garbage-collection ports; the store binds them to its directory and policy. */
export interface SnapshotWriteCapacityPorts {
  /** A fresh reading of the snapshot filesystem. */
  readonly readFilesystemSpace: () => Promise<SnapshotWriteCapacityReading>;
  /** The admission policy for a filesystem of the given size. */
  readonly watermarks: (totalBytes: number) => SnapshotWriteCapacityWatermarks;
  /** Reclaim space until `requiredWriteBytes` fit above the hard reserve. */
  readonly collectGarbage: (requiredWriteBytes: number) => Promise<SnapshotGarbageCollectionResult>;
  /** Observes a collection that preceded a successful admission. */
  readonly onGarbageCollected?: (result: SnapshotGarbageCollectionResult) => void;
}

/** Bytes admitted for one physical write, retired once that write has settled. */
export interface SnapshotWriteCapacityLease {
  /** Idempotent: nested cleanup paths may release more than once. */
  release(): void;
}

export interface SnapshotWriteCapacityAdmission {
  reserve(requiredWriteBytes: number): Promise<SnapshotWriteCapacityLease>;
}

export class SnapshotStorageCapacityError extends Error {
  readonly code = 'SNAPSHOT_STORAGE_CAPACITY';

  constructor(
    readonly availableBytes: number,
    readonly requiredBytes: number,
    readonly hardReserveBytes: number,
  ) {
    super(
      `Insufficient shared-memory snapshot storage capacity: ${availableBytes} bytes available, `
      + `${requiredBytes} bytes required, ${hardReserveBytes} byte hard reserve`,
    );
    this.name = 'SnapshotStorageCapacityError';
  }
}

/**
 * Write-capacity admission for the file snapshot store.
 *
 * Admission is the ONLY serialized step of a snapshot write: one reservation
 * decision at a time, against a filesystem reading corrected for every admitted
 * write that has not yet been published. The physical writes behind those
 * leases proceed in parallel, and a rejected admission never blocks the lane.
 */
export class SnapshotWriteCapacityCoordinator implements SnapshotWriteCapacityAdmission {
  private tail: Promise<void> = Promise.resolve();
  private reservedBytes = 0;

  constructor(private readonly ports: SnapshotWriteCapacityPorts) {}

  /** Bytes admitted but not yet released by their leases. */
  get reservedWriteBytes(): number {
    return this.reservedBytes;
  }

  reserve(requiredWriteBytes: number): Promise<SnapshotWriteCapacityLease> {
    const admission = this.tail.then(async () => {
      await this.ensureCapacity(requiredWriteBytes);
      this.reservedBytes += requiredWriteBytes;
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          this.reservedBytes -= requiredWriteBytes;
        },
      };
    });
    this.tail = admission.then(() => {}, () => {});
    return admission;
  }

  /** A reading is stable only if no reservation retired while it was taken. */
  private async readCapacity(): Promise<SnapshotWriteCapacityReading> {
    for (;;) {
      const reservedBytes = this.reservedBytes;
      const filesystem = await this.ports.readFilesystemSpace();
      // Admission is serialized, so reservations can only retire during this
      // read. Retry if one retires: the reading may predate its physical write,
      // and subtracting the new, smaller reservation would overstate capacity.
      if (reservedBytes !== this.reservedBytes) continue;
      return {
        totalBytes: filesystem.totalBytes,
        availableBytes: Math.max(0, filesystem.availableBytes - reservedBytes),
      };
    }
  }

  private async ensureCapacity(requiredWriteBytes: number): Promise<void> {
    const filesystem = await this.readCapacity();
    const watermarks = this.ports.watermarks(filesystem.totalBytes);
    const needsCollection = filesystem.availableBytes < watermarks.triggerFreeBytes
      || filesystem.availableBytes - requiredWriteBytes < watermarks.hardReserveBytes;
    // Outstanding reservations are as real to the collector as published files.
    const result = needsCollection
      ? await this.ports.collectGarbage(requiredWriteBytes + this.reservedBytes)
      : undefined;
    // Admission is based on a fresh filesystem reading, not projected file
    // sizes: an unlinked file held open by another process may not have
    // released its blocks yet.
    const afterCollection = result ? await this.readCapacity() : filesystem;
    if (afterCollection.availableBytes - requiredWriteBytes < watermarks.hardReserveBytes) {
      throw new SnapshotStorageCapacityError(
        afterCollection.availableBytes,
        requiredWriteBytes,
        watermarks.hardReserveBytes,
      );
    }
    if (result) this.ports.onGarbageCollected?.(result);
  }
}
