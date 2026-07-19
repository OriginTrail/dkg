import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { TextDecoder } from 'node:util';
import {
  fsyncRfc64DirectorySyncV1,
  rfc64CurrentUserOwnsUidV1,
  rfc64PosixModeMatchesV1,
  rfc64RegularFileFsyncOpenFlagsV1,
} from '../secure-filesystem-policy-v1.js';

import {
  INVENTORY_V1_APPLICATION_ID,
  INVENTORY_V1_DDL,
  INVENTORY_V1_DIRECTORY_MODE,
  INVENTORY_V1_FILE_MODE,
  INVENTORY_V1_RELATIVE_PATH,
  INVENTORY_V1_USER_OBJECTS,
  INVENTORY_V1_USER_VERSION,
  normalizeInventoryV1SchemaSql,
} from './sql.js';
import {
  CandidateInventoryV1,
  type CandidateCatalogPrecommitResultV1,
  type CandidateBucketDiffTraversalV1,
  type CandidateBucketHeaderV1,
  type CandidateBucketLoadKeyV1,
  type CandidateBucketPageV1,
  type CandidateBucketPutResultV1,
  type CandidateBucketRowSnapshotV1,
  type CandidateBucketRowsTraversalV1,
  type CandidateSessionV1,
  type CandidateSessionGcBatchResultV1,
  type Rfc64InventoryV1CandidateApi,
  type VerifiedCandidateBucketLoadV1,
  type VerifiedCandidateCatalogRowV1,
} from './candidate.js';
import type {
  CatalogSealDeploymentProfileV1,
  CgSharedProjectionVerificationLimitsV1,
  KaIdV1,
  SignedAuthorCatalogHeadEnvelopeV1,
} from '@origintrail-official/dkg-core';
import {
  createProductionInventoryV1LifecycleAdapter,
  INVENTORY_V1_POSIX_QUARANTINE_CAPABILITY,
  type InventoryV1LifecycleAdapter,
  type InventoryV1QuarantineBoundary,
  type InventoryV1QuarantineCapability,
  type InventoryV1TargetCloseReason,
} from './lifecycle-adapter.js';

type SqliteModuleV1 = typeof import('node:sqlite');
type DatabaseSyncV1 = InstanceType<SqliteModuleV1['DatabaseSync']>;

const RECOVERY_MARKER_SUFFIX = '.rebuild-required';
const QUARANTINE_DIRECTORY = 'quarantine';
const OWNED_FILE_SUFFIXES = ['', '-journal', '-wal', '-shm'] as const;
const LEASE_DATABASE_NAME = 'inventory-v1.lease.sqlite3';
const LEASE_FILE_SUFFIXES = ['', '-journal'] as const;
const LEASE_APPLICATION_ID = 0x444b364c;
const LEASE_USER_VERSION = 1;
const LEASE_CREATION_RACE_TIMEOUT_MS = 1_000;
const LEASE_CREATION_RACE_RETRY_MS = 10;
const RECOVERY_MARKER_MAX_BYTES = 4_096;

export type InventoryV1OpenErrorCode =
  | 'sqlite-unavailable'
  | 'foreign-database'
  | 'newer-schema'
  | 'ambiguous-database'
  | 'unsafe-path'
  | 'pragma-mismatch'
  | 'database-busy'
  | 'durability-unavailable'
  | 'database-closed'
  | 'database-io';

export class InventoryV1OpenError extends Error {
  constructor(
    readonly code: InventoryV1OpenErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'InventoryV1OpenError';
  }
}

class InventoryV1TargetCloseError extends InventoryV1OpenError {
  constructor(
    readonly target: DatabaseSyncV1,
    readonly reason: InventoryV1TargetCloseReason,
    cause: unknown,
  ) {
    super(
      'database-io',
      `failed to close the RFC-64 inventory target during ${reason}; the DK6L lease remains held in fail-stop`,
      { cause },
    );
    this.name = 'InventoryV1TargetCloseError';
  }
}

export interface Rfc64InventoryV1Foundation extends Rfc64InventoryV1CandidateApi {
  readonly databasePath: string;
  readonly closed: boolean;
  quarantineAndRebuild(): void;
  close(): void;
}

export interface InventoryV1OpenOptions {
  /**
   * Explicit deployment attestation for namespace quarantine. Omit this for
   * the fail-closed default. Fresh and valid databases do not need it.
   */
  readonly quarantineCapability?: InventoryV1QuarantineCapability;
}

export { INVENTORY_V1_POSIX_QUARANTINE_CAPABILITY };
export type { InventoryV1QuarantineCapability };

export async function openInventoryV1(
  dataDir: string,
  options: InventoryV1OpenOptions = {},
): Promise<Rfc64InventoryV1Foundation> {
  return openInventoryV1WithLifecycleAdapter(
    dataDir,
    createProductionInventoryV1LifecycleAdapter(
      options.quarantineCapability ?? null,
    ),
  );
}

/** @internal Source-test utility; not exported from the package entry point. */
export interface InventoryV1TestOpenerIo {
  readonly quarantineCapability?: InventoryV1QuarantineCapability | null;
  readonly boundary?: (boundary: InventoryV1QuarantineBoundary) => void;
  readonly closeTarget?: (
    close: () => void,
    reason: InventoryV1TargetCloseReason,
  ) => void;
}

/** @internal Source-test utility; not exported from the package entry point. */
export type InventoryV1TestOpener = (
  dataDir: string,
) => Promise<Rfc64InventoryV1Foundation>;

/**
 * Test-only lifecycle seam. This symbol is deliberately omitted from the
 * package entry point; direct source tests must also remain in NODE_ENV=test
 * for factory creation, every open, and every callback invocation.
 * @internal
 */
export function createInventoryV1TestOpener(
  io: InventoryV1TestOpenerIo = {},
): InventoryV1TestOpener {
  assertInventoryV1TestEnvironment();
  const quarantineCapability = io.quarantineCapability ?? null;
  const boundaryCallback = io.boundary;
  const closeTargetCallback = io.closeTarget;
  const lifecycle = Object.freeze({
    get quarantineCapability(): InventoryV1QuarantineCapability | null {
      return process.env.NODE_ENV === 'test'
        ? quarantineCapability
        : null;
    },
    boundary(boundary: InventoryV1QuarantineBoundary): void {
      if (process.env.NODE_ENV === 'test') boundaryCallback?.(boundary);
    },
    closeTarget(close: () => void, reason: InventoryV1TargetCloseReason): void {
      if (process.env.NODE_ENV === 'test' && closeTargetCallback !== undefined) {
        closeTargetCallback(close, reason);
        return;
      }
      close();
    },
  }) satisfies InventoryV1LifecycleAdapter;
  return async (dataDir: string): Promise<Rfc64InventoryV1Foundation> => {
    assertInventoryV1TestEnvironment();
    return openInventoryV1WithLifecycleAdapter(dataDir, lifecycle);
  };
}

function assertInventoryV1TestEnvironment(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new InventoryV1OpenError(
      'database-io',
      'RFC-64 inventory lifecycle test injection is unavailable outside NODE_ENV=test',
    );
  }
}

async function openInventoryV1WithLifecycleAdapter(
  dataDir: string,
  lifecycle: InventoryV1LifecycleAdapter,
): Promise<Rfc64InventoryV1Foundation> {
  if (!Object.isFrozen(lifecycle)) {
    throw new InventoryV1OpenError(
      'database-io',
      'RFC-64 inventory lifecycle adapter must be immutable',
    );
  }
  const sqlite = await loadSqliteModule();
  const resolvedDataDir = resolve(dataDir);
  const databasePath = resolve(resolvedDataDir, INVENTORY_V1_RELATIVE_PATH);
  let lease: InventoryV1Lease | null = null;
  try {
    if (pathEntryExists(recoveryMarkerPath(databasePath))) {
      preflightExistingRecoveryMarker(resolvedDataDir, databasePath);
    }
    prepareSecureDirectory(resolvedDataDir, dirname(databasePath));
    rejectOrphanedSqliteSidecars(
      inventoryLeasePath(databasePath),
      'inventory lifetime lease',
    );
    // A pending recovery marker owns target-side evidence and must be parsed
    // before classifying its source topology. Without such a marker, reject
    // every orphan sidecar before creating even the independent lease unit so
    // opening cannot mutate the directory around ambiguous evidence.
    if (!pathEntryExists(recoveryMarkerPath(databasePath))) {
      rejectOrphanedSqliteSidecars(databasePath, 'inventory database');
    }
    lease = await acquireInventoryLease(sqlite, databasePath);
    finishPendingQuarantine(sqlite, databasePath, lifecycle);
    const database = openOrRebuildOwnedDatabase(sqlite, databasePath, lifecycle);
    return new InventoryV1Foundation(sqlite, databasePath, database, lease, lifecycle);
  } catch (cause) {
    if (cause instanceof InventoryV1TargetCloseError && lease !== null) {
      retainInventoryFailStop(lease, cause);
      lease = null;
      throw cause;
    }
    releaseInventoryLease(lease);
    if (cause instanceof InventoryV1OpenError) throw cause;
    throw new InventoryV1OpenError(
      'database-io',
      'failed to prepare or open the RFC-64 inventory database',
      { cause },
    );
  }
}

class InventoryV1Foundation implements Rfc64InventoryV1Foundation {
  #database: DatabaseSyncV1 | null;
  #candidate: CandidateInventoryV1;
  #lease: InventoryV1Lease | null;

  constructor(
    private readonly sqlite: SqliteModuleV1,
    readonly databasePath: string,
    database: DatabaseSyncV1,
    lease: InventoryV1Lease,
    private readonly lifecycle: InventoryV1LifecycleAdapter,
  ) {
    this.#database = database;
    this.#candidate = this.createCandidateInventory(database);
    this.#lease = lease;
  }

  get closed(): boolean {
    return this.#database === null;
  }

