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
  readonly collectGarbage: (requiredWriteBytes: number) => Promise<void>;
}

/** Bytes admitted for one physical write, retired as the filesystem materializes them. */
export interface SnapshotWriteCapacityLease {
  /** The complete temporary file is now reflected in filesystem free space. */
  markMaterialized(): void;
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
  private unmaterializedBytes = 0;

  constructor(private readonly ports: SnapshotWriteCapacityPorts) {}

  /** Bytes admitted but not yet reflected in a complete temporary file. */
  get reservedWriteBytes(): number {
    return this.unmaterializedBytes;
  }

  reserve(requiredWriteBytes: number): Promise<SnapshotWriteCapacityLease> {
    const admission = this.tail.then(async () => {
      await this.ensureCapacity(requiredWriteBytes);
      this.unmaterializedBytes += requiredWriteBytes;
      let materialized = false;
      let released = false;
      const retireReservation = () => {
        if (materialized) return;
        materialized = true;
        this.unmaterializedBytes -= requiredWriteBytes;
      };
      return {
        markMaterialized: retireReservation,
        release: () => {
          if (released) return;
          released = true;
          retireReservation();
        },
      };
    });
    this.tail = admission.then(() => {}, () => {});
    return admission;
  }

  /** A reading is stable only if no reservation retired while it was taken. */
  private async readCapacity(): Promise<SnapshotWriteCapacityReading> {
    for (;;) {
      const reservedBytes = this.unmaterializedBytes;
      const filesystem = await this.ports.readFilesystemSpace();
      // Admission is serialized, so reservations can only retire during this
      // read. Retry if one retires: the reading may predate its physical write,
      // and subtracting the new, smaller reservation would overstate capacity.
      if (reservedBytes !== this.unmaterializedBytes) continue;
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
    if (needsCollection) {
      await this.ports.collectGarbage(requiredWriteBytes + this.unmaterializedBytes);
    }
    // Admission is based on a fresh filesystem reading, not projected file
    // sizes: an unlinked file held open by another process may not have
    // released its blocks yet.
    const afterCollection = needsCollection ? await this.readCapacity() : filesystem;
    if (afterCollection.availableBytes - requiredWriteBytes < watermarks.hardReserveBytes) {
      throw new SnapshotStorageCapacityError(
        afterCollection.availableBytes,
        requiredWriteBytes,
        watermarks.hardReserveBytes,
      );
    }
  }
}

type SnapshotWriteCapacityAdmissionFactory =
  (ports: SnapshotWriteCapacityPorts) => SnapshotWriteCapacityAdmission;

let pendingAdmission: SnapshotWriteCapacityAdmissionFactory | undefined;

/**
 * The store's ONE construction point for write admission.
 *
 * Production always coordinates, so the coordinator, its ports and its lease
 * protocol stay inside this package instead of becoming store options a
 * consumer could replace.
 */
export function createSnapshotWriteCapacityAdmission(
  ports: SnapshotWriteCapacityPorts,
): SnapshotWriteCapacityAdmission {
  const override = pendingAdmission;
  pendingAdmission = undefined;
  return override ? override(ports) : new SnapshotWriteCapacityCoordinator(ports);
}

/**
 * Package-private admission seam for the store's integration tests, which have
 * to hold a reservation open while sibling writes compete for capacity.
 *
 * The override exists only for the synchronous `construct()` call and is
 * consumed by the one store built inside it, so it can never reach another
 * store and is always absent in production. A `construct` that builds no
 * admission — garbage collection disabled, or a rejected configuration — is
 * reported rather than silently running against the real coordinator.
 */
export function withSnapshotWriteCapacityAdmission<T>(
  createAdmission: SnapshotWriteCapacityAdmissionFactory,
  construct: () => T,
): T {
  let consumed = false;
  pendingAdmission = (ports) => {
    consumed = true;
    return createAdmission(ports);
  };
  try {
    const constructed = construct();
    if (!consumed) throw new Error('Snapshot write capacity admission override was not consumed');
    return constructed;
  } finally {
    pendingAdmission = undefined;
  }
}