  quarantineAndRebuild(): void {
    const database = this.requireOpen();
    assertQuarantineDurabilityAvailable(this.lifecycle);
    assertDatabaseQuiescent(database, this.lifecycle);
    this.#candidate.close();
    try {
      closeInventoryTarget(database, 'explicit-quarantine', this.lifecycle);
    } catch (error) {
      this.retainFailStop(error);
    }
    this.#database = null;
    try {
      const freshMarker = beginQuarantine(this.databasePath, this.lifecycle);
      finishPendingQuarantine(
        this.sqlite,
        this.databasePath,
        this.lifecycle,
        freshMarker,
      );
      this.#database = openOrRebuildOwnedDatabase(
        this.sqlite,
        this.databasePath,
        this.lifecycle,
      );
      this.#candidate = this.createCandidateInventory(this.#database);
    } catch (error) {
      if (error instanceof InventoryV1TargetCloseError) this.retainFailStop(error);
      this.releaseLease();
      if (error instanceof InventoryV1OpenError) throw error;
      throw new InventoryV1OpenError(
        'database-io',
        'failed to quarantine and rebuild the RFC-64 inventory database',
        { cause: error },
      );
    }
  }

  close(): void {
    this.#candidate.close();
    const database = this.#database;
    if (database !== null) {
      try {
        closeInventoryTarget(database, 'foundation-close', this.lifecycle);
      } catch (error) {
        this.retainFailStop(error);
      }
      this.#database = null;
    }
    this.releaseLease();
  }

  createCandidateSession(): CandidateSessionV1 {
    this.requireOpen();
    return this.#candidate.createCandidateSession();
  }

  purgeNextStartupStaleCandidateBatch(): CandidateSessionGcBatchResultV1 {
    this.requireOpen();
    return this.#candidate.purgeNextStartupStaleCandidateBatch();
  }

  putVerifiedCandidateBucket(load: VerifiedCandidateBucketLoadV1): CandidateBucketPutResultV1 {
    this.requireOpen();
    return this.#candidate.putVerifiedCandidateBucket(load);
  }

  getCandidateBucket(loadKey: CandidateBucketLoadKeyV1): CandidateBucketHeaderV1 {
    this.requireOpen();
    return this.#candidate.getCandidateBucket(loadKey);
  }

  beginCandidateBucketRows(loadKey: CandidateBucketLoadKeyV1): CandidateBucketRowsTraversalV1 {
    this.requireOpen();
    return this.#candidate.beginCandidateBucketRows(loadKey);
  }

  beginCandidateBucketDiff(
    oldLoadKey: CandidateBucketLoadKeyV1,
    newLoadKey: CandidateBucketLoadKeyV1,
  ): CandidateBucketDiffTraversalV1 {
    this.requireOpen();
    return this.#candidate.beginCandidateBucketDiff(oldLoadKey, newLoadKey);
  }

  pageCandidateBucketRows(
    traversal: CandidateBucketRowsTraversalV1,
    cursor: KaIdV1 | null | undefined,
    limit: number,
  ): CandidateBucketPageV1 {
    this.requireOpen();
    return this.#candidate.pageCandidateBucketRows(traversal, cursor, limit);
  }

  pageCandidateBucketAddedOrChanged(
    traversal: CandidateBucketDiffTraversalV1,
    cursor: KaIdV1 | null | undefined,
    limit: number,
  ): CandidateBucketPageV1 {
    this.requireOpen();
    return this.#candidate.pageCandidateBucketAddedOrChanged(traversal, cursor, limit);
  }

  pageCandidateBucketRemoved(
    traversal: CandidateBucketDiffTraversalV1,
    cursor: KaIdV1 | null | undefined,
    limit: number,
  ): CandidateBucketPageV1 {
    this.requireOpen();
    return this.#candidate.pageCandidateBucketRemoved(traversal, cursor, limit);
  }

  readVerifiedCandidateCatalogRow(
    verifiedRow: VerifiedCandidateCatalogRowV1,
  ): CandidateBucketRowSnapshotV1 {
    this.requireOpen();
    return this.#candidate.readVerifiedCandidateCatalogRow(verifiedRow);
  }

  verifyCandidateCatalogPrecommitV1(
    verifiedRow: VerifiedCandidateCatalogRowV1,
    signedHead: SignedAuthorCatalogHeadEnvelopeV1,
    receivedBundleBytes: Uint8Array,
    deployment: CatalogSealDeploymentProfileV1,
    limits?: CgSharedProjectionVerificationLimitsV1,
  ): CandidateCatalogPrecommitResultV1 {
    this.requireOpen();
    return this.#candidate.verifyCandidateCatalogPrecommitV1(
      verifiedRow,
      signedHead,
      receivedBundleBytes,
      deployment,
      limits,
    );
  }

  closeCandidateTraversal(
    traversal: CandidateBucketRowsTraversalV1 | CandidateBucketDiffTraversalV1,
  ): void {
    this.requireOpen();
    this.#candidate.closeCandidateTraversal(traversal);
  }

  discardCandidateSessionBatch(
    session: CandidateSessionV1,
  ): CandidateSessionGcBatchResultV1 {
    this.requireOpen();
    return this.#candidate.discardCandidateSessionBatch(session);
  }

  deleteCandidateBucket(loadKey: CandidateBucketLoadKeyV1): void {
    this.requireOpen();
    this.#candidate.deleteCandidateBucket(loadKey);
  }

  private requireOpen(): DatabaseSyncV1 {
    if (this.#database === null) {
      throw new InventoryV1OpenError('database-closed', 'inventory database is closed');
    }
    return this.#database;
  }

  private createCandidateInventory(database: DatabaseSyncV1): CandidateInventoryV1 {
    return new CandidateInventoryV1(
      database,
      (currentDatabase) => {
        if (this.#database !== currentDatabase) {
          throw new InventoryV1OpenError(
            'database-closed',
            'candidate inventory low-level handle no longer owns the live foundation connection',
          );
        }
        // Detach before close so no rejection path can expose a stale closed
        // target through the foundation. DK6L remains held across the reopen.
        this.#database = null;
        try {
          closeInventoryTarget(currentDatabase, 'failed-open-cleanup', this.lifecycle);
        } catch (error) {
          this.retainFailStop(error);
        }
        try {
          const reopened = reopenVerifiedOwnedDatabase(
            this.sqlite,
            this.databasePath,
            this.lifecycle,
          );
          this.#database = reopened;
          return reopened;
        } catch (cause) {
          if (cause instanceof InventoryV1TargetCloseError) this.retainFailStop(cause);
          // Never quarantine, rebuild, or manufacture a candidate outcome on the
          // latency/indeterminate-COMMIT path. The live foundation stays closed.
          throw new InventoryV1OpenError(
            'database-io',
            'failed to verify and reopen the existing RFC-64 inventory database',
            { cause },
          );
        }
      },
      undefined,
      (rejectedDatabase) => {
        // Candidate validation happens after the provider returns. Detach the
        // adopted replacement before closing it so `closed` and requireOpen()
        // cannot observe a stale closed DatabaseSync handle.
        if (this.#database === rejectedDatabase) this.#database = null;
        try {
          closeInventoryTarget(rejectedDatabase, 'failed-open-cleanup', this.lifecycle);
        } catch (error) {
          this.retainFailStop(error);
        }
      },
    );
  }

  private releaseLease(): void {
    releaseInventoryLease(this.#lease);
    this.#lease = null;
  }

  private retainFailStop(error: unknown): never {
    if (!(error instanceof InventoryV1TargetCloseError)) throw error;
    if (this.#lease !== null) {
      retainInventoryFailStop(this.#lease, error);
      this.#lease = null;
    }
    throw error;
  }
}

function reopenVerifiedOwnedDatabase(
  sqlite: SqliteModuleV1,
  databasePath: string,
  lifecycle: InventoryV1LifecycleAdapter,
): DatabaseSyncV1 {
  rejectOwnedFileSymlinks(databasePath);
  rejectOrphanedSqliteSidecars(databasePath, 'inventory database');
  if (!existsSync(databasePath)) {
    throw new InventoryV1OpenError(
      'database-io',
      'inventory database disappeared before verified low-level reopen',
    );
  }
  assertOwnedUnitOwners(databasePath);
  assertExistingTargetHeader(databasePath);

  let database: DatabaseSyncV1 | null = null;
  try {
    database = new sqlite.DatabaseSync(databasePath);
    assertCommittedTargetIdentity(readIdentity(database));
    verifyOwnedSchema(database);
    applyAndVerifyPragmas(database);
    verifyOwnedSchema(database);
    tightenOwnedFileMode(databasePath);
    return database;
  } catch (cause) {
    if (database !== null) {
      closeInventoryTarget(database, 'failed-open-cleanup', lifecycle);
      database = null;
    }
    if (cause instanceof InventoryV1OpenError) throw cause;
    if (isBusySqliteError(cause)) {
      throw new InventoryV1OpenError(
        'database-busy',
        'inventory database is busy during verified low-level reopen',
        { cause },
      );
    }
    throw new InventoryV1OpenError(
      'database-io',
      'failed to verify the existing inventory database during low-level reopen',
      { cause },
    );
  }
}

/** @internal Proves that the exact live foundation owns the lease for dataDir. */
export function inventoryV1OwnsDataDir(
  inventory: unknown,
  dataDir: string,
): inventory is Rfc64InventoryV1Foundation {
  return inventory instanceof InventoryV1Foundation
    && !inventory.closed
    && typeof dataDir === 'string'
    && dataDir.length > 0
    && inventory.databasePath
      === resolve(resolve(dataDir), INVENTORY_V1_RELATIVE_PATH);
}

async function loadSqliteModule(): Promise<SqliteModuleV1> {
  try {
    const moduleName = 'node:sqlite';
    return await import(moduleName);
  } catch (cause) {
    throw new InventoryV1OpenError(
      'sqlite-unavailable',
      'RFC-64 SQL-1 requires Node runtime support for node:sqlite',
      { cause },
    );
  }
}

interface InventoryV1Lease {
  readonly database: DatabaseSyncV1;
}

interface InventoryV1FailStopResources {
  readonly lease: InventoryV1Lease;
  readonly targetCloseError: InventoryV1TargetCloseError;
}

// A target close failure is an in-process fail-stop. Keeping both handles
// strongly reachable prevents GC from silently releasing either side of the
// ownership pair and admitting a second conforming adapter after an ambiguous
// target teardown.
const RETAINED_INVENTORY_FAIL_STOPS = new Set<InventoryV1FailStopResources>();

function retainInventoryFailStop(
  lease: InventoryV1Lease,
  targetCloseError: InventoryV1TargetCloseError,
): void {
  RETAINED_INVENTORY_FAIL_STOPS.add({ lease, targetCloseError });
}

function closeInventoryTarget(
  target: DatabaseSyncV1,
  reason: InventoryV1TargetCloseReason,
  lifecycle: InventoryV1LifecycleAdapter,
): void {
  try {
    lifecycle.closeTarget(() => target.close(), reason);
  } catch (cause) {
    if (cause instanceof InventoryV1TargetCloseError) throw cause;
    throw new InventoryV1TargetCloseError(target, reason, cause);
  }
}

function inventoryLeasePath(databasePath: string): string {
  return join(dirname(databasePath), LEASE_DATABASE_NAME);
}

async function acquireInventoryLease(
  sqlite: SqliteModuleV1,
  databasePath: string,
): Promise<InventoryV1Lease> {
  const path = inventoryLeasePath(databasePath);
  const existedAtEntry = pathEntryExists(path);
  if (!existedAtEntry) {
    rejectOrphanedSqliteSidecars(path, 'inventory lifetime lease');
  }
  let createdByThisOpen = false;
  if (existedAtEntry) {
    assertLeaseUnitOwnersAndTypes(path);
    assertCommittedLeaseHeaderBeforeOpen(path);
  } else {
    try {
      createSecureEmptyFile(path);
      createdByThisOpen = true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
      // Only an opener that lost this exact wx race may briefly wait for the
      // winner to publish a committed DK6L/v1 header. A lease that existed at
      // entry never gets this grace period: headerless and zero/zero remnants
      // fail closed for offline removal.
      await waitForCommittedRacingLease(path);
    }
  }
  applySecurePermissions(path, INVENTORY_V1_FILE_MODE, false);

  let database: DatabaseSyncV1 | null = null;
  let transactionOpen = false;
  try {
    database = new sqlite.DatabaseSync(path);
    database.exec(`
      PRAGMA busy_timeout = 0;
      PRAGMA synchronous = FULL;
      PRAGMA locking_mode = EXCLUSIVE;
    `);
    const journalMode = database.prepare(
      createdByThisOpen ? 'PRAGMA journal_mode = DELETE' : 'PRAGMA journal_mode',
    ).get();
    if (
      journalMode === undefined
      || String(journalMode.journal_mode).toLowerCase() !== 'delete'
    ) {
      throw new InventoryV1OpenError(
        'ambiguous-database',
        'inventory lifetime lease must use SQLite rollback-journal mode',
      );
    }
    database.exec('BEGIN EXCLUSIVE');
    transactionOpen = true;
    const identity = readIdentity(database);
    if (createdByThisOpen) {
      if (!isFreshIdentity(identity) || identity.userObjects.length !== 0) {
        throw new InventoryV1OpenError(
          'ambiguous-database',
          'new inventory lease lost its pristine identity before initialization',
        );
      }
      database.exec(`
        PRAGMA application_id = ${LEASE_APPLICATION_ID};
        PRAGMA user_version = ${LEASE_USER_VERSION};
        COMMIT;
        BEGIN EXCLUSIVE;
      `);
    } else {
      assertLeaseIdentity(identity);
    }
    assertLeaseIdentity(readIdentity(database));
    verifyLeasePragmas(database);
    if (!database.isTransaction) {
      throw new InventoryV1OpenError(
        'database-io',
        'inventory lifetime lease lost its exclusive transaction before publication',
      );
    }
    tightenOwnedFileMode(path);
    return { database };
  } catch (cause) {
    if (transactionOpen) {
      try { database?.exec('ROLLBACK'); } catch { /* retain the lease acquisition failure */ }
    }
    try { database?.close(); } catch { /* retain the lease acquisition failure */ }
    if (cause instanceof InventoryV1OpenError) throw cause;
    if (isBusySqliteError(cause)) {
      throw new InventoryV1OpenError(
        'database-busy',
        'another process holds the RFC-64 inventory lifetime lease',
        { cause },
      );
    }
    if (isCorruptSqliteError(cause)) {
      const identity = readValidSqliteHeaderIdentity(path);
      if (identity?.applicationId === LEASE_APPLICATION_ID && identity.userVersion > LEASE_USER_VERSION) {
        throw new InventoryV1OpenError(
          'newer-schema',
          'corrupt inventory lease has a newer user_version and will not be modified',
          { cause },
        );
      }
      if (identity !== null && identity.applicationId !== 0 && identity.applicationId !== LEASE_APPLICATION_ID) {
        throw new InventoryV1OpenError(
          'foreign-database',
          'corrupt inventory lease has a foreign application_id and will not be modified',
          { cause },
        );
      }
      throw new InventoryV1OpenError(
        'ambiguous-database',
        'corrupt inventory lifetime lease will not be modified or quarantined',
        { cause },
      );
    }
    throw new InventoryV1OpenError(
      'database-io',
      'failed to acquire the RFC-64 inventory lifetime lease',
      { cause },
    );
  }
}

function assertLeaseUnitOwnersAndTypes(path: string): void {
  for (const suffix of LEASE_FILE_SUFFIXES) {
    const member = `${path}${suffix}`;
    if (!pathEntryExists(member)) continue;
    assertOwnedRegularFile(member, `inventory lifetime lease${suffix}`);
  }
  for (const suffix of ['-wal', '-shm'] as const) {
    const member = `${path}${suffix}`;
    if (!pathEntryExists(member)) continue;
    assertOwnedRegularFile(member, `inventory lifetime lease${suffix}`);
    throw new InventoryV1OpenError(
      'ambiguous-database',
      'inventory lifetime lease has unexpected WAL sidecars and will not be modified',
    );
  }
}

function assertCommittedLeaseHeaderBeforeOpen(path: string): void {
  const identity = readValidSqliteHeaderIdentity(path);
  if (identity === null) {
    throw new InventoryV1OpenError(
      'ambiguous-database',
      'pre-existing headerless inventory lifetime lease will not be initialized or modified',
    );
  }
  if (identity.applicationId !== LEASE_APPLICATION_ID) {
    throw new InventoryV1OpenError(
      identity.applicationId === 0 ? 'ambiguous-database' : 'foreign-database',
      'inventory lifetime lease application_id is not the frozen DK6L identity',
    );
  }
  if (identity.userVersion > LEASE_USER_VERSION) {
    throw new InventoryV1OpenError(
      'newer-schema',
      'inventory lifetime lease user_version is newer than supported version 1',
    );
  }
  if (identity.userVersion !== LEASE_USER_VERSION) {
    throw new InventoryV1OpenError(
      'ambiguous-database',
      'inventory lifetime lease is not a committed v1 lease',
    );
  }
}

async function waitForCommittedRacingLease(path: string): Promise<void> {
  const deadline = Date.now() + LEASE_CREATION_RACE_TIMEOUT_MS;
  while (true) {
    assertLeaseUnitOwnersAndTypes(path);
    const identity = readValidSqliteHeaderIdentity(path);
    if (
      identity?.applicationId === LEASE_APPLICATION_ID
      && identity.userVersion === LEASE_USER_VERSION
    ) {
      return;
    }
    if (
      identity !== null
      && (
        identity.applicationId !== 0
        || identity.userVersion !== 0
      )
    ) {
      assertCommittedLeaseHeaderBeforeOpen(path);
    }
    if (Date.now() >= deadline) {
      throw new InventoryV1OpenError(
        'ambiguous-database',
        'racing lease creator did not publish a committed DK6L/v1 identity',
      );
    }
    await delay(LEASE_CREATION_RACE_RETRY_MS);
  }
}

function assertLeaseIdentity(identity: DatabaseIdentityV1): void {
  if (identity.applicationId !== LEASE_APPLICATION_ID) {
    throw new InventoryV1OpenError(
      identity.applicationId === 0 ? 'ambiguous-database' : 'foreign-database',
      'inventory lifetime lease application_id is not the frozen DK6L identity',
    );
  }
  if (identity.userVersion > LEASE_USER_VERSION) {
    throw new InventoryV1OpenError(
      'newer-schema',
      'inventory lifetime lease user_version is newer than supported version 1',
    );
  }
  if (identity.userVersion !== LEASE_USER_VERSION || identity.userObjects.length !== 0) {
    throw new InventoryV1OpenError(
      'ambiguous-database',
      'inventory lifetime lease schema is not the frozen empty v1 schema',
    );
  }
}

function verifyLeasePragmas(database: DatabaseSyncV1): void {
  const journalMode = database.prepare('PRAGMA journal_mode').get();
  const lockingMode = database.prepare('PRAGMA locking_mode').get();
  if (String(journalMode?.journal_mode).toLowerCase() !== 'delete') {
    throw new InventoryV1OpenError('pragma-mismatch', 'inventory lease refused journal_mode=DELETE');
  }
  if (String(lockingMode?.locking_mode).toLowerCase() !== 'exclusive') {
    throw new InventoryV1OpenError('pragma-mismatch', 'inventory lease refused locking_mode=EXCLUSIVE');
  }
  if (readPragmaInteger(database, 'synchronous') !== 2) {
    throw new InventoryV1OpenError('pragma-mismatch', 'inventory lease refused synchronous=FULL');
  }
  if (readPragmaInteger(database, 'busy_timeout') !== 0) {
    throw new InventoryV1OpenError('pragma-mismatch', 'inventory lease refused busy_timeout=0');
  }
}

function releaseInventoryLease(lease: InventoryV1Lease | null): void {
  if (lease === null) return;
  try {
    lease.database.exec('ROLLBACK');
  } finally {
    lease.database.close();
  }
}

function openOrRebuildOwnedDatabase(
  sqlite: SqliteModuleV1,
  databasePath: string,
  lifecycle: InventoryV1LifecycleAdapter,
): DatabaseSyncV1 {
  rejectOwnedFileSymlinks(databasePath);
  rejectOrphanedSqliteSidecars(databasePath, 'inventory database');
  const created = !existsSync(databasePath);
  if (created) {
    createSecureEmptyFile(databasePath);
  } else {
    assertOwnedUnitOwners(databasePath);
    assertTargetJournalModeCoherence(databasePath);
    assertExistingTargetHeader(databasePath);
  }

  let database: DatabaseSyncV1 | null = null;
  try {
    // Keep SQL-1 on the original Node 22.5 node:sqlite surface. Loading
    // extensions is disabled by default; every statement below is fixed SQL,
    // so double-quoted-string compatibility cannot affect parsing.
    database = new sqlite.DatabaseSync(databasePath);

    if (created) {
      tightenOwnedFileMode(databasePath);
      initializeFreshDatabase(database, databasePath);
      verifyOwnedSchema(database);
      applyAndVerifyPragmas(database);
      tightenOwnedFileMode(databasePath);
      return database;
    }

    // Existing exact-owned targets receive identity, schema, and FK reads
    // before any target PRAGMA assignment. This no-create classifier must not
    // convert or "repair" a pre-existing unit merely by opening it.
    const identity = readIdentity(database);
    assertCommittedTargetIdentity(identity);
    try {
      verifyOwnedSchema(database);
    } catch (error) {
      if (!(error instanceof OwnedInventoryV1SchemaError)) throw error;
      // Eligibility is a precondition for even the zero-timeout/checkpoint
      // quarantine proof. In particular, do not checkpoint or truncate a
      // crashed WAL on a deployment that cannot durably rename the namespace.
      assertQuarantineDurabilityAvailable(lifecycle);
      assertDatabaseQuiescent(database, lifecycle);
      closeInventoryTarget(database, 'automatic-schema-quarantine', lifecycle);
      database = null;
      const freshMarker = beginQuarantine(databasePath, lifecycle);
      finishPendingQuarantine(sqlite, databasePath, lifecycle, freshMarker);
      return openOrRebuildOwnedDatabase(sqlite, databasePath, lifecycle);
    }
    applyAndVerifyPragmas(database);
    tightenOwnedFileMode(databasePath);
    return database;
  } catch (error) {
    const closeProbe = (): void => {
      if (database === null) return;
      closeInventoryTarget(database, 'failed-open-cleanup', lifecycle);
      database = null;
    };
    if (error instanceof InventoryV1TargetCloseError) throw error;
    if (error instanceof InventoryV1OpenError) {
      closeProbe();
      throw error;
    }
    if (isCorruptSqliteError(error)) {
      let ownership: CorruptDatabaseOwnershipV1;
      try {
        ownership = classifyCorruptDatabaseOwnership(databasePath);
      } catch (cause) {
        closeProbe();
        throw cause;
      }
      if (ownership === 'ambiguous') {
        closeProbe();
        throw new InventoryV1OpenError(
          'ambiguous-database',
          'corrupt database does not have a readable DK64 ownership identity and will not be modified',
          { cause: error },
        );
      }
      if (ownership === 'newer') {
        closeProbe();
        throw new InventoryV1OpenError(
          'newer-schema',
          'corrupt DK64 database has a newer user_version and will not be modified',
          { cause: error },
        );
      }
      if (ownership === 'foreign') {
        closeProbe();
        throw new InventoryV1OpenError(
          'foreign-database',
          'corrupt SQLite database has a foreign application_id and will not be modified',
          { cause: error },
        );
      }
      if (database === null) {
        throw new InventoryV1OpenError(
          'database-io',
          'cannot prove exclusive access to the corrupt DK64 database; it will not be quarantined',
          { cause: error },
        );
      }
      // Refuse before BEGIN EXCLUSIVE or wal_checkpoint(TRUNCATE) can alter a
      // corrupt unit on an uncertified deployment. The ordinary cleanup close
      // may still perform SQLite's normal recovery, which the RFC permits.
      try {
        assertQuarantineDurabilityAvailable(lifecycle);
      } catch (cause) {
        closeProbe();
        throw cause;
      }
      try {
        assertCorruptDatabaseQuiescent(database, lifecycle);
      } catch (cause) {
        closeProbe();
        if (cause instanceof InventoryV1OpenError) throw cause;
        throw new InventoryV1OpenError(
          'database-io',
          'cannot prove exclusive access to the corrupt DK64 database; it will not be quarantined',
          { cause },
        );
      }
      closeInventoryTarget(database, 'automatic-corrupt-quarantine', lifecycle);
      database = null;
      const freshMarker = beginQuarantine(databasePath, lifecycle);
      finishPendingQuarantine(sqlite, databasePath, lifecycle, freshMarker);
      return openOrRebuildOwnedDatabase(sqlite, databasePath, lifecycle);
    }
    closeProbe();
    if (isBusySqliteError(error)) {
      throw new InventoryV1OpenError(
        'database-busy',
        'inventory database is busy or locked and will not be quarantined',
        { cause: error },
      );
    }
    throw new InventoryV1OpenError(
      'database-io',
      created ? 'failed to initialize RFC-64 inventory database' : 'failed to open RFC-64 inventory database',
      { cause: error },
    );
  }
}

function assertTargetJournalModeCoherence(databasePath: string): void {
  if (
    pathEntryExists(`${databasePath}-journal`)
    && (
      pathEntryExists(`${databasePath}-wal`)
      || pathEntryExists(`${databasePath}-shm`)
    )
  ) {
    throw new InventoryV1OpenError(
      'ambiguous-database',
      'inventory target mixes rollback-journal and WAL evidence and will not be opened or modified',
    );
  }
}

function assertExistingTargetHeader(databasePath: string): void {
  const identity = readValidSqliteHeaderIdentity(databasePath);
  if (identity === null || identity.applicationId === 0) {
    throw new InventoryV1OpenError(
      'ambiguous-database',
      'pre-existing inventory database lacks the committed DK64 identity and will not be opened',
    );
  }
  if (identity.applicationId !== INVENTORY_V1_APPLICATION_ID) {
    throw new InventoryV1OpenError(
      'foreign-database',
      'database header has a foreign application_id and will not be opened or modified',
    );
  }
  if (identity.userVersion > INVENTORY_V1_USER_VERSION) {
    throw new InventoryV1OpenError(
      'newer-schema',
      `inventory user_version ${identity.userVersion} is newer than supported version 1`,
    );
  }
  if (identity.userVersion !== INVENTORY_V1_USER_VERSION) {
    throw new InventoryV1OpenError(
      'ambiguous-database',
      `inventory application_id is DK64 but user_version ${identity.userVersion} is not committed v1`,
    );
  }
}

function assertCommittedTargetIdentity(identity: DatabaseIdentityV1): void {
  if (
    identity.applicationId !== INVENTORY_V1_APPLICATION_ID
    || identity.userVersion !== INVENTORY_V1_USER_VERSION
  ) {
    throw new InventoryV1OpenError(
      'ambiguous-database',
      'inventory identity changed after the no-create header preflight',
    );
  }
}

interface DatabaseIdentityV1 {
  applicationId: number;
  userVersion: number;
  userObjects: Array<{ name: string; sql: string | null }>;
}

function readIdentity(database: DatabaseSyncV1): DatabaseIdentityV1 {
  return {
    applicationId: readPragmaInteger(database, 'application_id'),
    userVersion: readPragmaInteger(database, 'user_version'),
    userObjects: database.prepare(
      `SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).all().map((row) => ({
      name: assertString(row.name, 'sqlite_schema.name'),
      sql: row.sql === null ? null : assertString(row.sql, 'sqlite_schema.sql'),
    })),
  };
}

function isFreshIdentity(identity: DatabaseIdentityV1): boolean {
  return identity.applicationId === 0 && identity.userVersion === 0;
}

function schemaMatches(objects: DatabaseIdentityV1['userObjects']): boolean {
  if (objects.length !== Object.keys(INVENTORY_V1_USER_OBJECTS).length) return false;
  return objects.every((object) => {
    const expected = INVENTORY_V1_USER_OBJECTS[object.name];
    return expected !== undefined
      && object.sql !== null
      && normalizeInventoryV1SchemaSql(object.sql) === expected;
  });
}

function initializeFreshDatabase(database: DatabaseSyncV1, databasePath: string): void {
  const journalMode = database.prepare('PRAGMA journal_mode = DELETE').get();
  database.exec(`
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
  `);
  if (String(journalMode?.journal_mode).toLowerCase() !== 'delete') {
    throw new InventoryV1OpenError(
      'pragma-mismatch',
      'new inventory database refused rollback-journal bootstrap mode',
    );
  }
  if (readPragmaInteger(database, 'synchronous') !== 2) {
    throw new InventoryV1OpenError('pragma-mismatch', 'new inventory database refused synchronous=FULL');
  }
  if (readPragmaInteger(database, 'busy_timeout') !== 5000) {
    throw new InventoryV1OpenError('pragma-mismatch', 'new inventory database refused busy_timeout=5000');
  }

  let transactionOpen = false;
  try {
    database.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const identity = readIdentity(database);
    if (!isFreshIdentity(identity) || identity.userObjects.length !== 0) {
      throw new InventoryV1OpenError(
        'ambiguous-database',
        'new inventory file lost its pristine identity before initialization',
      );
    }
    database.exec(INVENTORY_V1_DDL);
    database.exec(`PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID}`);
    database.exec(`PRAGMA user_version = ${INVENTORY_V1_USER_VERSION}`);
    database.exec('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try { database.exec('ROLLBACK'); } catch { /* retain the initialization error */ }
    }
    throw error;
  }

  // Publish the committed DK64/v1 identity through the rollback-journal main
  // file before WAL is ever enabled. A crash therefore cannot leave a valid
  // identity that is visible only through an uncheckpointed WAL.
  fsyncRegularFile(databasePath, 'new inventory database');
  fsyncDirectory(dirname(databasePath));
  const committed = readValidSqliteHeaderIdentity(databasePath);
  if (
    committed?.applicationId !== INVENTORY_V1_APPLICATION_ID
    || committed.userVersion !== INVENTORY_V1_USER_VERSION
  ) {
    throw new InventoryV1OpenError(
      'database-io',
      'committed inventory database identity was not durable in the raw main header',
    );
  }
}

class OwnedInventoryV1SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnedInventoryV1SchemaError';
  }
}

function verifyOwnedSchema(database: DatabaseSyncV1): void {
  const identity = readIdentity(database);
  if (
    identity.applicationId !== INVENTORY_V1_APPLICATION_ID
    || identity.userVersion !== INVENTORY_V1_USER_VERSION
    || !schemaMatches(identity.userObjects)
  ) {
    throw new OwnedInventoryV1SchemaError('RFC-64 inventory schema verification failed');
  }
  const foreignKeyRows = database.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyRows.length !== 0) {
    throw new OwnedInventoryV1SchemaError('RFC-64 inventory foreign-key check failed');
  }
}

function assertDatabaseQuiescent(
  database: DatabaseSyncV1,
  lifecycle: InventoryV1LifecycleAdapter,
): void {
  let transactionOpen = false;
  try {
    database.exec('PRAGMA busy_timeout = 0');
    const checkpoint = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    const busy = checkpoint?.busy;
    if (typeof busy !== 'number' || busy !== 0) {
      throw new InventoryV1OpenError(
        busy === 1 ? 'database-busy' : 'database-io',
        busy === 1
          ? 'inventory database has active WAL readers and will not be quarantined'
          : 'SQLite returned an invalid WAL checkpoint result',
      );
    }
    database.exec('BEGIN EXCLUSIVE');
    transactionOpen = true;
    database.exec('ROLLBACK');
    transactionOpen = false;
    // A conforming contender must still be fenced by the independently held
    // DK6L lease in the interval after this target proof releases its target
    // lock and before quarantine namespace mutation starts.
    lifecycle.boundary('target-exclusivity-proven');
  } catch (cause) {
    if (transactionOpen) {
      try { database.exec('ROLLBACK'); } catch { /* retain the quiescence failure */ }
    }
    if (cause instanceof InventoryV1OpenError) throw cause;
    if (isBusySqliteError(cause)) {
      throw new InventoryV1OpenError(
        'database-busy',
        'inventory database is busy and will not be quarantined',
        { cause },
      );
    }
    throw new InventoryV1OpenError(
      'database-io',
      'could not prove exclusive access; inventory database will not be quarantined',
      { cause },
    );
  } finally {
    try { database.exec('PRAGMA busy_timeout = 5000'); } catch { /* best-effort connection restore */ }
  }
}

function assertCorruptDatabaseQuiescent(
  database: DatabaseSyncV1,
  lifecycle: InventoryV1LifecycleAdapter,
): void {
  let transactionOpen = false;
  try {
    // Probe the writer lock before corruption-sensitive schema/checkpoint work
    // so a live WAL writer is reported as busy and is never split from the
    // database file during quarantine.
    database.exec('PRAGMA busy_timeout = 0');
    database.exec('BEGIN EXCLUSIVE');
    transactionOpen = true;
    database.exec('ROLLBACK');
    transactionOpen = false;
  } catch (cause) {
    if (transactionOpen) {
      try { database.exec('ROLLBACK'); } catch { /* retain the probe failure */ }
    }
    if (isBusySqliteError(cause)) {
      throw new InventoryV1OpenError(
        'database-busy',
        'corrupt inventory database has an active writer and will not be quarantined',
        { cause },
      );
    }
    throw new InventoryV1OpenError(
      'database-io',
      'cannot prove exclusive access to the corrupt inventory database; it will not be quarantined',
      { cause },
    );
  } finally {
    try { database.exec('PRAGMA busy_timeout = 5000'); } catch { /* best-effort connection restore */ }
  }
  assertDatabaseQuiescent(database, lifecycle);
}

function applyAndVerifyPragmas(database: DatabaseSyncV1): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_size_limit = 67108864;
  `);
  const journalMode = database.prepare('PRAGMA journal_mode = WAL').get();
  if (journalMode === undefined || String(journalMode.journal_mode).toLowerCase() !== 'wal') {
    throw new InventoryV1OpenError('pragma-mismatch', 'SQLite refused journal_mode=WAL');
  }
  const expected = new Map<string, number>([
    ['foreign_keys', 1],
    ['trusted_schema', 0],
    ['synchronous', 2],
    ['busy_timeout', 5000],
    ['journal_size_limit', 67_108_864],
  ]);
  for (const [pragma, expectedValue] of expected) {
    if (readPragmaInteger(database, pragma) !== expectedValue) {
      throw new InventoryV1OpenError('pragma-mismatch', `SQLite refused PRAGMA ${pragma}=${expectedValue}`);
    }
  }
}

function readPragmaInteger(database: DatabaseSyncV1, pragma: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get();
  if (row === undefined) throw new InventoryV1OpenError('database-io', `PRAGMA ${pragma} returned no row`);
  const value = Object.values(row)[0];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new InventoryV1OpenError('database-io', `PRAGMA ${pragma} returned a non-integer value`);
  }
  return value;
}

function prepareSecureDirectory(dataDirectory: string, directoryPath: string): void {
  const relativeDirectory = relative(dataDirectory, directoryPath);
  if (
    relativeDirectory === '..'
    || relativeDirectory.startsWith(`..${sep}`)
    || isAbsolute(relativeDirectory)
  ) {
    throw new InventoryV1OpenError(
      'unsafe-path',
      'inventory database directory must remain within the declared DKG data directory',
    );
  }

  if (pathEntryExists(dataDirectory)) {
    rejectSymlink(dataDirectory, 'DKG data directory');
    assertFilesystemOwner(dataDirectory);
  } else {
    // The declared data-directory boundary may itself be new. Components above
    // that caller-selected boundary are intentionally outside adapter policy.
    mkdirSync(dataDirectory, { recursive: true, mode: INVENTORY_V1_DIRECTORY_MODE });
    rejectSymlink(dataDirectory, 'DKG data directory');
    assertFilesystemOwner(dataDirectory);
  }

  let currentDirectory = dataDirectory;
  for (const component of relativeDirectory.split(sep).filter((value) => value.length !== 0)) {
    // The current parent was owner-checked before this content mutation.
    const nextDirectory = join(currentDirectory, component);
    if (pathEntryExists(nextDirectory)) {
      rejectSymlink(nextDirectory, 'inventory directory path component');
      assertFilesystemOwner(nextDirectory);
    } else {
      mkdirSync(nextDirectory, { mode: INVENTORY_V1_DIRECTORY_MODE });
      rejectSymlink(nextDirectory, 'inventory directory path component');
      assertFilesystemOwner(nextDirectory);
    }
    currentDirectory = nextDirectory;
  }
  applySecurePermissions(directoryPath, INVENTORY_V1_DIRECTORY_MODE, true);
}

function preflightExistingRecoveryMarker(
  dataDirectory: string,
  databasePath: string,
): void {
  const inventoryDirectory = dirname(databasePath);
  const relativeDirectory = relative(dataDirectory, inventoryDirectory);
  if (
    relativeDirectory === '..'
    || relativeDirectory.startsWith(`..${sep}`)
    || isAbsolute(relativeDirectory)
  ) {
    throw new InventoryV1OpenError(
      'unsafe-path',
      'inventory recovery marker is outside the declared DKG data directory',
    );
  }

  assertOwnedDirectory(dataDirectory, 'DKG data directory');
  let currentDirectory = dataDirectory;
  for (const component of relativeDirectory.split(sep).filter((value) => value.length !== 0)) {
    currentDirectory = join(currentDirectory, component);
    assertOwnedDirectory(currentDirectory, 'inventory directory path component');
  }

  const markerPath = recoveryMarkerPath(databasePath);
  assertOwnedRegularFile(markerPath, 'inventory recovery marker');
  // Parse before chmod, lease creation, SQLite open, lifecycle boundaries, or
  // any recovery namespace mutation. The marker is parsed again under DK6L in
  // finishPendingQuarantine to close the read/lock TOCTOU window.
  parseRecoveryMarker(
    readBoundedRecoveryMarker(markerPath),
    inventoryDirectory,
  );
}

function createSecureEmptyFile(databasePath: string): void {
  const descriptor = openSync(databasePath, 'wx', INVENTORY_V1_FILE_MODE);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  applySecurePermissions(databasePath, INVENTORY_V1_FILE_MODE, false);
}

function tightenOwnedFileMode(databasePath: string): void {
  applySecurePermissions(databasePath, INVENTORY_V1_FILE_MODE, false);
}

function assertFilesystemOwner(path: string): void {
  if (process.platform === 'win32') {
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$userSid = $identity.User
$defaultOwnerSid = $identity.Owner
$target = [System.IO.Path]::GetFullPath($env:DKG_RFC64_ACL_PATH)
$acl = if ([System.IO.Directory]::Exists($target)) {
  [System.IO.Directory]::GetAccessControl(
    $target,
    [System.Security.AccessControl.AccessControlSections]::Owner
  )
} else {
  [System.IO.File]::GetAccessControl(
    $target,
    [System.Security.AccessControl.AccessControlSections]::Owner
  )
}
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
if (
  $owner.Value -ne $userSid.Value -and
  $owner.Value -ne $defaultOwnerSid.Value
) {
  [Console]::Error.WriteLine(
    "owner SID $($owner.Value) is neither token user $($userSid.Value) nor token default owner $($defaultOwnerSid.Value)"
  )
  exit 40
}
`;
    const result = spawnSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, DKG_RFC64_ACL_PATH: path },
      },
    );
    if (result.error !== undefined || result.status !== 0) {
      throw new InventoryV1OpenError(
        'database-io',
        `inventory path is not owned by the current Windows identity: ${path}`,
        { cause: result.error ?? new Error(result.stderr.trim() || `PowerShell exited ${result.status}`) },
      );
    }
    return;
  }
  try {
    if (!rfc64CurrentUserOwnsUidV1(statSync(path).uid)) {
      throw new Error('filesystem entry is not owned by the current process uid');
    }
  } catch (cause) {
    throw new InventoryV1OpenError(
      'database-io',
      `inventory path is not owned by the current process: ${path}`,
      { cause },
    );
  }
}

function assertOwnedUnitOwners(databasePath: string): void {
  for (const suffix of OWNED_FILE_SUFFIXES) {
    const path = `${databasePath}${suffix}`;
    if (pathEntryExists(path)) {
      assertOwnedRegularFile(path, `inventory database${suffix}`);
    }
  }
}

function applySecurePermissions(path: string, mode: number, directory: boolean): void {
  // Never let chmod or Set-Acl turn a foreign existing entry into an owned one.
  // Newly created entries are also checked because they must already be owned
  // by this process before their permissions are tightened.
  assertFilesystemOwner(path);
  if (process.platform === 'win32') {
    applyWindowsOwnerOnlyAcl(path, directory);
    return;
  }
  try {
    chmodSync(path, mode);
    const stat = statSync(path);
    if (!rfc64CurrentUserOwnsUidV1(stat.uid)) {
      throw new Error(`path owner uid ${stat.uid} does not match the current process uid`);
    }
    if (!rfc64PosixModeMatchesV1(stat.mode, mode)) {
      throw new Error(`path mode ${(stat.mode & 0o777).toString(8)} does not match ${mode.toString(8)}`);
    }
  } catch (cause) {
    throw new InventoryV1OpenError('database-io', `failed to set secure permissions on ${path}`, { cause });
  }
}

function applyWindowsOwnerOnlyAcl(path: string, directory: boolean): void {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:DKG_RFC64_ACL_PATH
$isDirectory = [System.Convert]::ToBoolean($env:DKG_RFC64_ACL_DIRECTORY)
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = if ($isDirectory) {
  [System.Security.AccessControl.DirectorySecurity]::new()
} else {
  [System.Security.AccessControl.FileSecurity]::new()
}
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$inheritance = if ($isDirectory) {
  [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
} else {
  [System.Security.AccessControl.InheritanceFlags]::None
}
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $sid,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  $inheritance,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.AddAccessRule($rule)
if ($isDirectory) {
  [System.IO.Directory]::SetAccessControl($target, $acl)
  $verified = [System.IO.Directory]::GetAccessControl($target)
} else {
  [System.IO.File]::SetAccessControl($target, $acl)
  $verified = [System.IO.File]::GetAccessControl($target)
}
$rules = @($verified.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if (-not $verified.AreAccessRulesProtected -or $rules.Count -ne 1) { exit 41 }
if ($rules[0].IdentityReference.Value -ne $sid.Value) { exit 42 }
if ($rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { exit 43 }
if (($rules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { exit 44 }
`;
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        DKG_RFC64_ACL_PATH: path,
        DKG_RFC64_ACL_DIRECTORY: String(directory),
      },
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new InventoryV1OpenError(
      'database-io',
      `failed to establish owner-only Windows ACL on ${path}`,
      { cause: result.error ?? new Error(result.stderr.trim() || `PowerShell exited ${result.status}`) },
    );
  }
}

function rejectOwnedFileSymlinks(databasePath: string): void {
  for (const suffix of OWNED_FILE_SUFFIXES) {
    const path = `${databasePath}${suffix}`;
    if (pathEntryExists(path)) rejectSymlink(path, `inventory database${suffix}`);
  }
}

function rejectOrphanedSqliteSidecars(mainPath: string, label: string): void {
  if (pathEntryExists(mainPath)) return;
  for (const suffix of ['-journal', '-wal', '-shm'] as const) {
    if (!pathEntryExists(`${mainPath}${suffix}`)) continue;
    throw new InventoryV1OpenError(
      'ambiguous-database',
      `orphaned ${label} sidecars exist without a main database and will not be modified`,
    );
  }
}

function rejectSymlink(path: string, label: string): void {
  if (lstatSync(path).isSymbolicLink()) {
    throw new InventoryV1OpenError('unsafe-path', `${label} must not be a symbolic link`);
  }
}

function assertOwnedRegularFile(path: string, label: string): void {
  rejectSymlink(path, label);
  if (!lstatSync(path).isFile()) {
    throw new InventoryV1OpenError('unsafe-path', `${label} must be a regular file`);
  }
  assertFilesystemOwner(path);
}

function assertOwnedDirectory(path: string, label: string): void {
  rejectSymlink(path, label);
  if (!lstatSync(path).isDirectory()) {
    throw new InventoryV1OpenError('unsafe-path', `${label} must be a directory`);
  }
  assertFilesystemOwner(path);
}

function assertSameFilesystem(path: string, directoryPath: string, label: string): void {
  try {
    if (statSync(path).dev !== statSync(directoryPath).dev) {
      throw new InventoryV1OpenError(
        'unsafe-path',
        `${label} is not on the quarantine generation filesystem`,
      );
    }
  } catch (cause) {
    if (cause instanceof InventoryV1OpenError) throw cause;
    throw new InventoryV1OpenError(
      'database-io',
      `failed to verify same-filesystem recovery for ${label}`,
      { cause },
    );
  }
}

function fsyncRegularFile(path: string, label: string): void {
  assertOwnedRegularFile(path, label);
  let descriptor: number | undefined;
  try {
    // Windows implements fsync with FlushFileBuffers, which rejects a handle
    // opened for read-only access with EPERM. The entry is already an owned
    // regular file; opening r+ grants the required handle access without
    // changing bytes, while POSIX retains its narrower read-only descriptor.
    descriptor = openSync(path, rfc64RegularFileFsyncOpenFlagsV1());
    fsyncSync(descriptor);
  } catch (cause) {
    throw new InventoryV1OpenError('database-io', `failed to fsync ${label}`, { cause });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new InventoryV1OpenError('database-io', `failed to inspect filesystem entry ${path}`, { cause });
  }
}

type RecoveryMemberV1 = 'journal' | 'wal' | 'shm' | 'main';
type RecoveryMembersV1 =
  | readonly ['main']
  | readonly ['journal', 'main']
  | readonly ['wal', 'main']
  | readonly ['shm', 'main']
  | readonly ['wal', 'shm', 'main'];

const ALL_RECOVERY_MEMBERS = ['journal', 'wal', 'shm', 'main'] as const satisfies readonly RecoveryMemberV1[];
const RECOVERY_MEMBER_ARRAYS = new Set([
  '["main"]',
  '["journal","main"]',
  '["wal","main"]',
  '["shm","main"]',
  '["wal","shm","main"]',
]);

interface RecoveryMarkerV1 {
  readonly version: 1;
  readonly quarantineDirectory: string;
  readonly members: RecoveryMembersV1;
}

type RecoveryMemberLocationV1 = 'source' | 'destination';

interface RecoveryTopologyV1 {
  readonly locations: ReadonlyMap<RecoveryMemberV1, RecoveryMemberLocationV1>;
  readonly movedCount: number;
}

interface FreshRecoveryMarkerAuthorizationV1 {
  readonly databasePath: string;
  readonly markerPath: string;
  readonly quarantineDirectory: string;
  readonly members: RecoveryMembersV1;
}

function assertQuarantineDurabilityAvailable(
  lifecycle: InventoryV1LifecycleAdapter,
): void {
  if (
    process.platform === 'win32'
    || lifecycle.quarantineCapability
      !== INVENTORY_V1_POSIX_QUARANTINE_CAPABILITY
  ) {
    throw new InventoryV1OpenError(
      'durability-unavailable',
      'RFC-64 inventory quarantine requires the explicit certified POSIX namespace capability',
    );
  }
}

function beginQuarantine(
  databasePath: string,
  lifecycle: InventoryV1LifecycleAdapter,
): FreshRecoveryMarkerAuthorizationV1 | null {
  assertQuarantineDurabilityAvailable(lifecycle);
  const markerPath = recoveryMarkerPath(databasePath);
  if (pathEntryExists(markerPath)) {
    rejectSymlink(markerPath, 'inventory recovery marker');
    return null;
  }
  const members = inspectSourceMembersForNewMarker(databasePath);
  for (const member of members) {
    fsyncRegularFile(recoverySourcePath(databasePath, member), `inventory ${member} evidence`);
    lifecycle.boundary(`begin.source.${member}.file-fsync`);
  }

  const inventoryDirectory = dirname(databasePath);
  const quarantineRoot = join(inventoryDirectory, QUARANTINE_DIRECTORY);
  if (pathEntryExists(quarantineRoot)) {
    assertOwnedDirectory(quarantineRoot, 'inventory quarantine directory');
  } else {
    mkdirSync(quarantineRoot, { mode: INVENTORY_V1_DIRECTORY_MODE });
  }
  assertOwnedDirectory(quarantineRoot, 'inventory quarantine directory');
  applySecurePermissions(quarantineRoot, INVENTORY_V1_DIRECTORY_MODE, true);
  fsyncDirectory(inventoryDirectory);
  lifecycle.boundary('begin.inventory-directory.fsync-after-quarantine-root');
  const suffix = `${Date.now()}-${randomBytes(8).toString('hex')}`;
  const quarantineDirectory = join(quarantineRoot, `inventory-v1-${suffix}`);
  mkdirSync(quarantineDirectory, { mode: INVENTORY_V1_DIRECTORY_MODE });
  assertOwnedDirectory(quarantineDirectory, 'inventory quarantine generation');
  applySecurePermissions(quarantineDirectory, INVENTORY_V1_DIRECTORY_MODE, true);
  assertSameFilesystem(inventoryDirectory, quarantineDirectory, 'inventory quarantine generation');
  for (const member of members) {
    const source = recoverySourcePath(databasePath, member);
    assertOwnedRegularFile(source, `inventory ${member} evidence`);
    assertSameFilesystem(source, quarantineDirectory, `inventory ${member} evidence`);
    const destination = recoveryDestinationPath(quarantineDirectory, member);
    if (pathEntryExists(destination)) {
      throw new InventoryV1OpenError(
        'database-io',
        `new quarantine generation already contains ${member} evidence`,
      );
    }
  }
  fsyncDirectory(quarantineRoot);
  lifecycle.boundary('begin.quarantine-root.fsync-after-generation');
  const marker: RecoveryMarkerV1 = { version: 1, quarantineDirectory, members };
  writeFileSync(markerPath, JSON.stringify(marker), { encoding: 'utf8', flag: 'wx', mode: INVENTORY_V1_FILE_MODE });
  lifecycle.boundary('begin.marker.write');
  applySecurePermissions(markerPath, INVENTORY_V1_FILE_MODE, false);
  fsyncRegularFile(markerPath, 'inventory recovery marker');
  lifecycle.boundary('begin.marker.file-fsync');
  fsyncDirectory(inventoryDirectory);
  lifecycle.boundary('begin.inventory-directory.fsync-after-marker');
  return Object.freeze({
    databasePath,
    markerPath,
    quarantineDirectory,
    members,
  });
}

function finishPendingQuarantine(
  sqlite: SqliteModuleV1,
  databasePath: string,
  lifecycle: InventoryV1LifecycleAdapter,
  freshMarkerAuthorization: FreshRecoveryMarkerAuthorizationV1 | null = null,
): void {
  const markerPath = recoveryMarkerPath(databasePath);
  if (!pathEntryExists(markerPath)) return;
  // This check precedes marker parsing, directory creation, permission changes,
  // SQLite probes, and evidence moves. Unsupported platforms leave the whole
  // pending unit byte-for-byte untouched for an offline operator procedure.
  assertQuarantineDurabilityAvailable(lifecycle);
  assertOwnedRegularFile(markerPath, 'inventory recovery marker');
  const inventoryDirectory = dirname(databasePath);
  const quarantineRoot = join(inventoryDirectory, QUARANTINE_DIRECTORY);
  if (!pathEntryExists(quarantineRoot)) {
    throw new InventoryV1OpenError(
      'database-io',
      'pending inventory recovery marker names a missing quarantine root',
    );
  }
  assertOwnedDirectory(quarantineRoot, 'inventory quarantine directory');
  const marker = parseRecoveryMarker(
    readBoundedRecoveryMarker(markerPath),
    inventoryDirectory,
  );
  const sourceQuiescenceAlreadyProven = freshMarkerAuthorization !== null
    && freshMarkerAuthorization.databasePath === databasePath
    && freshMarkerAuthorization.markerPath === markerPath
    && freshMarkerAuthorization.quarantineDirectory === marker.quarantineDirectory
    && freshMarkerAuthorization.members.length === marker.members.length
    && freshMarkerAuthorization.members.every(
      (member, index) => marker.members[index] === member,
    );
  if (!pathEntryExists(marker.quarantineDirectory)) {
    throw new InventoryV1OpenError(
      'database-io',
      'pending inventory recovery marker names a missing quarantine generation',
    );
  }
  assertOwnedDirectory(marker.quarantineDirectory, 'inventory quarantine generation');
  assertSameFilesystem(inventoryDirectory, marker.quarantineDirectory, 'inventory quarantine generation');

  let topology = inspectRecoveryTopology(marker, databasePath);
  if (
    marker.members[0] === 'journal'
    && topology.movedCount < marker.members.length
  ) {
    assertRollbackJournalMainHeader(databasePath);
  }
  // A crash may have occurred after rename but before that move's file or
  // directory barriers. Re-establish durability for the observed moved prefix
  // before either continuing or deleting the marker.
  fsyncMovedRecoveryPrefix(marker, topology, inventoryDirectory, lifecycle);
  if (topology.movedCount === 0) {
    // A zero-move marker never authorizes namespace mutation by itself. Prove
    // zero-timeout exclusivity while the complete source unit, including any
    // rollback journal, remains at its original pathname. A live raw SQLite
    // holder therefore leaves every source member, destination, and marker
    // untouched. Once the first prefix member has moved, that durable prefix
    // is the restart witness that this proof completed before any rename.
    if (marker.members[0] === 'journal') {
      // SQLite 3.39+ canonicalizes /dev/fd and /proc/self/fd aliases before
      // opening the database. An alias probe can therefore derive the real
      // source journal pathname and recover, zero, or delete the evidence it
      // is meant to protect. A freshly created marker may continue because
      // its caller proved target exclusivity before close and still holds the
      // lifetime DK6L lease. A zero-move marker reached after restart has no
      // equally non-mutating proof primitive in Node 22.5, so preserve the
      // complete unit and require offline recovery.
      if (!sourceQuiescenceAlreadyProven) {
        throw new InventoryV1OpenError(
          'durability-unavailable',
          'zero-move rollback-journal recovery requires offline exclusivity proof',
        );
      }
    } else {
      assertPendingUnitQuiescent(sqlite, databasePath, lifecycle);
    }
    topology = inspectRecoveryTopology(marker, databasePath);
    if (topology.movedCount !== 0) {
      throw new InventoryV1OpenError(
        'database-io',
        'inventory recovery topology changed while re-proving source quiescence',
      );
    }
    // The re-probe may checkpoint or perform ordinary exact-owned recovery.
    // Re-fsync the complete manifest after closing that handle so the pending
    // marker never vouches for bytes dirtied by the restart proof.
    for (const member of marker.members) {
      fsyncRegularFile(recoverySourcePath(databasePath, member), `inventory ${member} evidence`);
      lifecycle.boundary(`resume.source.${member}.file-fsync-after-quiescence`);
    }
  }

  for (const member of marker.members) {
    if (topology.locations.get(member) === 'destination') continue;
    moveRecoveryMember(
      marker,
      databasePath,
      member,
      inventoryDirectory,
      lifecycle,
    );
  }

  topology = inspectRecoveryTopology(marker, databasePath);
  if (topology.movedCount !== marker.members.length) {
    throw new InventoryV1OpenError(
      'database-io',
      'inventory recovery did not durably move every manifest member',
    );
  }
  unlinkSync(markerPath);
  lifecycle.boundary('resume.marker.unlink');
  fsyncDirectory(inventoryDirectory);
  lifecycle.boundary('resume.inventory-directory.fsync-after-marker-unlink');
}

function moveRecoveryMember(
  marker: RecoveryMarkerV1,
  databasePath: string,
  member: RecoveryMemberV1,
  inventoryDirectory: string,
  lifecycle: InventoryV1LifecycleAdapter,
): void {
  const source = recoverySourcePath(databasePath, member);
  const destination = recoveryDestinationPath(marker.quarantineDirectory, member);
  assertOwnedRegularFile(source, `inventory ${member} evidence`);
  assertSameFilesystem(source, marker.quarantineDirectory, `inventory ${member} evidence`);
  renameNoOverwriteUnderLease(source, destination);
  lifecycle.boundary(`resume.member.${member}.rename`);
  fsyncRegularFile(destination, `moved inventory ${member} evidence`);
  lifecycle.boundary(`resume.member.${member}.file-fsync`);
  fsyncDirectory(marker.quarantineDirectory);
  lifecycle.boundary(`resume.member.${member}.generation-directory-fsync`);
  fsyncDirectory(inventoryDirectory);
  lifecycle.boundary(`resume.member.${member}.inventory-directory-fsync`);
}

function fsyncMovedRecoveryPrefix(
  marker: RecoveryMarkerV1,
  topology: RecoveryTopologyV1,
  inventoryDirectory: string,
  lifecycle: InventoryV1LifecycleAdapter,
): void {
  for (const member of marker.members) {
    if (topology.locations.get(member) !== 'destination') break;
    fsyncRegularFile(
      recoveryDestinationPath(marker.quarantineDirectory, member),
      `moved inventory ${member} evidence`,
    );
    lifecycle.boundary(`resume.prefix.${member}.file-fsync`);
    fsyncDirectory(marker.quarantineDirectory);
    lifecycle.boundary(`resume.prefix.${member}.generation-directory-fsync`);
    fsyncDirectory(inventoryDirectory);
    lifecycle.boundary(`resume.prefix.${member}.inventory-directory-fsync`);
  }
}

function inspectSourceMembersForNewMarker(databasePath: string): RecoveryMembersV1 {
  const present: RecoveryMemberV1[] = [];
  for (const member of ALL_RECOVERY_MEMBERS) {
    const source = recoverySourcePath(databasePath, member);
    if (!pathEntryExists(source)) continue;
    assertOwnedRegularFile(source, `inventory ${member} evidence`);
    present.push(member);
  }
  if (present[0] === 'journal') {
    assertRollbackJournalMainHeader(databasePath);
  }
  return assertRecoveryMembers(present);
}

function assertRollbackJournalMainHeader(databasePath: string): void {
  const identity = readValidSqliteHeaderIdentity(databasePath);
  if (
    identity === null
    || identity.writeVersion !== 1
    || identity.readVersion !== 1
  ) {
    throw new InventoryV1OpenError(
      'ambiguous-database',
      'rollback-journal evidence with a non-rollback main header requires offline recovery',
    );
  }
}

function inspectRecoveryTopology(
  marker: RecoveryMarkerV1,
  databasePath: string,
): RecoveryTopologyV1 {
  const listed = new Set<RecoveryMemberV1>(marker.members);
  const knownDestinationNames = new Set(
    ALL_RECOVERY_MEMBERS.map((member) => basename(recoveryDestinationPath(marker.quarantineDirectory, member))),
  );
  for (const name of readdirSync(marker.quarantineDirectory)) {
    if (!knownDestinationNames.has(name)) {
      throw new InventoryV1OpenError(
        'database-io',
        `quarantine generation contains an unknown entry: ${name}`,
      );
    }
  }

  const locations = new Map<RecoveryMemberV1, RecoveryMemberLocationV1>();
  for (const member of ALL_RECOVERY_MEMBERS) {
    const source = recoverySourcePath(databasePath, member);
    const destination = recoveryDestinationPath(marker.quarantineDirectory, member);
    const sourceExists = pathEntryExists(source);
    const destinationExists = pathEntryExists(destination);
    if (!listed.has(member)) {
      if (sourceExists || destinationExists) {
        throw new InventoryV1OpenError(
          'database-io',
          `unlisted inventory recovery member exists: ${member}`,
        );
      }
      continue;
    }
    if (sourceExists === destinationExists) {
      throw new InventoryV1OpenError(
        'database-io',
        sourceExists
          ? `inventory recovery member exists at both source and destination: ${member}`
          : `inventory recovery member is missing from both source and destination: ${member}`,
      );
    }
    const path = sourceExists ? source : destination;
    assertOwnedRegularFile(path, `inventory ${member} recovery member`);
    assertSameFilesystem(path, marker.quarantineDirectory, `inventory ${member} recovery member`);
    locations.set(member, sourceExists ? 'source' : 'destination');
  }

  let movedCount = 0;
  let sawSource = false;
  for (const member of marker.members) {
    const location = locations.get(member);
    if (location === 'source') {
      sawSource = true;
    } else {
      if (sawSource) {
        throw new InventoryV1OpenError(
          'database-io',
          'inventory recovery members are not in a prefix-moved topology',
        );
      }
      movedCount += 1;
    }
  }
  return { locations, movedCount };
}

function recoverySourcePath(databasePath: string, member: RecoveryMemberV1): string {
  if (member === 'main') return databasePath;
  return `${databasePath}-${member}`;
}

function recoveryDestinationPath(
  quarantineDirectory: string,
  member: RecoveryMemberV1,
): string {
  return join(
    quarantineDirectory,
    member === 'main' ? 'inventory-v1.sqlite3' : `inventory-v1.sqlite3-${member}`,
  );
}

function renameNoOverwriteUnderLease(source: string, destination: string): void {
  // Node 22.5 exposes no renameat2/RENAME_NOREPLACE binding. Under the frozen
  // dedicated-directory plus all-conforming-adapter invariant, the DK6L lease
  // excludes every permitted namespace writer between this check and rename.
  // A deployment with any nonconforming path writer must disable quarantine.
  if (pathEntryExists(destination)) {
    throw new InventoryV1OpenError(
      'database-io',
      `quarantine destination already exists: ${destination}`,
    );
  }
  renameSync(source, destination);
}

function assertPendingUnitQuiescent(
  sqlite: SqliteModuleV1,
  databasePath: string,
  lifecycle: InventoryV1LifecycleAdapter,
): void {
  if (!pathEntryExists(databasePath)) {
    throw new InventoryV1OpenError(
      'database-io',
      'pending quarantine has no complete source main and will not create a database',
    );
  }
  rejectOwnedFileSymlinks(databasePath);
  assertOwnedUnitOwners(databasePath);
  let database: DatabaseSyncV1 | null = null;
  try {
    database = new sqlite.DatabaseSync(databasePath);
    database.exec('PRAGMA busy_timeout = 0');
    assertCorruptDatabaseQuiescent(database, lifecycle);
  } catch (cause) {
    if (cause instanceof InventoryV1OpenError) throw cause;
    if (isBusySqliteError(cause)) {
      throw new InventoryV1OpenError(
        'database-busy',
        'pending inventory quarantine still has an active SQLite holder',
        { cause },
      );
    }
    throw new InventoryV1OpenError(
      'database-io',
      'cannot re-prove exclusive access before resuming inventory quarantine',
      { cause },
    );
  } finally {
    if (database !== null) {
      closeInventoryTarget(database, 'pending-quarantine-probe', lifecycle);
    }
  }
}

function readBoundedRecoveryMarker(markerPath: string): string {
  let descriptor: number | undefined;
  let bytes: Buffer;
  try {
    descriptor = openSync(markerPath, 'r');
    const descriptorStat = fstatSync(descriptor);
    const pathStat = lstatSync(markerPath);
    if (
      !descriptorStat.isFile()
      || !pathStat.isFile()
      || descriptorStat.dev !== pathStat.dev
      || descriptorStat.ino !== pathStat.ino
    ) {
      throw new InventoryV1OpenError(
        'database-io',
        'inventory recovery marker changed before it was read',
      );
    }
    if (descriptorStat.size > RECOVERY_MARKER_MAX_BYTES) {
      throw new InventoryV1OpenError(
        'database-io',
        `inventory recovery marker exceeds ${RECOVERY_MARKER_MAX_BYTES} bytes`,
      );
    }
    const boundedBuffer = Buffer.allocUnsafe(RECOVERY_MARKER_MAX_BYTES + 1);
    const bytesRead = readSync(
      descriptor,
      boundedBuffer,
      0,
      boundedBuffer.byteLength,
      0,
    );
    const finalStat = fstatSync(descriptor);
    if (
      bytesRead > RECOVERY_MARKER_MAX_BYTES
      || bytesRead !== descriptorStat.size
      || finalStat.size !== descriptorStat.size
      || finalStat.mtimeMs !== descriptorStat.mtimeMs
    ) {
      throw new InventoryV1OpenError(
        'database-io',
        'inventory recovery marker changed while it was read',
      );
    }
    bytes = boundedBuffer.subarray(0, bytesRead);
  } catch (cause) {
    if (cause instanceof InventoryV1OpenError) throw cause;
    throw new InventoryV1OpenError(
      'database-io',
      'inventory recovery marker could not be read safely',
      { cause },
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (
    (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    || (bytes[0] === 0xff && bytes[1] === 0xfe)
    || (bytes[0] === 0xfe && bytes[1] === 0xff)
  ) {
    throw new InventoryV1OpenError(
      'database-io',
      'inventory recovery marker must not contain a Unicode byte-order mark',
    );
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new InventoryV1OpenError(
      'database-io',
      'inventory recovery marker is not valid UTF-8',
      { cause },
    );
  }
}

function parseRecoveryMarker(value: string, inventoryDirectory: string): RecoveryMarkerV1 {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (cause) {
    throw new InventoryV1OpenError('database-io', 'inventory recovery marker is malformed', { cause });
  }
  if (
    typeof parsed !== 'object'
    || parsed === null
    || Array.isArray(parsed)
    || Object.keys(parsed).length !== 3
    || !['members', 'quarantineDirectory', 'version'].every((key) => Object.hasOwn(parsed, key))
    || (parsed as { version?: unknown }).version !== 1
    || typeof (parsed as { quarantineDirectory?: unknown }).quarantineDirectory !== 'string'
    || !Array.isArray((parsed as { members?: unknown }).members)
  ) {
    throw new InventoryV1OpenError('database-io', 'inventory recovery marker has an invalid shape');
  }
  const members = assertRecoveryMembers((parsed as { members: unknown[] }).members);
  const encodedDirectory = (parsed as RecoveryMarkerV1).quarantineDirectory;
  if (hasLoneUtf16Surrogate(encodedDirectory)) {
    throw new InventoryV1OpenError(
      'database-io',
      'inventory recovery marker path contains an unpaired UTF-16 surrogate',
    );
  }
  const serializedMarker = JSON.stringify({
    version: 1,
    quarantineDirectory: encodedDirectory,
    members,
  });
  if (serializedMarker !== value) {
    // Markers are private crash-recovery state emitted only by beginQuarantine.
    // Requiring its exact local encoding rejects duplicate textual JSON keys,
    // alternate key order, insignificant whitespace, and escape aliases that
    // JSON.parse alone would otherwise collapse before shape validation.
    throw new InventoryV1OpenError(
      'database-io',
      'inventory recovery marker is not in the frozen local serialization',
    );
  }
  const quarantineRoot = join(inventoryDirectory, QUARANTINE_DIRECTORY);
  const generationName = basename(encodedDirectory);
  const canonicalDirectory = join(quarantineRoot, generationName);
  if (
    !isAbsolute(encodedDirectory)
    || encodedDirectory !== canonicalDirectory
    || !/^inventory-v1-[0-9]+-[0-9a-f]{16}$/.test(generationName)
  ) {
    throw new InventoryV1OpenError(
      'unsafe-path',
      'inventory recovery marker path is not the exact canonical quarantine generation path',
    );
  }
  return { version: 1, quarantineDirectory: canonicalDirectory, members };
}

function hasLoneUtf16Surrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertRecoveryMembers(value: readonly unknown[]): RecoveryMembersV1 {
  if (!RECOVERY_MEMBER_ARRAYS.has(JSON.stringify(value))) {
    throw new InventoryV1OpenError(
      'database-io',
      'inventory recovery marker has an invalid or reordered members manifest',
    );
  }
  return [...value] as unknown as RecoveryMembersV1;
}

function recoveryMarkerPath(databasePath: string): string {
  return `${databasePath}${RECOVERY_MARKER_SUFFIX}`;
}

function isCorruptSqliteError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const errcode = (error as { errcode?: unknown }).errcode;
  return errcode === 11 || errcode === 26;
}

function isBusySqliteError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const errcode = (error as { errcode?: unknown }).errcode;
  return errcode === 5 || errcode === 6;
}

type CorruptDatabaseOwnershipV1 = 'owned' | 'ambiguous' | 'foreign' | 'newer';

interface SqliteHeaderIdentityV1 {
  applicationId: number;
  userVersion: number;
  writeVersion: number;
  readVersion: number;
}

function classifyCorruptDatabaseOwnership(databasePath: string): CorruptDatabaseOwnershipV1 {
  const identity = readValidSqliteHeaderIdentity(databasePath);
  if (identity === null || identity.applicationId === 0) return 'ambiguous';
  if (identity.applicationId !== INVENTORY_V1_APPLICATION_ID) return 'foreign';
  if (identity.userVersion > INVENTORY_V1_USER_VERSION) return 'newer';
  return identity.userVersion === INVENTORY_V1_USER_VERSION ? 'owned' : 'ambiguous';
}

function readValidSqliteHeaderIdentity(databasePath: string): SqliteHeaderIdentityV1 | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(databasePath, 'r');
    const header = Buffer.alloc(100);
    const bytesRead = readSync(descriptor, header, 0, header.byteLength, 0);
    if (bytesRead < header.byteLength || header.subarray(0, 16).toString('binary') !== 'SQLite format 3\u0000') {
      return null;
    }
    return {
      applicationId: header.readUInt32BE(68),
      userVersion: header.readUInt32BE(60),
      writeVersion: header[18],
      readVersion: header[19],
    };
  } catch (cause) {
    throw new InventoryV1OpenError(
      'database-io',
      'failed to read the inventory database header; it will not be quarantined',
      { cause },
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  fsyncRfc64DirectorySyncV1(path);
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new InventoryV1OpenError('database-io', `${label} is not text`);
  }
  return value;
}
