import { randomBytes } from 'node:crypto';

import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';

import {
  KA_TRANSFER_CHUNK_SIZE_V1,
  KA_TRANSFER_CODEC_V1,
  KA_TRANSFER_PROJECTION_V1,
  MAX_AUTHOR_CATALOG_BUCKET_PAYLOAD_BYTES_V1,
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  ZERO_DIGEST32_V1,
  assertAssertionCoordinateV1,
  assertAuthorCatalogBucketScopeBindingV1,
  assertAuthorCatalogBucketV1,
  assertAuthorCatalogBucketCountV1,
  assertAuthorCatalogRowV1,
  assertSignedAuthorCatalogBucketEnvelopeV1,
  assertSignedAuthorCatalogHeadEnvelopeV1,
  assertSubGraphNameV1,
  canonicalizeAuthorCatalogBucketPayloadBytesV1,
  canonicalizeAuthorCatalogScopeV1,
  canonicalizeSignedAuthorCatalogHeadEnvelopeBytesV1,
  computeAuthorCatalogKeyDigestV1,
  computeAuthorCatalogRowDigestV1,
  computeAuthorCatalogScopeDigestV1,
  deriveAuthorCatalogScopeFromHeadV1,
  parseCanonicalSignedAuthorCatalogHeadEnvelopeV1,
  parseCanonicalDecimalU64,
  readVerifiedAuthorCatalogBucketDescriptorV1,
  readVerifiedTransferredCatalogBundleMetadataV1,
  verifyCgSharedProjectionV1,
  verifyTransferredCatalogBundleV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type ByteLengthV1,
  type CatalogSealDeploymentProfileV1,
  type CgSharedProjectionVerificationLimitsV1,
  type CountV1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
  type KaIdV1,
  type SignedAuthorCatalogBucketEnvelopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type SubGraphNameV1,
  type VerifiedAuthorCatalogDirectoryPathV1,
  type VerifiedCgSharedProjectionV1,
  type VerifiedTransferredCatalogBundleV1,
} from '@origintrail-official/dkg-core';

import {
  assertSqlBlobWidthV1,
  decimalU64ToSqlBlobV1,
  decimalU256ToSqlBlobV1,
  digest32ToSqlBlobV1,
  evmAddressToSqlBlobV1,
  sqlBlobToDecimalU64V1,
  sqlBlobToDecimalU256V1,
  sqlBlobToDigest32V1,
  sqlBlobToEvmAddressV1,
  sqlBlobsEqualV1,
} from './scalars.js';
import { INVENTORY_V1_STATEMENT_SQL } from './statements.js';

const MAX_PAGE_SIZE = 256;
const STATEMENT_LATENCY_BUDGET_MS = 10_000;
const WRITE_TRANSACTION_LATENCY_BUDGET_MS = 30_000;

declare const CANDIDATE_SESSION_BRAND: unique symbol;
declare const CANDIDATE_LOAD_KEY_BRAND: unique symbol;
declare const CANDIDATE_ROWS_TRAVERSAL_BRAND: unique symbol;
declare const CANDIDATE_DIFF_TRAVERSAL_BRAND: unique symbol;
declare const VERIFIED_CANDIDATE_CATALOG_ROW_BRAND: unique symbol;

/** Opaque, adapter-local session. No raw session bytes are exposed or accepted. */
export interface CandidateSessionV1 {
  readonly [CANDIDATE_SESSION_BRAND]: true;
}

/** Opaque key returned only after a verified load has been accepted. */
export interface CandidateBucketLoadKeyV1 {
  readonly [CANDIDATE_LOAD_KEY_BRAND]: true;
}

export interface CandidateBucketRowsTraversalV1 {
  readonly [CANDIDATE_ROWS_TRAVERSAL_BRAND]: true;
}

export interface CandidateBucketDiffTraversalV1 {
  readonly [CANDIDATE_DIFF_TRAVERSAL_BRAND]: true;
}

/**
 * Process-local proof that a row was decoded through a live, pinned traversal
 * rooted in an opaque verified head/directory/bucket load. SQLite bytes alone
 * can never construct this capability.
 */
export interface VerifiedCandidateCatalogRowV1 {
  readonly [VERIFIED_CANDIDATE_CATALOG_ROW_BRAND]: true;
}

export interface VerifiedCandidateBucketLoadV1 {
  readonly session: CandidateSessionV1;
  readonly head: SignedAuthorCatalogHeadEnvelopeV1;
  /** Exact process-local core proof for the selected descriptor under `head`. */
  readonly directoryPath: VerifiedAuthorCatalogDirectoryPathV1;
  readonly bucket: SignedAuthorCatalogBucketEnvelopeV1 | null;
}

export interface CandidateBucketHeaderV1 {
  readonly catalogScopeDigest: Digest32V1;
  readonly authorAddress: EvmAddressV1;
  readonly targetCatalogHeadDigest: Digest32V1;
  readonly subGraphName: SubGraphNameV1 | null;
  readonly catalogEra: DecimalU64V1;
  readonly bucketCount: CountV1;
  readonly bucketId: DecimalU64V1;
  readonly bucketObjectDigest: Digest32V1;
  readonly rowCount: CountV1;
  readonly payloadByteLength: ByteLengthV1;
}

export interface CandidateBucketRowSnapshotV1 {
  /** Full canonical catalog scope needed by every later digest/admission check. */
  readonly catalogScope: AuthorCatalogScopeV1;
  /** The exact verified bucket/head scope from which this row was traversed. */
  readonly header: CandidateBucketHeaderV1;
  /** `removed` rows are deletion candidates, never transfer/admission candidates. */
  readonly disposition: 'present' | 'removed';
  readonly row: AuthorCatalogRowV1;
  readonly catalogKeyDigest: Digest32V1;
  readonly expectedCatalogRowDigest: Digest32V1;
}

export interface CandidateBucketRowV1 extends CandidateBucketRowSnapshotV1 {
  readonly verifiedRow: VerifiedCandidateCatalogRowV1;
}

export interface CandidateBucketPutResultV1 {
  readonly status: 'inserted' | 'existing';
  readonly loadKey: CandidateBucketLoadKeyV1;
  readonly header: CandidateBucketHeaderV1;
}

export interface CandidateBucketPageV1 {
  readonly rows: readonly CandidateBucketRowV1[];
  readonly resumeAfter: KaIdV1 | null;
}

export interface CandidateSessionGcBatchResultV1 {
  readonly deletedLoads: number;
  readonly done: boolean;
}

/**
 * Precommit evidence for one exact live candidate row. Both fields are opaque,
 * process-local capabilities. This container proves neither catalog-head authority
 * nor policy/finality, and grants no semantic-store or activation authority.
 */
export interface CandidateCatalogPrecommitResultV1 {
  readonly transferredBundle: VerifiedTransferredCatalogBundleV1;
  readonly sharedProjection: VerifiedCgSharedProjectionV1;
}

export type InventoryV1CandidateErrorCode =
  | 'candidate-invalid-session'
  | 'candidate-startup-purge-required'
  | 'candidate-session-poisoned'
  | 'candidate-session-not-poisoned'
  | 'candidate-invalid-load'
  | 'candidate-conflict'
  | 'candidate-not-loaded'
  | 'candidate-invalid-load-key'
  | 'candidate-invalid-traversal'
  | 'candidate-traversal-closed'
  | 'candidate-invalid-row-proof'
  | 'candidate-stale-row-proof'
  | 'candidate-row-not-present'
  | 'candidate-head-binding'
  | 'candidate-deployment-profile'
  | 'candidate-binding-changed'
  | 'candidate-cursor-mismatch'
  | 'candidate-stream-complete'
  | 'candidate-in-use'
  | 'candidate-database-corrupt'
  | 'latency-budget-exceeded'
  | 'candidate-database-error';

export class InventoryV1CandidateError extends Error {
  constructor(
    readonly code: InventoryV1CandidateErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'InventoryV1CandidateError';
  }
}

export interface Rfc64InventoryV1CandidateApi {
  purgeNextStartupStaleCandidateBatch(): CandidateSessionGcBatchResultV1;
  createCandidateSession(): CandidateSessionV1;
  putVerifiedCandidateBucket(load: VerifiedCandidateBucketLoadV1): CandidateBucketPutResultV1;
  getCandidateBucket(loadKey: CandidateBucketLoadKeyV1): CandidateBucketHeaderV1;
  beginCandidateBucketRows(loadKey: CandidateBucketLoadKeyV1): CandidateBucketRowsTraversalV1;
  beginCandidateBucketDiff(
    oldLoadKey: CandidateBucketLoadKeyV1,
    newLoadKey: CandidateBucketLoadKeyV1,
  ): CandidateBucketDiffTraversalV1;
  pageCandidateBucketRows(
    traversal: CandidateBucketRowsTraversalV1,
    cursor: KaIdV1 | null | undefined,
    limit: number,
  ): CandidateBucketPageV1;
  pageCandidateBucketAddedOrChanged(
    traversal: CandidateBucketDiffTraversalV1,
    cursor: KaIdV1 | null | undefined,
    limit: number,
  ): CandidateBucketPageV1;
  pageCandidateBucketRemoved(
    traversal: CandidateBucketDiffTraversalV1,
    cursor: KaIdV1 | null | undefined,
    limit: number,
  ): CandidateBucketPageV1;
  readVerifiedCandidateCatalogRow(
    verifiedRow: VerifiedCandidateCatalogRowV1,
  ): CandidateBucketRowSnapshotV1;
  /**
   * Replace one live `present` row proof with structural transfer and semantic
   * projection proofs. The caller must separately establish head authority,
   * policy, placement/finality, atomic commit, and exact post-read success.
   */
  verifyCandidateCatalogPrecommitV1(
    verifiedRow: VerifiedCandidateCatalogRowV1,
    signedHead: SignedAuthorCatalogHeadEnvelopeV1,
    receivedBundleBytes: Uint8Array,
    deployment: CatalogSealDeploymentProfileV1,
    limits?: CgSharedProjectionVerificationLimitsV1,
  ): CandidateCatalogPrecommitResultV1;
  closeCandidateTraversal(
    traversal: CandidateBucketRowsTraversalV1 | CandidateBucketDiffTraversalV1,
  ): void;
  discardCandidateSessionBatch(session: CandidateSessionV1): CandidateSessionGcBatchResultV1;
  deleteCandidateBucket(loadKey: CandidateBucketLoadKeyV1): void;
}

/** Candidate operations safe to share without inventory lifecycle ownership. */
export type Rfc64InventoryV1OperationsV1 = Pick<
  Rfc64InventoryV1CandidateApi,
  | 'createCandidateSession'
  | 'putVerifiedCandidateBucket'
  | 'getCandidateBucket'
  | 'beginCandidateBucketRows'
  | 'beginCandidateBucketDiff'
  | 'pageCandidateBucketRows'
  | 'pageCandidateBucketAddedOrChanged'
  | 'pageCandidateBucketRemoved'
  | 'readVerifiedCandidateCatalogRow'
  | 'verifyCandidateCatalogPrecommitV1'
  | 'closeCandidateTraversal'
  | 'discardCandidateSessionBatch'
  | 'deleteCandidateBucket'
>;

interface SessionContextV1 {
  readonly scopeHex: string;
  readonly authorHex: string;
  readonly subGraphName: string | null;
  readonly eraHex: string;
  readonly bucketCountHex: string;
}

interface SessionRecordV1 {
  readonly id: Uint8Array;
  readonly headContexts: Map<string, SessionContextV1>;
  readonly traversals: Set<TraversalRecordV1>;
  poisoned: boolean;
}

interface EncodedLoadKeyV1 {
  readonly session: Uint8Array;
  readonly scope: Uint8Array;
  readonly author: Uint8Array;
  readonly head: Uint8Array;
  readonly bucket: Uint8Array;
}

interface LoadKeyRecordV1 {
  readonly sessionHandle: CandidateSessionV1;
  readonly session: SessionRecordV1;
  readonly encoded: EncodedLoadKeyV1;
  readonly expectedHeader: EncodedHeaderV1;
  readonly publicHeader: CandidateBucketHeaderV1;
  readonly scope: AuthorCatalogScopeV1;
  readonly pinKey: string;
}

interface EncodedHeaderV1 extends EncodedLoadKeyV1 {
  readonly subgraphName: string | null;
  readonly era: Uint8Array;
  readonly bucketCount: Uint8Array;
  readonly bucketObjectDigest: Uint8Array;
  readonly rowCount: Uint8Array;
  readonly payloadByteLength: Uint8Array;
}

interface EncodedRowV1 extends EncodedLoadKeyV1 {
  readonly kaId: Uint8Array;
  readonly catalogKeyDigest: Uint8Array;
  readonly assertionCoordinate: string;
  readonly assertionVersion: Uint8Array;
  readonly projectionId: typeof KA_TRANSFER_PROJECTION_V1;
  readonly projectionDigest: Uint8Array;
  readonly sealDigest: Uint8Array;
  readonly transferCodec: typeof KA_TRANSFER_CODEC_V1;
  readonly transferByteLength: Uint8Array;
  readonly transferChunkSize: Uint8Array;
  readonly transferChunkCount: Uint8Array;
  readonly transferBlobDigest: Uint8Array;
  readonly transferChunkTreeRoot: Uint8Array;
  readonly expectedCatalogRowDigest: Uint8Array;
}

interface EncodedCandidateLoadV1 {
  readonly sessionHandle: CandidateSessionV1;
  readonly session: SessionRecordV1;
  readonly header: EncodedHeaderV1;
  readonly rows: readonly EncodedRowV1[];
  readonly publicHeader: CandidateBucketHeaderV1;
  readonly scope: AuthorCatalogScopeV1;
  readonly context: SessionContextV1;
}

interface DeleteTargetV1 {
  readonly key: EncodedLoadKeyV1;
  readonly header: EncodedHeaderV1;
  readonly childCount: number;
}

type IndeterminateCommitResolutionV1 = 'committed' | 'not-committed';

interface IndeterminateCommitStrategyV1<T> {
  readonly resolve: (result: T) => IndeterminateCommitResolutionV1;
  readonly retry: (result: T) => T;
  readonly resolvedCommittedResult?: (result: T) => T;
}

interface RollbackResultV1 {
  readonly failed: boolean;
  readonly overran: boolean;
}

interface TraversalBaseV1 {
  readonly sessions: readonly SessionRecordV1[];
  readonly pins: readonly LoadKeyRecordV1[];
  closed: boolean;
  closeReason: 'normal' | 'poisoned' | 'reopen' | null;
}

interface VerifiedCandidateCatalogRowRecordV1 {
  readonly traversalHandle: CandidateBucketRowsTraversalV1 | CandidateBucketDiffTraversalV1;
  readonly traversal: TraversalRecordV1;
  readonly load: LoadKeyRecordV1;
  readonly snapshot: CandidateBucketRowSnapshotV1;
}

interface DecodedCandidateBucketRowV1 {
  readonly row: AuthorCatalogRowV1;
  readonly catalogKeyDigest: Digest32V1;
  readonly expectedCatalogRowDigest: Digest32V1;
}

interface CandidateBucketDecodedPageV1 {
  readonly rows: readonly DecodedCandidateBucketRowV1[];
  readonly resumeAfter: KaIdV1 | null;
}

interface RowsTraversalRecordV1 extends TraversalBaseV1 {
  readonly kind: 'rows';
  readonly load: LoadKeyRecordV1;
  expectedCursor: KaIdV1 | null;
  terminal: boolean;
}

interface DiffTraversalRecordV1 extends TraversalBaseV1 {
  readonly kind: 'diff';
  readonly oldLoad: LoadKeyRecordV1;
  readonly newLoad: LoadKeyRecordV1;
  addedExpectedCursor: KaIdV1 | null;
  removedExpectedCursor: KaIdV1 | null;
  addedTerminal: boolean;
  removedTerminal: boolean;
}

type TraversalRecordV1 = RowsTraversalRecordV1 | DiffTraversalRecordV1;
type SqlRowV1 = Record<string, unknown>;
type SqlParametersV1 = Record<string, SQLInputValue>;

/** @internal Wired into the owned SQLite foundation; not a standalone database API. */
export class CandidateInventoryV1 implements Rfc64InventoryV1CandidateApi {
  readonly #sessions = new WeakMap<object, SessionRecordV1>();
  readonly #sessionRecords = new Set<SessionRecordV1>();
  readonly #loadKeys = new WeakMap<object, LoadKeyRecordV1>();
  readonly #traversals = new WeakMap<object, TraversalRecordV1>();
  readonly #verifiedRows = new WeakMap<object, VerifiedCandidateCatalogRowRecordV1>();
  readonly #pins = new Map<string, number>();
  #startupPurgeDone = false;
  #committedOverruns = 0;
  #available = true;
  #closed = false;
  #activeWriteDeadline: number | null = null;

  constructor(
    private database: DatabaseSync,
    private readonly onRequireReopen: (database: DatabaseSync) => DatabaseSync,
    private readonly monotonicNow: () => number = () => performance.now(),
    private readonly onRejectReopened: (database: DatabaseSync) => void = closeRejectedDatabase,
  ) {}

  /** Number of committed write operations whose successful COMMIT crossed a hard budget. */
  get committedOverruns(): number {
    return this.#committedOverruns;
  }

  purgeNextStartupStaleCandidateBatch(): CandidateSessionGcBatchResultV1 {
    this.assertOpen();
    if (this.#startupPurgeDone) return Object.freeze({ deletedLoads: 0, done: true });
    const transaction = this.writeTransaction('startup candidate purge', () => {
      const select = this.prepare(INVENTORY_V1_STATEMENT_SQL.startupGcNext);
      const selected = this.statement(() => select.all() as SqlRowV1[]);
      const targets = selected.map((row) => this.captureDeleteTarget(row));
      this.deleteExactTargets(targets);
      return Object.freeze({ targets });
    }, {
      resolve: ({ targets }) => this.resolveDeletedTargets(targets),
      retry: ({ targets }) => {
        this.deleteExactTargets(targets);
        return Object.freeze({ targets });
      },
    });
    const result = Object.freeze({
      deletedLoads: transaction.targets.length,
      done: transaction.targets.length === 0,
    });
    if (result.done) this.#startupPurgeDone = true;
    return result;
  }

  createCandidateSession(): CandidateSessionV1 {
    this.assertOpen();
    if (!this.#startupPurgeDone) {
      throw new InventoryV1CandidateError(
        'candidate-startup-purge-required',
        'startup stale-candidate purge must reach a terminal empty batch first',
      );
    }
    let id = randomBytes(32);
    while (isAllZero(id)) id = randomBytes(32);
    const handle = Object.freeze({}) as CandidateSessionV1;
    const session: SessionRecordV1 = {
      id: new Uint8Array(id),
      headContexts: new Map(),
      traversals: new Set(),
      poisoned: false,
    };
    this.#sessions.set(handle as object, session);
    this.#sessionRecords.add(session);
    return handle;
  }

  putVerifiedCandidateBucket(load: VerifiedCandidateBucketLoadV1): CandidateBucketPutResultV1 {
    this.assertOpen();
    // A poisoned session is terminal. Inspect only the opaque local capability
    // before touching any attacker-controlled head, path, bucket, or row bytes
    // so malformed follow-up input cannot mask the poison outcome.
    const earlySessionHandle = extractCandidateLoadSession(load);
    const earlySession = this.requireSession(earlySessionHandle);
    this.assertSessionUsable(earlySessionHandle, earlySession);
    const encoded = this.encodeAndVerifyLoad(load);
    this.assertSessionUsable(encoded.sessionHandle, encoded.session);
    const headKey = bytesToHex(encoded.header.head);
    const existingContext = encoded.session.headContexts.get(headKey);
    if (existingContext !== undefined && !sameContext(existingContext, encoded.context)) {
      this.poison(encoded.session);
      throw new InventoryV1CandidateError(
        'candidate-conflict',
        'one candidate session/head cannot change scope, author, lane, era, or bucketCount',
      );
    }

    let status: CandidateBucketPutResultV1['status'];
    try {
      status = this.writeTransaction(
        'stage verified candidate bucket',
        () => this.stageExactCandidateLoad(encoded),
        {
          resolve: () => this.resolvePutOutcome(encoded),
          retry: () => this.stageExactCandidateLoad(encoded),
          resolvedCommittedResult: () => 'existing',
        },
      );
    } catch (cause) {
      if (cause instanceof CandidateConflictSignal || isSqliteUniqueOrPrimaryKeyConstraint(cause)) {
        this.poison(encoded.session);
        throw new InventoryV1CandidateError(
          'candidate-conflict',
          'candidate bytes conflict with an immutable load or head-wide uniqueness constraint',
          { cause },
        );
      }
      if (cause instanceof InventoryV1CandidateError) throw cause;
      throw databaseError('failed to atomically stage verified candidate bucket', cause);
    }

    encoded.session.headContexts.set(headKey, encoded.context);
    return {
      status,
      loadKey: this.createLoadKey(encoded),
      header: encoded.publicHeader,
    };
  }

  getCandidateBucket(loadKey: CandidateBucketLoadKeyV1): CandidateBucketHeaderV1 {
    this.assertOpen();
    const key = this.requireLoadKey(loadKey);
    this.assertSessionUsable(key.sessionHandle, key.session);
    return this.readTransaction(() => this.requireHeader(key));
  }

  beginCandidateBucketRows(loadKey: CandidateBucketLoadKeyV1): CandidateBucketRowsTraversalV1 {
    this.assertOpen();
    const load = this.requireLoadKey(loadKey);
    this.assertSessionUsable(load.sessionHandle, load.session);
    this.readTransaction(() => this.requireHeaderAndExactChildCount(load));
    const record: RowsTraversalRecordV1 = {
      kind: 'rows',
      load,
      sessions: [load.session],
      pins: [load],
      expectedCursor: null,
      terminal: false,
      closed: false,
      closeReason: null,
    };
    return this.registerTraversal(record) as CandidateBucketRowsTraversalV1;
  }

  beginCandidateBucketDiff(
    oldLoadKey: CandidateBucketLoadKeyV1,
    newLoadKey: CandidateBucketLoadKeyV1,
  ): CandidateBucketDiffTraversalV1 {
    this.assertOpen();
    const oldLoad = this.requireLoadKey(oldLoadKey);
    const newLoad = this.requireLoadKey(newLoadKey);
    this.assertSessionUsable(oldLoad.sessionHandle, oldLoad.session);
    this.assertSessionUsable(newLoad.sessionHandle, newLoad.session);
    const [oldHeader, newHeader] = this.readTransaction(() => [
      this.requireHeaderAndExactChildCount(oldLoad),
      this.requireHeaderAndExactChildCount(newLoad),
    ] as const);
    assertDiffCompatible(oldHeader, newHeader);

    const sessions = oldLoad.session === newLoad.session
      ? [oldLoad.session]
      : [oldLoad.session, newLoad.session];
    const pins = oldLoad.pinKey === newLoad.pinKey ? [oldLoad] : [oldLoad, newLoad];
    const record: DiffTraversalRecordV1 = {
      kind: 'diff',
      oldLoad,
      newLoad,
      sessions,
      pins,
      addedExpectedCursor: null,
      removedExpectedCursor: null,
      addedTerminal: false,
      removedTerminal: false,
      closed: false,
      closeReason: null,
    };
    return this.registerTraversal(record) as CandidateBucketDiffTraversalV1;
  }

  pageCandidateBucketRows(
    traversal: CandidateBucketRowsTraversalV1,
    cursor: KaIdV1 | null | undefined,
    limit: number,
  ): CandidateBucketPageV1 {
    const record = this.requireTraversal(traversal, 'rows');
    try {
      this.assertTraversalSessions(record);
      if (record.terminal) throw streamComplete();
      const canonicalCursor = assertCursor(cursor, record.expectedCursor);
      const page = this.readTransaction(() => {
        this.requireHeader(record.load);
        return this.queryRowsPage(record.load, canonicalCursor, limit);
      });
      const verifiedPage = this.mintVerifiedPage(page, traversal, record, record.load);
      if (page.rows.length === 0) {
        record.terminal = true;
        this.closeTraversalRecord(record);
      } else {
        record.expectedCursor = page.resumeAfter;
      }
      return verifiedPage;
    } catch (cause) {
      this.closeTraversalRecord(record);
      throw normalizeCandidateError('candidate row page failed', cause);
    }
  }

  pageCandidateBucketAddedOrChanged(
    traversal: CandidateBucketDiffTraversalV1,
    cursor: KaIdV1 | null | undefined,
    limit: number,
  ): CandidateBucketPageV1 {
    return this.pageDiff(traversal, cursor, limit, 'added');
  }

  pageCandidateBucketRemoved(
    traversal: CandidateBucketDiffTraversalV1,
    cursor: KaIdV1 | null | undefined,
    limit: number,
  ): CandidateBucketPageV1 {
    return this.pageDiff(traversal, cursor, limit, 'removed');
  }

  readVerifiedCandidateCatalogRow(
    verifiedRow: VerifiedCandidateCatalogRowV1,
  ): CandidateBucketRowSnapshotV1 {
    this.assertOpen();
    if (typeof verifiedRow !== 'object' || verifiedRow === null) {
      throw invalidRowProof();
    }
    const proof = this.#verifiedRows.get(verifiedRow as object);
    if (proof === undefined) throw invalidRowProof();
    const current = this.#traversals.get(proof.traversalHandle as object);
    if (
      current !== proof.traversal
      || current.closed
      || current.closeReason !== null
      || current.sessions.some((session) => session.poisoned)
      || !current.pins.some((pin) => pin.pinKey === proof.load.pinKey)
    ) {
      throw new InventoryV1CandidateError(
        'candidate-stale-row-proof',
        'verified candidate row proof no longer belongs to a live pinned traversal',
      );
    }
    return proof.snapshot;
  }

  verifyCandidateCatalogPrecommitV1(
    verifiedRow: VerifiedCandidateCatalogRowV1,
    signedHead: SignedAuthorCatalogHeadEnvelopeV1,
    receivedBundleBytes: Uint8Array,
    deployment: CatalogSealDeploymentProfileV1,
    limits?: CgSharedProjectionVerificationLimitsV1,
  ): CandidateCatalogPrecommitResultV1 {
    const candidate = this.readVerifiedCandidateCatalogRow(verifiedRow);
    if (candidate.disposition !== 'present') {
      throw new InventoryV1CandidateError(
        'candidate-row-not-present',
        'removed candidate rows cannot authorize payload transfer or semantic admission',
      );
    }

    let transferredBundle: VerifiedTransferredCatalogBundleV1 | undefined;
    let sharedProjection: VerifiedCgSharedProjectionV1 | undefined;
    let verificationFailed = false;
    let verificationFailure: unknown;
    try {
      // Snapshot every caller-controlled binding input once. The parsed head and
      // deployment copy are the only forms passed to later verifiers, preventing
      // a stateful Proxy from rebinding one candidate between verifier calls.
      const headSnapshot = this.snapshotSignedHead(signedHead);
      const deploymentSnapshot = this.snapshotDeploymentProfile(deployment);
      this.assertCandidateHeadBinding(candidate, headSnapshot);

      transferredBundle = verifyTransferredCatalogBundleV1(
        headSnapshot,
        candidate.row,
        receivedBundleBytes,
        deploymentSnapshot,
      );
      sharedProjection = verifyCgSharedProjectionV1(
        transferredBundle,
        headSnapshot,
        candidate.row,
        deploymentSnapshot,
        limits,
      );

      const metadata = readVerifiedTransferredCatalogBundleMetadataV1(
        transferredBundle,
        headSnapshot,
        candidate.row,
        deploymentSnapshot,
      );
      if (
        metadata.headObjectDigest !== candidate.header.targetCatalogHeadDigest
        || metadata.catalogScopeDigest !== candidate.header.catalogScopeDigest
        || metadata.catalogRowDigest !== candidate.expectedCatalogRowDigest
      ) {
        throw new InventoryV1CandidateError(
          'candidate-binding-changed',
          'verified transfer metadata does not match the live candidate binding',
        );
      }
    } catch (cause) {
      verificationFailed = true;
      verificationFailure = cause;
    }

    // The wire objects above are untrusted JavaScript values. Accessors on a
    // hostile value can re-enter the adapter and close/poison/reopen the
    // originating traversal while core verification is running. Revalidate the
    // exact opaque proof after all input consumption before returning authority.
    let current: CandidateBucketRowSnapshotV1;
    try {
      current = this.readVerifiedCandidateCatalogRow(verifiedRow);
    } catch (cause) {
      throw new InventoryV1CandidateError(
        'candidate-binding-changed',
        'candidate row authority changed during transfer precommit verification',
        { cause },
      );
    }
    if (current !== candidate || current.disposition !== 'present') {
      throw new InventoryV1CandidateError(
        'candidate-binding-changed',
        'candidate row binding changed during transfer precommit verification',
      );
    }
    if (verificationFailed) throw verificationFailure;

    return Object.freeze({
      transferredBundle: transferredBundle!,
      sharedProjection: sharedProjection!,
    });
  }

  private snapshotSignedHead(
    signedHead: SignedAuthorCatalogHeadEnvelopeV1,
  ): SignedAuthorCatalogHeadEnvelopeV1 {
    try {
      const canonicalBytes = canonicalizeSignedAuthorCatalogHeadEnvelopeBytesV1(signedHead);
      const snapshot = parseCanonicalSignedAuthorCatalogHeadEnvelopeV1(canonicalBytes);
      Object.freeze(snapshot.payload);
      Object.freeze(snapshot.signatureEvidence);
      return Object.freeze(snapshot);
    } catch (cause) {
      throw new InventoryV1CandidateError(
        'candidate-head-binding',
        'signed catalog head could not be snapshotted canonically',
        { cause },
      );
    }
  }

  private snapshotDeploymentProfile(
    deployment: CatalogSealDeploymentProfileV1,
  ): Readonly<CatalogSealDeploymentProfileV1> {
    try {
      if (deployment === null || typeof deployment !== 'object' || Array.isArray(deployment)) {
        throw new Error('deployment profile must be an object');
      }
      const keys = Reflect.ownKeys(deployment);
      const expected = ['assertedAtChainId', 'assertedAtKav10Address', 'networkId'];
      const stringKeys = keys.filter((key): key is string => typeof key === 'string');
      if (
        stringKeys.length !== keys.length
        || stringKeys.length !== expected.length
        || [...stringKeys].sort().some((key, index) => key !== expected[index])
      ) {
        throw new Error('deployment profile has unknown or missing fields');
      }
      for (const key of stringKeys) {
        const descriptor = Object.getOwnPropertyDescriptor(deployment, key);
        if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          throw new Error('deployment profile fields must be enumerable data properties');
        }
      }

      // Each scalar getter is consumed exactly once. Core verification validates
      // the resulting plain, frozen profile before using it.
      const networkId = deployment.networkId;
      const assertedAtChainId = deployment.assertedAtChainId;
      const assertedAtKav10Address = deployment.assertedAtKav10Address;
      return Object.freeze({
        networkId,
        assertedAtChainId,
        assertedAtKav10Address,
      });
    } catch (cause) {
      throw new InventoryV1CandidateError(
        'candidate-deployment-profile',
        'deployment profile could not be snapshotted canonically',
        { cause },
      );
    }
  }

  private assertCandidateHeadBinding(
    candidate: CandidateBucketRowSnapshotV1,
    signedHead: SignedAuthorCatalogHeadEnvelopeV1,
  ): void {
    try {
      const scope = deriveAuthorCatalogScopeFromHeadV1(signedHead.payload);
      const scopeDigest = computeAuthorCatalogScopeDigestV1(scope);
      if (
        signedHead.objectDigest !== candidate.header.targetCatalogHeadDigest
        || scopeDigest !== candidate.header.catalogScopeDigest
        || canonicalizeAuthorCatalogScopeV1(scope)
          !== canonicalizeAuthorCatalogScopeV1(candidate.catalogScope)
        || computeAuthorCatalogRowDigestV1(scopeDigest, candidate.row)
          !== candidate.expectedCatalogRowDigest
      ) {
        throw new Error('signed head, catalog scope, and candidate row do not share one binding');
      }
    } catch (cause) {
      if (
        cause instanceof InventoryV1CandidateError
        && cause.code === 'candidate-head-binding'
      ) {
        throw cause;
      }
      throw new InventoryV1CandidateError(
        'candidate-head-binding',
        'signed catalog head does not bind the live candidate row',
        { cause },
      );
    }
  }

  closeCandidateTraversal(
    traversal: CandidateBucketRowsTraversalV1 | CandidateBucketDiffTraversalV1,
  ): void {
    this.assertOpen();
    if (typeof traversal !== 'object' || traversal === null) {
      throw new InventoryV1CandidateError(
        'candidate-invalid-traversal',
        'candidate traversal is not an adapter-local opaque handle',
      );
    }
    const record = this.#traversals.get(traversal as object);
    if (record === undefined) {
      throw new InventoryV1CandidateError(
        'candidate-invalid-traversal',
        'candidate traversal is not an adapter-local opaque handle',
      );
    }
    this.closeTraversalRecord(record);
  }

  discardCandidateSessionBatch(
    sessionHandle: CandidateSessionV1,
  ): CandidateSessionGcBatchResultV1 {
    this.assertOpen();
    const session = this.requireSession(sessionHandle);
    if (!session.poisoned) {
      throw new InventoryV1CandidateError(
        'candidate-session-not-poisoned',
        'only a poisoned candidate session may be discarded through this API',
      );
    }
    const transaction = this.writeTransaction('discard poisoned candidate session', () => {
      const select = this.prepare(INVENTORY_V1_STATEMENT_SQL.discardSessionNext);
      const selected = this.statement(() => select
        .all({ session: session.id }) as SqlRowV1[]);
      const targets = selected.map((row) => this.captureDeleteTarget(row));
      this.deleteExactTargets(targets);
      return Object.freeze({ targets });
    }, {
      resolve: ({ targets }) => this.resolveDeletedTargets(targets),
      retry: ({ targets }) => {
        this.deleteExactTargets(targets);
        return Object.freeze({ targets });
      },
    });
    const result = Object.freeze({
      deletedLoads: transaction.targets.length,
      done: transaction.targets.length === 0,
    });
    if (result.done) {
      this.#sessions.delete(sessionHandle as object);
      this.#sessionRecords.delete(session);
    }
    return result;
  }

  deleteCandidateBucket(loadKey: CandidateBucketLoadKeyV1): void {
    this.assertOpen();
    const key = this.requireLoadKey(loadKey);
    this.assertSessionUsable(key.sessionHandle, key.session);
    if ((this.#pins.get(key.pinKey) ?? 0) !== 0) {
      throw new InventoryV1CandidateError(
        'candidate-in-use',
        'candidate load is pinned by a live traversal',
      );
    }
    this.writeTransaction('delete candidate bucket', () => {
      // Missing is a normal initial API outcome. The stricter missing/mismatch
      // rules in deleteExactTargets apply only after these exact bytes have
      // been captured for an indeterminate-COMMIT retry.
      const storedHeader = this.getRawHeader(key.encoded);
      if (storedHeader === undefined) {
        throw new InventoryV1CandidateError(
          'candidate-not-loaded',
          'candidate bucket header is absent',
        );
      }
      if (!rawHeaderEquals(storedHeader, key.expectedHeader)) {
        throw new InventoryV1CandidateError(
          'candidate-database-corrupt',
          'stored candidate header changed before delete capture',
        );
      }
      const target: DeleteTargetV1 = {
        key: cloneKey(key.encoded),
        header: snapshotEncodedHeader(storedHeader, key.encoded),
        childCount: readStoredDescriptorCount(storedHeader.row_count_u64be),
      };
      this.assertStoredChildCount(target.key, target.childCount);
      this.deleteExactTargets([target]);
      return target;
    }, {
      resolve: (captured) => this.resolveDeletedTargets([captured]),
      retry: (captured) => {
        this.deleteExactTargets([captured]);
        return captured;
      },
    });
  }

  /** Invalidate every process-local capability before the owning database closes. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#available = false;
    this.invalidateTraversals();
    this.#sessionRecords.clear();
    this.#pins.clear();
  }

  private pageDiff(
    traversal: CandidateBucketDiffTraversalV1,
    cursor: KaIdV1 | null | undefined,
    limit: number,
    stream: 'added' | 'removed',
  ): CandidateBucketPageV1 {
    const record = this.requireTraversal(traversal, 'diff');
    try {
      this.assertTraversalSessions(record);
      const terminal = stream === 'added' ? record.addedTerminal : record.removedTerminal;
      if (terminal) throw streamComplete();
      const expected = stream === 'added'
        ? record.addedExpectedCursor
        : record.removedExpectedCursor;
      const canonicalCursor = assertCursor(cursor, expected);
      const page = this.readTransaction(() => {
        const oldHeader = this.requireHeader(record.oldLoad);
        const newHeader = this.requireHeader(record.newLoad);
        assertDiffCompatible(oldHeader, newHeader);
        return this.queryDiffPage(record, canonicalCursor, limit, stream);
      });
      const load = stream === 'added' ? record.newLoad : record.oldLoad;
      const verifiedPage = this.mintVerifiedPage(
        page,
        traversal,
        record,
        load,
        stream === 'removed' ? 'removed' : 'present',
      );
      if (page.rows.length === 0) {
        if (stream === 'added') record.addedTerminal = true;
        else record.removedTerminal = true;
        if (record.addedTerminal && record.removedTerminal) this.closeTraversalRecord(record);
      } else if (stream === 'added') {
        record.addedExpectedCursor = page.resumeAfter;
      } else {
        record.removedExpectedCursor = page.resumeAfter;
      }
      return verifiedPage;
    } catch (cause) {
      this.closeTraversalRecord(record);
      throw normalizeCandidateError(`candidate ${stream} diff page failed`, cause);
    }
  }

  private queryRowsPage(
    load: LoadKeyRecordV1,
    cursor: KaIdV1 | null,
    limit: number,
  ): CandidateBucketDecodedPageV1 {
    assertPageLimit(limit);
    const sql = cursor === null
      ? INVENTORY_V1_STATEMENT_SQL.getRowsFirst
      : INVENTORY_V1_STATEMENT_SQL.getRowsNext;
    const parameters: SqlParametersV1 = {
      ...keyParameters(load.encoded),
      limit,
    };
    if (cursor !== null) parameters.afterKaIdU256be = decimalU256ToSqlBlobV1(cursor);
    const query = this.prepare(sql);
    const rows = this.statement(() => query.all(parameters) as SqlRowV1[]);
    return decodePage(rows, load);
  }

  private queryDiffPage(
    traversal: DiffTraversalRecordV1,
    cursor: KaIdV1 | null,
    limit: number,
    stream: 'added' | 'removed',
  ): CandidateBucketDecodedPageV1 {
    assertPageLimit(limit);
    const sql = stream === 'added'
      ? (cursor === null
        ? INVENTORY_V1_STATEMENT_SQL.diffAddedOrChangedFirst
        : INVENTORY_V1_STATEMENT_SQL.diffAddedOrChangedNext)
      : (cursor === null
        ? INVENTORY_V1_STATEMENT_SQL.diffRemovedFirst
        : INVENTORY_V1_STATEMENT_SQL.diffRemovedNext);
    const parameters: SqlParametersV1 = {
      oldSession: traversal.oldLoad.encoded.session,
      newSession: traversal.newLoad.encoded.session,
      scope: traversal.oldLoad.encoded.scope,
      author: traversal.oldLoad.encoded.author,
      oldHead: traversal.oldLoad.encoded.head,
      newHead: traversal.newLoad.encoded.head,
      bucket: traversal.oldLoad.encoded.bucket,
      limit,
    };
    if (cursor !== null) parameters.afterKaIdU256be = decimalU256ToSqlBlobV1(cursor);
    const query = this.prepare(sql);
    const rows = this.statement(() => query.all(parameters) as SqlRowV1[]);
    return decodePage(rows, stream === 'added' ? traversal.newLoad : traversal.oldLoad);
  }

  private mintVerifiedPage(
    page: CandidateBucketDecodedPageV1,
    traversalHandle: CandidateBucketRowsTraversalV1 | CandidateBucketDiffTraversalV1,
    traversal: TraversalRecordV1,
    load: LoadKeyRecordV1,
    disposition: CandidateBucketRowSnapshotV1['disposition'] = 'present',
  ): CandidateBucketPageV1 {
    const rows = page.rows.map((decoded): CandidateBucketRowV1 => {
      const snapshot: CandidateBucketRowSnapshotV1 = Object.freeze({
        catalogScope: load.scope,
        header: load.publicHeader,
        disposition,
        ...decoded,
      });
      const verifiedRow = Object.freeze(
        Object.create(null),
      ) as VerifiedCandidateCatalogRowV1;
      this.#verifiedRows.set(verifiedRow as object, {
        traversalHandle,
        traversal,
        load,
        snapshot,
      });
      return Object.freeze({
        ...snapshot,
        verifiedRow,
      });
    });
    return Object.freeze({
      rows: Object.freeze(rows),
      resumeAfter: page.resumeAfter,
    });
  }

  private encodeAndVerifyLoad(load: VerifiedCandidateBucketLoadV1): EncodedCandidateLoadV1 {
    try {
      return this.encodeAndVerifyLoadUnchecked(load);
    } catch (cause) {
      if (cause instanceof InventoryV1CandidateError) throw cause;
      throw new InventoryV1CandidateError(
        'candidate-invalid-load',
        'candidate load failed frozen head, descriptor, bucket, or row verification',
        { cause },
      );
    }
  }

  private encodeAndVerifyLoadUnchecked(
    load: VerifiedCandidateBucketLoadV1,
  ): EncodedCandidateLoadV1 {
    const loadRecord = exactPlainRecord(
      load,
      ['bucket', 'directoryPath', 'head', 'session'],
      'load',
    );
    const sessionHandle = loadRecord.session as CandidateSessionV1;
    const session = this.requireSession(sessionHandle);
    assertSignedAuthorCatalogHeadEnvelopeV1(
      loadRecord.head as SignedAuthorCatalogHeadEnvelopeV1,
    );
    const head = loadRecord.head as SignedAuthorCatalogHeadEnvelopeV1;
    const scope = deriveAuthorCatalogScopeFromHeadV1(head.payload);
    const headDigest = head.objectDigest as Digest32V1;
    const scopeDigest = computeAuthorCatalogScopeDigestV1(scope);
    const descriptor = readVerifiedAuthorCatalogBucketDescriptorV1(
      loadRecord.directoryPath,
      head,
    );
    if (BigInt(descriptor.bucketId) >= BigInt(scope.bucketCount)) {
      invalidLoad('descriptor bucketId is outside the head bucket domain');
    }

    const descriptorRows = Number(parseCanonicalDecimalU64(descriptor.rowCount, 'rowCount'));
    const descriptorBytes = Number(parseCanonicalDecimalU64(descriptor.byteLength, 'byteLength'));
    const empty = descriptor.bucketDigest === ZERO_DIGEST32_V1;
    let rows: readonly AuthorCatalogRowV1[];
    if (empty) {
      if (descriptorRows !== 0 || descriptorBytes !== 0 || loadRecord.bucket !== null) {
        invalidLoad('canonical empty bucket requires zero descriptor fields and no bucket object');
      }
      rows = [];
    } else {
      if (descriptorRows < 1 || descriptorRows > MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1) {
        invalidLoad('non-empty descriptor rowCount must be in 1..1024');
      }
      if (descriptorBytes < 1 || descriptorBytes > MAX_AUTHOR_CATALOG_BUCKET_PAYLOAD_BYTES_V1) {
        invalidLoad('non-empty descriptor byteLength must be in 1..1048576');
      }
      if (loadRecord.bucket === null) invalidLoad('non-empty descriptor requires a bucket object');
      assertSignedAuthorCatalogBucketEnvelopeV1(
        loadRecord.bucket as SignedAuthorCatalogBucketEnvelopeV1,
      );
      const bucket = loadRecord.bucket as SignedAuthorCatalogBucketEnvelopeV1;
      if (bucket.objectDigest !== descriptor.bucketDigest) {
        invalidLoad('bucket objectDigest does not equal the verified directory descriptor');
      }
      assertAuthorCatalogBucketV1(bucket.payload);
      assertAuthorCatalogBucketScopeBindingV1(bucket.payload, scope);
      if (bucket.payload.bucketId !== descriptor.bucketId) {
        invalidLoad('bucket payload bucketId does not equal the verified directory descriptor');
      }
      const canonicalLength = canonicalizeAuthorCatalogBucketPayloadBytesV1(
        bucket.payload,
      ).byteLength;
      if (canonicalLength !== descriptorBytes || bucket.payload.rows.length !== descriptorRows) {
        invalidLoad('bucket canonical byte length or child count does not equal its descriptor');
      }
      rows = bucket.payload.rows;
    }

    const encodedKey: EncodedLoadKeyV1 = {
      session: session.id.slice(),
      scope: digest32ToSqlBlobV1(scopeDigest),
      author: evmAddressToSqlBlobV1(scope.authorAddress),
      head: digest32ToSqlBlobV1(headDigest),
      bucket: decimalU64ToSqlBlobV1(descriptor.bucketId),
    };
    const header: EncodedHeaderV1 = {
      ...encodedKey,
      subgraphName: scope.subGraphName,
      era: decimalU64ToSqlBlobV1(scope.era),
      bucketCount: decimalU64ToSqlBlobV1(scope.bucketCount),
      bucketObjectDigest: digest32ToSqlBlobV1(descriptor.bucketDigest),
      rowCount: decimalU64ToSqlBlobV1(descriptor.rowCount),
      payloadByteLength: decimalU64ToSqlBlobV1(descriptor.byteLength),
    };
    const encodedRows = rows.map((row): EncodedRowV1 => ({
      ...encodedKey,
      kaId: decimalU256ToSqlBlobV1(row.kaId),
      catalogKeyDigest: digest32ToSqlBlobV1(computeAuthorCatalogKeyDigestV1(row.kaId)),
      assertionCoordinate: row.assertionCoordinate,
      assertionVersion: decimalU64ToSqlBlobV1(row.assertionVersion),
      projectionId: row.projectionId,
      projectionDigest: digest32ToSqlBlobV1(row.projectionDigest),
      sealDigest: digest32ToSqlBlobV1(row.sealDigest),
      transferCodec: row.transfer.codec,
      transferByteLength: decimalU64ToSqlBlobV1(row.transfer.byteLength),
      transferChunkSize: decimalU64ToSqlBlobV1(
        row.transfer.chunkSize as DecimalU64V1,
      ),
      transferChunkCount: decimalU64ToSqlBlobV1(row.transfer.chunkCount),
      transferBlobDigest: digest32ToSqlBlobV1(row.transfer.blobDigest),
      transferChunkTreeRoot: digest32ToSqlBlobV1(row.transfer.chunkTreeRoot),
      expectedCatalogRowDigest: digest32ToSqlBlobV1(
        computeAuthorCatalogRowDigestV1(scopeDigest, row),
      ),
    }));
    const publicHeader: CandidateBucketHeaderV1 = Object.freeze({
      catalogScopeDigest: scopeDigest,
      authorAddress: scope.authorAddress,
      targetCatalogHeadDigest: headDigest,
      subGraphName: scope.subGraphName,
      catalogEra: scope.era,
      bucketCount: scope.bucketCount,
      bucketId: descriptor.bucketId,
      bucketObjectDigest: descriptor.bucketDigest,
      rowCount: descriptor.rowCount,
      payloadByteLength: descriptor.byteLength,
    });
    return {
      sessionHandle,
      session,
      header,
      rows: encodedRows,
      publicHeader,
      scope: Object.freeze({ ...scope }),
      context: {
        scopeHex: bytesToHex(header.scope),
        authorHex: bytesToHex(header.author),
        subGraphName: header.subgraphName,
        eraHex: bytesToHex(header.era),
        bucketCountHex: bytesToHex(header.bucketCount),
      },
    };
  }

  private createLoadKey(load: EncodedCandidateLoadV1): CandidateBucketLoadKeyV1 {
    const handle = Object.freeze({}) as CandidateBucketLoadKeyV1;
    const encoded = cloneKey(load.header);
    this.#loadKeys.set(handle as object, {
      sessionHandle: load.sessionHandle,
      session: load.session,
      encoded,
      expectedHeader: cloneHeader(load.header),
      publicHeader: load.publicHeader,
      scope: Object.freeze({ ...load.scope }),
      pinKey: pinKey(encoded),
    });
    return handle;
  }

  private requireSession(handle: CandidateSessionV1): SessionRecordV1 {
    if (typeof handle !== 'object' || handle === null) {
      throw invalidSession();
    }
    const session = this.#sessions.get(handle as object);
    if (session === undefined) throw invalidSession();
    return session;
  }

  private requireLoadKey(handle: CandidateBucketLoadKeyV1): LoadKeyRecordV1 {
    if (typeof handle !== 'object' || handle === null) {
      throw new InventoryV1CandidateError(
        'candidate-invalid-load-key',
        'candidate load key is not an adapter-local opaque handle',
      );
    }
    const key = this.#loadKeys.get(handle as object);
    if (key === undefined) {
      throw new InventoryV1CandidateError(
        'candidate-invalid-load-key',
        'candidate load key is not an adapter-local opaque handle',
      );
    }
    return key;
  }

  private requireTraversal<TKind extends TraversalRecordV1['kind']>(
    handle: object,
    kind: TKind,
  ): Extract<TraversalRecordV1, { kind: TKind }> {
    this.assertOpen();
    if (typeof handle !== 'object' || handle === null) {
      throw new InventoryV1CandidateError(
        'candidate-invalid-traversal',
        'candidate traversal is not an adapter-local opaque handle',
      );
    }
    const traversal = this.#traversals.get(handle);
    if (traversal === undefined || traversal.kind !== kind) {
      throw new InventoryV1CandidateError(
        'candidate-invalid-traversal',
        `candidate traversal is not an adapter-local ${kind} handle`,
      );
    }
    if (
      traversal.closeReason === 'poisoned'
      || traversal.sessions.some((session) => session.poisoned)
    ) {
      throw new InventoryV1CandidateError(
        'candidate-session-poisoned',
        'candidate traversal references a poisoned session',
      );
    }
    if (traversal.closed) {
      throw new InventoryV1CandidateError(
        'candidate-traversal-closed',
        'candidate traversal is closed',
      );
    }
    return traversal as Extract<TraversalRecordV1, { kind: TKind }>;
  }

  private requireHeader(key: LoadKeyRecordV1): CandidateBucketHeaderV1 {
    const row = this.getRawHeader(key.encoded);
    if (row === undefined) {
      throw new InventoryV1CandidateError(
        'candidate-not-loaded',
        'candidate bucket header is absent',
      );
    }
    if (!rawHeaderEquals(row, key.expectedHeader)) {
      throw new InventoryV1CandidateError(
        'candidate-database-corrupt',
        'stored candidate header no longer equals its verified directory-path load',
      );
    }
    const header = decodeHeader(row, key);
    assertVerifiedHeaderScopeBinding(header, key);
    return header;
  }

  private requireHeaderAndExactChildCount(
    key: LoadKeyRecordV1,
  ): CandidateBucketHeaderV1 {
    const header = this.requireHeader(key);
    this.assertStoredChildCount(key.encoded, Number(BigInt(header.rowCount)));
    return header;
  }

  private getRawHeader(key: EncodedLoadKeyV1): SqlRowV1 | undefined {
    const query = this.prepare(INVENTORY_V1_STATEMENT_SQL.getHeader);
    return this.statement(() => query
      .get({ ...keyParameters(key) }) as SqlRowV1 | undefined);
  }

  private captureDeleteTarget(row: SqlRowV1): DeleteTargetV1 {
    const key: EncodedLoadKeyV1 = {
      session: assertSqlKeyBlob(row.session_id, 32, 'selected session_id'),
      scope: assertSqlKeyBlob(row.catalog_scope_digest, 32, 'selected catalog_scope_digest'),
      author: assertSqlKeyBlob(row.author_address, 20, 'selected author_address'),
      head: assertSqlKeyBlob(row.target_catalog_head_digest, 32, 'selected target head'),
      bucket: assertSqlKeyBlob(row.bucket_id_u64be, 8, 'selected bucket_id'),
    };
    // Keep the bounded selector byte-for-byte aligned with the frozen RFC.
    // Re-read the exact immutable header inside the same transaction before
    // trusting its signed child-count projection for the cascade bound.
    const storedHeader = this.getRawHeader(key);
    if (storedHeader === undefined) {
      throw new InventoryV1CandidateError(
        'candidate-database-corrupt',
        'bounded candidate GC selection lost its exact header',
      );
    }
    const header = snapshotEncodedHeader(storedHeader, key);
    const childCount = readStoredDescriptorCount(header.rowCount);
    this.assertStoredChildCount(key, childCount);
    return Object.freeze({ key: cloneKey(key), header, childCount });
  }

  private deleteExactTargets(targets: readonly DeleteTargetV1[]): void {
    const remove = this.prepare(INVENTORY_V1_STATEMENT_SQL.deleteHeader);
    for (const target of targets) {
      const storedHeader = this.getRawHeader(target.key);
      if (storedHeader === undefined) {
        throw new InventoryV1CandidateError(
          'candidate-database-corrupt',
          'exact candidate delete target disappeared before its bounded retry',
        );
      }
      if (!rawHeaderEquals(storedHeader, target.header)) {
        throw new InventoryV1CandidateError(
          'candidate-database-corrupt',
          'exact candidate delete target changed before its bounded retry',
        );
      }
      this.assertStoredChildCount(target.key, target.childCount);
      const result = this.statement(() => remove.run(keyParameters(target.key)));
      if (Number(result.changes) !== 1) {
        throw new InventoryV1CandidateError(
          'candidate-database-corrupt',
          'bounded candidate delete did not remove exactly one immutable header',
        );
      }
    }
  }

  private resolveDeletedTargets(
    targets: readonly DeleteTargetV1[],
  ): IndeterminateCommitResolutionV1 {
    if (targets.length === 0) return 'committed';
    let absent = 0;
    let present = 0;
    for (const target of targets) {
      const storedHeader = this.getRawHeader(target.key);
      if (storedHeader === undefined) {
        absent += 1;
        continue;
      }
      present += 1;
      if (!rawHeaderEquals(storedHeader, target.header)) {
        throw new InventoryV1CandidateError(
          'candidate-database-corrupt',
          'indeterminate candidate delete resolved to a mismatched exact-key header',
        );
      }
      this.assertStoredChildCount(target.key, target.childCount);
    }
    if (absent === targets.length) return 'committed';
    if (present === targets.length) return 'not-committed';
    throw new InventoryV1CandidateError(
      'candidate-database-corrupt',
      'indeterminate bounded candidate delete resolved to a mixed key set',
    );
  }

  private stageExactCandidateLoad(
    encoded: EncodedCandidateLoadV1,
  ): CandidateBucketPutResultV1['status'] {
    const storedHeader = this.getRawHeader(encoded.header);
    if (storedHeader !== undefined) {
      if (!this.exactCandidateLoadMatches(encoded, storedHeader)) {
        throw new CandidateConflictSignal('same load key has different immutable bytes');
      }
      return 'existing';
    }
    const insertHeader = this.prepare(INVENTORY_V1_STATEMENT_SQL.insertHeader);
    this.statement(() => insertHeader.run(headerParameters(encoded.header)));
    const insertRow = this.prepare(INVENTORY_V1_STATEMENT_SQL.insertRow);
    for (const row of encoded.rows) {
      this.statement(() => insertRow.run(rowParameters(row)));
    }
    this.assertStoredChildCount(encoded.header, encoded.rows.length);
    return 'inserted';
  }

  private exactCandidateLoadMatches(
    encoded: EncodedCandidateLoadV1,
    storedHeader = this.getRawHeader(encoded.header),
  ): boolean {
    if (storedHeader === undefined || !rawHeaderEquals(storedHeader, encoded.header)) return false;
    const selectExactRows = this.prepare(INVENTORY_V1_STATEMENT_SQL.getRowsExactRetry);
    const storedRows = this.statement(() => selectExactRows.all({
      ...keyParameters(encoded.header),
    }) as SqlRowV1[]);
    return storedRows.length === encoded.rows.length
      && storedRows.every((row, index) => rawRowEquals(row, encoded.rows[index]!));
  }

  private resolvePutOutcome(
    encoded: EncodedCandidateLoadV1,
  ): IndeterminateCommitResolutionV1 {
    const storedHeader = this.getRawHeader(encoded.header);
    if (storedHeader === undefined) return 'not-committed';
    if (this.exactCandidateLoadMatches(encoded, storedHeader)) return 'committed';
    throw new CandidateConflictSignal(
      'indeterminate candidate put resolved to partial or mismatched immutable bytes',
    );
  }

  private assertStoredChildCount(key: EncodedLoadKeyV1, expectedCount: number): void {
    const countRows = this.prepare(INVENTORY_V1_STATEMENT_SQL.countBucketRows);
    const countRow = this.statement(() => countRows
      .get({ ...keyParameters(key) }) as SqlRowV1 | undefined);
    const actualCount = readSafeCount(countRow?.row_count);
    if (
      actualCount !== expectedCount
      || actualCount > MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1
    ) {
      throw new InventoryV1CandidateError(
        'candidate-database-corrupt',
        'candidate cascade child count is inconsistent or exceeds the 1024-row bound',
      );
    }
  }

  private readTransaction<T>(operation: () => T): T {
    this.assertOpen();
    const transactionStartedAt = this.monotonicNow();
    try {
      this.statement(() => this.database.exec('BEGIN'));
    } catch (cause) {
      const rollback = rollbackIfOpen(this.database, this.monotonicNow);
      const overBudget = cause instanceof LatencyBudgetSignal
        || rollback.overran
        || this.monotonicNow() - transactionStartedAt > WRITE_TRANSACTION_LATENCY_BUDGET_MS;
      if (rollback.failed || overBudget) this.requireReopen();
      if (overBudget) throw latencyBudgetError(cause);
      throw databaseError('candidate read transaction failed to begin', cause);
    }

    let result: T;
    try {
      result = operation();
    } catch (cause) {
      const rollback = rollbackIfOpen(this.database, this.monotonicNow);
      const overBudget = cause instanceof LatencyBudgetSignal
        || rollback.overran
        || this.monotonicNow() - transactionStartedAt > WRITE_TRANSACTION_LATENCY_BUDGET_MS;
      if (rollback.failed || overBudget) this.requireReopen();
      if (overBudget) throw latencyBudgetError(cause);
      if (cause instanceof InventoryV1CandidateError) throw cause;
      throw databaseError('candidate read transaction failed', cause);
    }

    try {
      this.statement(() => this.database.exec('COMMIT'));
    } catch (cause) {
      // Even though a read-only COMMIT has no durable write outcome, its
      // low-level connection state is indeterminate. Discard the read result,
      // invalidate traversals, and require the caller to retry after a verified
      // reopen rather than continuing on that handle.
      rollbackIfOpen(this.database, this.monotonicNow);
      this.requireReopen();
      if (cause instanceof LatencyBudgetSignal) throw latencyBudgetError(cause);
      throw databaseError('candidate read COMMIT failed after verified reopen', cause);
    }
    return result;
  }

  private writeTransaction<T>(
    label: string,
    operation: () => T,
    indeterminate?: IndeterminateCommitStrategyV1<T>,
    attempt = 0,
    writeDeadline = this.monotonicNow() + WRITE_TRANSACTION_LATENCY_BUDGET_MS,
  ): T {
    this.assertOpen();
    const ownsDeadline = this.#activeWriteDeadline === null;
    if (ownsDeadline) this.#activeWriteDeadline = writeDeadline;
    else if (this.#activeWriteDeadline !== writeDeadline) {
      throw databaseError(`${label} attempted to replace the active write deadline`, undefined);
    }
    const transactionStartedAt = this.monotonicNow();
    try {
      try {
        this.statement(() => this.database.exec('BEGIN IMMEDIATE'));
      } catch (cause) {
        const rollback = rollbackIfOpen(this.database, this.monotonicNow, writeDeadline);
        const overBudget = cause instanceof LatencyBudgetSignal || rollback.overran;
        if (rollback.failed || overBudget) {
          try {
            this.requireReopen(writeDeadline);
          } catch (reopenCause) {
            if (overBudget) throw latencyBudgetError(cause);
            throw reopenCause;
          }
        }
        if (overBudget) throw latencyBudgetError(cause);
        throw databaseError(`${label} failed to begin`, cause);
      }

      let result: T;
      try {
        this.assertWriteDeadline('before write operation');
        result = operation();
        this.assertWriteDeadline('after write operation');
      } catch (cause) {
        const rollback = rollbackIfOpen(this.database, this.monotonicNow, writeDeadline);
        const overBudget = cause instanceof LatencyBudgetSignal || rollback.overran;
        if (rollback.failed || overBudget) {
          try {
            this.requireReopen(writeDeadline);
          } catch (reopenCause) {
            if (overBudget) throw latencyBudgetError(cause);
            throw reopenCause;
          }
        }
        if (overBudget) throw latencyBudgetError(cause);
        if (
          cause instanceof InventoryV1CandidateError
          || cause instanceof CandidateConflictSignal
          || isSqliteUniqueOrPrimaryKeyConstraint(cause)
        ) {
          throw cause;
        }
        throw databaseError(`${label} failed before commit`, cause);
      }

      const commitStartedAt = this.monotonicNow();
      try {
        this.statement(() => this.database.exec('COMMIT'));
      } catch (cause) {
        if (cause instanceof LatencyBudgetSignal && cause.callCompleted) {
          // The synchronous COMMIT call returned successfully; only the
          // post-call budget check failed. Its durable outcome is therefore
          // known committed even if the mandatory verified reopen later fails.
          this.#committedOverruns += 1;
          this.reopenAfterKnownCommit(writeDeadline);
          return result;
        }
        // Never issue ROLLBACK after an indeterminate COMMIT. Close the low-level
        // handle, perform the foundation's full verified reopen, and inspect only
        // the immutable key set captured by the failed attempt.
        this.requireReopen(writeDeadline);
        if (indeterminate === undefined) {
          throw databaseError(
            `${label} COMMIT failed without an exact-key outcome resolver`,
            cause,
          );
        }
        let resolution: IndeterminateCommitResolutionV1;
        try {
          this.assertWriteDeadline('before indeterminate COMMIT resolution');
          resolution = indeterminate.resolve(result);
          this.assertWriteDeadline('after indeterminate COMMIT resolution');
        } catch (resolutionCause) {
          if (resolutionCause instanceof LatencyBudgetSignal) {
            this.requireReopen(writeDeadline);
            throw latencyBudgetError(resolutionCause);
          }
          throw resolutionCause;
        }
        if (resolution === 'committed') {
          if (cause instanceof LatencyBudgetSignal) this.#committedOverruns += 1;
          return indeterminate.resolvedCommittedResult?.(result) ?? result;
        }
        this.assertWriteDeadline('before exact-key write retry');
        if (attempt !== 0) {
          throw databaseError(
            `${label} COMMIT remained not-committed after one exact-key retry`,
            cause,
          );
        }
        return this.writeTransaction(
          label,
          () => {
            this.assertWriteDeadline('before exact-key retry callback');
            const retried = indeterminate.retry(result);
            this.assertWriteDeadline('after exact-key retry callback');
            return retried;
          },
          indeterminate,
          attempt + 1,
          writeDeadline,
        );
      }
      const commitElapsed = this.monotonicNow() - commitStartedAt;
      const transactionElapsed = this.monotonicNow() - transactionStartedAt;
      if (
        commitElapsed > STATEMENT_LATENCY_BUDGET_MS
        || transactionElapsed >= WRITE_TRANSACTION_LATENCY_BUDGET_MS
      ) {
        this.#committedOverruns += 1;
        this.reopenAfterKnownCommit(writeDeadline);
      }
      return result;
    } finally {
      if (ownsDeadline) this.#activeWriteDeadline = null;
    }
  }

  private statement<T>(operation: () => T): T {
    this.assertWriteDeadline('before SQLite call');
    const startedAt = this.monotonicNow();
    try {
      const result = operation();
      const completedAt = this.monotonicNow();
      if (completedAt - startedAt > STATEMENT_LATENCY_BUDGET_MS) {
        throw new LatencyBudgetSignal('SQLite statement exceeded 10000 ms', {
          callCompleted: true,
        });
      }
      this.assertWriteDeadline('after SQLite call', completedAt, true);
      return result;
    } catch (cause) {
      if (cause instanceof LatencyBudgetSignal) throw cause;
      if (this.monotonicNow() - startedAt > STATEMENT_LATENCY_BUDGET_MS) {
        throw new LatencyBudgetSignal('failed SQLite statement exceeded 10000 ms', { cause });
      }
      this.assertWriteDeadline('after failed SQLite call');
      throw cause;
    }
  }

  private prepare(sql: string): StatementSync {
    return this.statement(() => this.database.prepare(sql));
  }

  private requireReopen(writeDeadline = this.#activeWriteDeadline): void {
    if (this.#closed || !this.#available) {
      throw new InventoryV1CandidateError(
        'candidate-database-error',
        'candidate inventory is unavailable and cannot reopen',
      );
    }
    this.invalidateTraversals();
    const previous = this.database;
    // Mark unavailable before invoking external lifecycle code. No exception,
    // identity return, malformed handle, or failed verification can leave this
    // adapter usable on the abandoned connection.
    this.#available = false;
    let reopened: DatabaseSync | null = null;
    try {
      const beforeReopen = this.monotonicNow();
      reopened = this.onRequireReopen(previous);
      if (reopened === previous) {
        throw new Error('verified reopen provider returned the abandoned low-level handle');
      }
      const afterReopen = this.monotonicNow();
      assertReopenDeadline(beforeReopen, writeDeadline, 'before verified reopen');
      assertReopenDeadline(afterReopen, writeDeadline, 'after verified reopen');
      assertUsableReopenedDatabase(reopened, this.monotonicNow, writeDeadline);
      this.database = reopened;
      this.#available = true;
    } catch (cause) {
      // A lifecycle owner may attach the replacement before returning it.
      // Detach first and close second so a rejected identity/probe/deadline
      // result can never leave the foundation pointing at a stale handle.
      if (reopened !== null) {
        try { this.onRejectReopened(reopened); } catch { /* remain unavailable */ }
      }
      // Direct/internal providers are required to abandon the prior handle,
      // but a malformed provider might return before doing so.
      try { previous.close(); } catch { /* remain unavailable */ }
      if (cause instanceof LatencyBudgetSignal) throw latencyBudgetError(cause);
      if (
        cause instanceof InventoryV1CandidateError
        && cause.code === 'latency-budget-exceeded'
      ) {
        throw cause;
      }
      throw new InventoryV1CandidateError(
        'candidate-database-error',
        'verified low-level inventory reopen failed; the foundation remains unavailable',
        { cause },
      );
    }
  }

  /**
   * A successful COMMIT is authoritative even if the mandatory post-overrun
   * reopen fails. Preserve its result, but make every subsequent API fail
   * closed through #available/the owning foundation's closed connection.
   */
  private reopenAfterKnownCommit(writeDeadline: number): void {
    try {
      this.requireReopen(writeDeadline);
    } catch {
      // requireReopen already marked the candidate adapter unavailable and the
      // foundation callback closed/detached the low-level connection.
    }
  }

  private invalidateTraversals(): void {
    for (const session of this.#sessionRecords) {
      for (const traversal of [...session.traversals]) {
        this.closeTraversalRecord(traversal, 'reopen');
      }
    }
  }

  private registerTraversal(record: TraversalRecordV1): object {
    const handle = Object.freeze({});
    this.#traversals.set(handle, record);
    for (const session of record.sessions) session.traversals.add(record);
    for (const pin of record.pins) {
      this.#pins.set(pin.pinKey, (this.#pins.get(pin.pinKey) ?? 0) + 1);
    }
    return handle;
  }

  private closeTraversalRecord(
    record: TraversalRecordV1,
    reason: Exclude<TraversalBaseV1['closeReason'], null> = 'normal',
  ): void {
    if (record.closed) return;
    record.closed = true;
    record.closeReason = reason;
    for (const session of record.sessions) session.traversals.delete(record);
    for (const pin of record.pins) {
      const count = this.#pins.get(pin.pinKey) ?? 0;
      if (count <= 1) this.#pins.delete(pin.pinKey);
      else this.#pins.set(pin.pinKey, count - 1);
    }
  }

  private assertSessionUsable(handle: CandidateSessionV1, session: SessionRecordV1): void {
    if (this.#sessions.get(handle as object) !== session) throw invalidSession();
    if (session.poisoned) {
      throw new InventoryV1CandidateError(
        'candidate-session-poisoned',
        'candidate session is poisoned and must be abandoned',
      );
    }
  }

  private assertTraversalSessions(record: TraversalRecordV1): void {
    for (const session of record.sessions) {
      if (session.poisoned) {
        throw new InventoryV1CandidateError(
          'candidate-session-poisoned',
          'candidate traversal references a poisoned session',
        );
      }
    }
  }

  private poison(session: SessionRecordV1): void {
    if (session.poisoned) return;
    session.poisoned = true;
    for (const traversal of [...session.traversals]) {
      this.closeTraversalRecord(traversal, 'poisoned');
    }
  }

  private assertOpen(): void {
    if (this.#closed || !this.#available) {
      throw new InventoryV1CandidateError(
        'candidate-database-error',
        this.#closed
          ? 'candidate inventory adapter is closed'
          : 'candidate inventory adapter is unavailable after failed verified reopen',
      );
    }
  }

  private assertWriteDeadline(
    label: string,
    now = this.monotonicNow(),
    callCompleted = false,
  ): void {
    if (this.#activeWriteDeadline !== null && now >= this.#activeWriteDeadline) {
      throw new LatencyBudgetSignal(`${label} reached the absolute 30000 ms write deadline`, {
        callCompleted,
      });
    }
  }
}

class CandidateConflictSignal extends Error {}
class LatencyBudgetSignal extends Error {
  readonly callCompleted: boolean;

  constructor(
    message: string,
    options: ErrorOptions & { readonly callCompleted?: boolean } = {},
  ) {
    super(message, options);
    this.name = 'LatencyBudgetSignal';
    this.callCompleted = options.callCompleted ?? false;
  }
}

function extractCandidateLoadSession(load: unknown): CandidateSessionV1 {
  if (typeof load !== 'object' || load === null || Object.getPrototypeOf(load) !== Object.prototype) {
    invalidLoad('load must be a plain object');
  }
  const descriptor = Object.getOwnPropertyDescriptor(load, 'session');
  if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    invalidLoad('load.session must be an enumerable data property');
  }
  return descriptor.value as CandidateSessionV1;
}

function canonicalU64(value: unknown, label: string): DecimalU64V1 {
  try {
    return parseCanonicalDecimalU64(value, label).toString() as DecimalU64V1;
  } catch (cause) {
    throw new InventoryV1CandidateError(
      'candidate-invalid-load',
      `${label} is not a canonical DecimalU64V1`,
      { cause },
    );
  }
}

function exactPlainRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    invalidLoad(`${label} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    invalidLoad(`${label} has an invalid field set`);
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      invalidLoad(`${label}.${key} must be an enumerable data property`);
    }
  }
  return value as Record<string, unknown>;
}

function cloneKey(key: EncodedLoadKeyV1): EncodedLoadKeyV1 {
  return {
    session: key.session.slice(),
    scope: key.scope.slice(),
    author: key.author.slice(),
    head: key.head.slice(),
    bucket: key.bucket.slice(),
  };
}

function cloneHeader(header: EncodedHeaderV1): EncodedHeaderV1 {
  return {
    ...cloneKey(header),
    subgraphName: header.subgraphName,
    era: header.era.slice(),
    bucketCount: header.bucketCount.slice(),
    bucketObjectDigest: header.bucketObjectDigest.slice(),
    rowCount: header.rowCount.slice(),
    payloadByteLength: header.payloadByteLength.slice(),
  };
}

function snapshotEncodedHeader(
  row: SqlRowV1,
  key: EncodedLoadKeyV1,
): EncodedHeaderV1 {
  const rawSubgraphName = row.subgraph_name;
  let subgraphName: string | null;
  if (rawSubgraphName === null) {
    subgraphName = null;
  } else if (typeof rawSubgraphName === 'string') {
    subgraphName = rawSubgraphName;
  } else {
    throw new InventoryV1CandidateError(
      'candidate-database-corrupt',
      'stored candidate subgraph_name is neither text nor NULL',
    );
  }
  return {
    ...cloneKey(key),
    subgraphName,
    era: assertSqlKeyBlob(row.catalog_era_u64be, 8, 'stored catalog era'),
    bucketCount: assertSqlKeyBlob(row.bucket_count_u64be, 8, 'stored bucket count'),
    bucketObjectDigest: assertSqlKeyBlob(
      row.bucket_object_digest,
      32,
      'stored bucket object digest',
    ),
    rowCount: assertSqlKeyBlob(row.row_count_u64be, 8, 'stored row count'),
    payloadByteLength: assertSqlKeyBlob(
      row.payload_byte_length_u64be,
      8,
      'stored payload byte length',
    ),
  };
}

function keyParameters(key: EncodedLoadKeyV1): SqlParametersV1 {
  return {
    session: key.session,
    scope: key.scope,
    author: key.author,
    head: key.head,
    bucket: key.bucket,
  };
}

function headerParameters(header: EncodedHeaderV1): SqlParametersV1 {
  return {
    ...keyParameters(header),
    subgraphName: header.subgraphName,
    era: header.era,
    bucketCount: header.bucketCount,
    bucketObjectDigest: header.bucketObjectDigest,
    rowCount: header.rowCount,
    payloadByteLength: header.payloadByteLength,
  };
}

function rowParameters(row: EncodedRowV1): SqlParametersV1 {
  return {
    ...keyParameters(row),
    kaId: row.kaId,
    catalogKeyDigest: row.catalogKeyDigest,
    assertionCoordinate: row.assertionCoordinate,
    assertionVersion: row.assertionVersion,
    projectionId: row.projectionId,
    projectionDigest: row.projectionDigest,
    sealDigest: row.sealDigest,
    transferCodec: row.transferCodec,
    transferByteLength: row.transferByteLength,
    transferChunkSize: row.transferChunkSize,
    transferChunkCount: row.transferChunkCount,
    transferBlobDigest: row.transferBlobDigest,
    transferChunkTreeRoot: row.transferChunkTreeRoot,
    expectedCatalogRowDigest: row.expectedCatalogRowDigest,
  };
}

function rawHeaderEquals(row: SqlRowV1, header: EncodedHeaderV1): boolean {
  return sqlBlobsEqualV1(row.session_id, header.session)
    && sqlBlobsEqualV1(row.catalog_scope_digest, header.scope)
    && sqlBlobsEqualV1(row.author_address, header.author)
    && sqlBlobsEqualV1(row.target_catalog_head_digest, header.head)
    && row.subgraph_name === header.subgraphName
    && sqlBlobsEqualV1(row.catalog_era_u64be, header.era)
    && sqlBlobsEqualV1(row.bucket_count_u64be, header.bucketCount)
    && sqlBlobsEqualV1(row.bucket_id_u64be, header.bucket)
    && sqlBlobsEqualV1(row.bucket_object_digest, header.bucketObjectDigest)
    && sqlBlobsEqualV1(row.row_count_u64be, header.rowCount)
    && sqlBlobsEqualV1(row.payload_byte_length_u64be, header.payloadByteLength);
}

function rawRowEquals(row: SqlRowV1, expected: EncodedRowV1): boolean {
  return sqlBlobsEqualV1(row.session_id, expected.session)
    && sqlBlobsEqualV1(row.catalog_scope_digest, expected.scope)
    && sqlBlobsEqualV1(row.author_address, expected.author)
    && sqlBlobsEqualV1(row.target_catalog_head_digest, expected.head)
    && sqlBlobsEqualV1(row.bucket_id_u64be, expected.bucket)
    && sqlBlobsEqualV1(row.ka_id_u256be, expected.kaId)
    && sqlBlobsEqualV1(row.catalog_key_digest, expected.catalogKeyDigest)
    && row.assertion_coordinate === expected.assertionCoordinate
    && sqlBlobsEqualV1(row.assertion_version_u64be, expected.assertionVersion)
    && row.projection_id === expected.projectionId
    && sqlBlobsEqualV1(row.projection_digest, expected.projectionDigest)
    && sqlBlobsEqualV1(row.seal_digest, expected.sealDigest)
    && row.transfer_codec === expected.transferCodec
    && sqlBlobsEqualV1(row.transfer_byte_length_u64be, expected.transferByteLength)
    && sqlBlobsEqualV1(row.transfer_chunk_size_u64be, expected.transferChunkSize)
    && sqlBlobsEqualV1(row.transfer_chunk_count_u64be, expected.transferChunkCount)
    && sqlBlobsEqualV1(row.transfer_blob_digest, expected.transferBlobDigest)
    && sqlBlobsEqualV1(row.transfer_chunk_tree_root, expected.transferChunkTreeRoot)
    && sqlBlobsEqualV1(row.expected_catalog_row_digest, expected.expectedCatalogRowDigest);
}

function decodeHeader(row: SqlRowV1, key: LoadKeyRecordV1): CandidateBucketHeaderV1 {
  try {
    if (
      !sqlBlobsEqualV1(row.session_id, key.encoded.session)
      || !sqlBlobsEqualV1(row.catalog_scope_digest, key.encoded.scope)
      || !sqlBlobsEqualV1(row.author_address, key.encoded.author)
      || !sqlBlobsEqualV1(row.target_catalog_head_digest, key.encoded.head)
      || !sqlBlobsEqualV1(row.bucket_id_u64be, key.encoded.bucket)
    ) {
      throw new Error('header primary-key bytes do not match the requested load key');
    }
    const subGraphName = row.subgraph_name;
    if (subGraphName !== null) {
      assertSubGraphNameV1(subGraphName, 'stored subGraphName');
    }
    const bucketCount = sqlBlobToDecimalU64V1(row.bucket_count_u64be) as CountV1;
    assertAuthorCatalogBucketCountV1(bucketCount);
    const bucketId = sqlBlobToDecimalU64V1(row.bucket_id_u64be);
    if (BigInt(bucketId) >= BigInt(bucketCount)) throw new Error('stored bucketId is out of range');
    const rowCount = sqlBlobToDecimalU64V1(row.row_count_u64be) as CountV1;
    const payloadByteLength = sqlBlobToDecimalU64V1(row.payload_byte_length_u64be) as ByteLengthV1;
    const bucketObjectDigest = sqlBlobToDigest32V1(row.bucket_object_digest);
    const empty = bucketObjectDigest === ZERO_DIGEST32_V1;
    if (
      empty !== (rowCount === '0' && payloadByteLength === '0')
      || BigInt(rowCount) > BigInt(MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1)
      || BigInt(payloadByteLength) > BigInt(MAX_AUTHOR_CATALOG_BUCKET_PAYLOAD_BYTES_V1)
    ) {
      throw new Error('stored bucket descriptor is not canonical');
    }
    return Object.freeze({
      catalogScopeDigest: sqlBlobToDigest32V1(row.catalog_scope_digest),
      authorAddress: sqlBlobToEvmAddressV1(row.author_address),
      targetCatalogHeadDigest: sqlBlobToDigest32V1(row.target_catalog_head_digest),
      subGraphName: subGraphName as SubGraphNameV1 | null,
      catalogEra: sqlBlobToDecimalU64V1(row.catalog_era_u64be),
      bucketCount,
      bucketId,
      bucketObjectDigest,
      rowCount,
      payloadByteLength,
    });
  } catch (cause) {
    throw new InventoryV1CandidateError(
      'candidate-database-corrupt',
      'stored candidate header violates the frozen SQL-1 codec',
      { cause },
    );
  }
}

function assertVerifiedHeaderScopeBinding(
  header: CandidateBucketHeaderV1,
  key: LoadKeyRecordV1,
): void {
  const recomputedScopeDigest = computeAuthorCatalogScopeDigestV1(key.scope);
  const expectedHeadDigest = sqlBlobToDigest32V1(key.expectedHeader.head);
  if (
    header.catalogScopeDigest !== recomputedScopeDigest
    || header.authorAddress !== key.scope.authorAddress
    || header.subGraphName !== key.scope.subGraphName
    || header.catalogEra !== key.scope.era
    || header.bucketCount !== key.scope.bucketCount
    || header.targetCatalogHeadDigest !== expectedHeadDigest
  ) {
    throw new InventoryV1CandidateError(
      'candidate-database-corrupt',
      'stored candidate header is not bound to the verified head-derived catalog scope',
    );
  }
}

function decodePage(
  rows: readonly SqlRowV1[],
  key: LoadKeyRecordV1,
): CandidateBucketDecodedPageV1 {
  const decoded = rows.map((row) => decodeRow(row, key));
  return Object.freeze({
    rows: Object.freeze(decoded),
    resumeAfter: decoded.length === 0 ? null : decoded[decoded.length - 1]!.row.kaId,
  });
}

function decodeRow(row: SqlRowV1, key: LoadKeyRecordV1): DecodedCandidateBucketRowV1 {
  try {
    if (
      !sqlBlobsEqualV1(row.session_id, key.encoded.session)
      || !sqlBlobsEqualV1(row.catalog_scope_digest, key.encoded.scope)
      || !sqlBlobsEqualV1(row.author_address, key.encoded.author)
      || !sqlBlobsEqualV1(row.target_catalog_head_digest, key.encoded.head)
      || !sqlBlobsEqualV1(row.bucket_id_u64be, key.encoded.bucket)
    ) {
      throw new Error('candidate row key bytes do not match the pinned load');
    }
    if (row.projection_id !== KA_TRANSFER_PROJECTION_V1) {
      throw new Error('stored projectionId is not cg-shared-v1');
    }
    if (row.transfer_codec !== KA_TRANSFER_CODEC_V1) {
      throw new Error('stored transfer codec is not dkg-ka-bundle-v1');
    }
    if (typeof row.assertion_coordinate !== 'string') {
      throw new Error('stored assertionCoordinate is not text');
    }
    assertAssertionCoordinateV1(row.assertion_coordinate);
    const transfer = Object.freeze({
      codec: KA_TRANSFER_CODEC_V1,
      projectionId: KA_TRANSFER_PROJECTION_V1,
      projectionDigest: sqlBlobToDigest32V1(row.projection_digest),
      byteLength: sqlBlobToDecimalU64V1(row.transfer_byte_length_u64be) as ByteLengthV1,
      chunkSize: sqlBlobToDecimalU64V1(
        row.transfer_chunk_size_u64be,
      ) as typeof KA_TRANSFER_CHUNK_SIZE_V1,
      chunkCount: sqlBlobToDecimalU64V1(row.transfer_chunk_count_u64be) as CountV1,
      blobDigest: sqlBlobToDigest32V1(row.transfer_blob_digest),
      chunkTreeRoot: sqlBlobToDigest32V1(row.transfer_chunk_tree_root),
    });
    const candidate: AuthorCatalogRowV1 = Object.freeze({
      kaId: sqlBlobToDecimalU256V1(row.ka_id_u256be) as KaIdV1,
      assertionCoordinate: row.assertion_coordinate,
      assertionVersion: sqlBlobToDecimalU64V1(row.assertion_version_u64be),
      projectionId: KA_TRANSFER_PROJECTION_V1,
      projectionDigest: sqlBlobToDigest32V1(row.projection_digest),
      sealDigest: sqlBlobToDigest32V1(row.seal_digest),
      transfer,
    });
    assertAuthorCatalogRowV1(candidate);
    const catalogScopeDigest = sqlBlobToDigest32V1(row.catalog_scope_digest);
    const catalogKeyDigest = sqlBlobToDigest32V1(row.catalog_key_digest);
    const expectedCatalogRowDigest = sqlBlobToDigest32V1(row.expected_catalog_row_digest);
    if (catalogKeyDigest !== computeAuthorCatalogKeyDigestV1(candidate.kaId)) {
      throw new Error('stored catalogKeyDigest does not match kaId');
    }
    if (expectedCatalogRowDigest !== computeAuthorCatalogRowDigestV1(
      catalogScopeDigest,
      candidate,
    )) {
      throw new Error('stored expectedCatalogRowDigest does not match the row');
    }
    return Object.freeze({
      row: candidate,
      catalogKeyDigest,
      expectedCatalogRowDigest,
    });
  } catch (cause) {
    if (cause instanceof InventoryV1CandidateError) throw cause;
    throw new InventoryV1CandidateError(
      'candidate-database-corrupt',
      'stored candidate row violates the frozen SQL-1 codec',
      { cause },
    );
  }
}

function assertDiffCompatible(
  oldHeader: CandidateBucketHeaderV1,
  newHeader: CandidateBucketHeaderV1,
): void {
  if (
    oldHeader.catalogScopeDigest !== newHeader.catalogScopeDigest
    || oldHeader.authorAddress !== newHeader.authorAddress
    || oldHeader.catalogEra !== newHeader.catalogEra
    || oldHeader.bucketCount !== newHeader.bucketCount
    || oldHeader.bucketId !== newHeader.bucketId
  ) {
    throw new InventoryV1CandidateError(
      'candidate-invalid-load',
      'candidate diff requires equal scope, author, era, bucketCount, and bucketId',
    );
  }
}

function assertCursor(
  cursor: KaIdV1 | null | undefined,
  expected: KaIdV1 | null,
): KaIdV1 | null {
  const canonical = cursor ?? null;
  if (canonical !== null) decimalU256ToSqlBlobV1(canonical);
  if (canonical !== expected) {
    throw new InventoryV1CandidateError(
      'candidate-cursor-mismatch',
      'candidate traversal cursor must equal the preceding page resumeAfter value',
    );
  }
  return canonical;
}

function assertPageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new InventoryV1CandidateError(
      'candidate-invalid-load',
      `candidate page limit must be an integer in 1..${MAX_PAGE_SIZE}`,
    );
  }
}

function sameContext(left: SessionContextV1, right: SessionContextV1): boolean {
  return left.scopeHex === right.scopeHex
    && left.authorHex === right.authorHex
    && left.subGraphName === right.subGraphName
    && left.eraHex === right.eraHex
    && left.bucketCountHex === right.bucketCountHex;
}

function pinKey(key: EncodedLoadKeyV1): string {
  return [key.session, key.scope, key.author, key.head, key.bucket]
    .map(bytesToHex)
    .join(':');
}

function bytesToHex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function isAllZero(value: Uint8Array): boolean {
  for (const byte of value) if (byte !== 0) return false;
  return true;
}

function readSafeCount(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  throw new InventoryV1CandidateError(
    'candidate-database-corrupt',
    'SQLite count result is not a nonnegative safe integer',
  );
}

function readStoredDescriptorCount(value: unknown): number {
  try {
    const count = Number(BigInt(sqlBlobToDecimalU64V1(value)));
    if (!Number.isSafeInteger(count) || count > MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1) {
      throw new Error('stored row_count is outside the SQL-1 bucket bound');
    }
    return count;
  } catch (cause) {
    throw new InventoryV1CandidateError(
      'candidate-database-corrupt',
      'stored candidate row_count is not a bounded canonical u64',
      { cause },
    );
  }
}

function assertSqlKeyBlob(value: unknown, width: number, label: string): Uint8Array {
  try {
    return assertSqlBlobWidthV1(value, width, label);
  } catch (cause) {
    throw new InventoryV1CandidateError(
      'candidate-database-corrupt',
      `${label} is not a canonical SQL key BLOB`,
      { cause },
    );
  }
}

function rollbackIfOpen(
  database: DatabaseSync,
  monotonicNow: () => number,
  deadline: number | null = null,
): RollbackResultV1 {
  const startedAt = monotonicNow();
  let failed = false;
  try {
    database.exec('ROLLBACK');
  } catch {
    failed = true;
  }
  return Object.freeze({
    failed,
    overran: (() => {
      const completedAt = monotonicNow();
      return completedAt - startedAt > STATEMENT_LATENCY_BUDGET_MS
        || (deadline !== null && (startedAt >= deadline || completedAt >= deadline));
    })(),
  });
}

function isSqliteUniqueOrPrimaryKeyConstraint(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  const candidate = cause as Error & { code?: string; errcode?: number };
  // SQLITE_CONSTRAINT_PRIMARYKEY = 1555, SQLITE_CONSTRAINT_UNIQUE = 2067.
  // Never collapse CHECK/FK/NOT NULL constraint classes into immutable-key
  // conflict: those indicate invalid data, schema drift, or database failure.
  return candidate.errcode === 1555
    || candidate.errcode === 2067
    || candidate.code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
    || candidate.code === 'SQLITE_CONSTRAINT_UNIQUE'
    || /^(?:UNIQUE|PRIMARY KEY) constraint failed:/i.test(candidate.message);
}

function assertUsableReopenedDatabase(
  value: unknown,
  monotonicNow: () => number,
  writeDeadline: number | null,
): asserts value is DatabaseSync {
  if (
    typeof value !== 'object'
    || value === null
    || typeof (value as { prepare?: unknown }).prepare !== 'function'
    || typeof (value as { exec?: unknown }).exec !== 'function'
    || typeof (value as { close?: unknown }).close !== 'function'
  ) {
    throw new Error('verified reopen provider returned an invalid low-level handle');
  }
  const startedAt = monotonicNow();
  assertReopenDeadline(startedAt, writeDeadline, 'before verified reopen SQL probe');
  const probe = (value as DatabaseSync).prepare(
    'SELECT 1 AS rfc64_verified_reopen_probe',
  ).get() as Record<string, unknown> | undefined;
  const completedAt = monotonicNow();
  if (completedAt - startedAt > STATEMENT_LATENCY_BUDGET_MS) {
    throw new LatencyBudgetSignal('verified reopen SQL probe exceeded 10000 ms', {
      callCompleted: true,
    });
  }
  assertReopenDeadline(completedAt, writeDeadline, 'after verified reopen SQL probe');
  if (probe?.rfc64_verified_reopen_probe !== 1) {
    throw new Error('verified reopen provider returned a nonfunctional low-level handle');
  }
}

function assertReopenDeadline(
  now: number,
  writeDeadline: number | null,
  label: string,
): void {
  if (writeDeadline !== null && now >= writeDeadline) {
    throw new LatencyBudgetSignal(`${label} reached the absolute 30000 ms write deadline`);
  }
}

function closeRejectedDatabase(database: DatabaseSync): void {
  database.close();
}

function normalizeCandidateError(message: string, cause: unknown): InventoryV1CandidateError {
  if (cause instanceof InventoryV1CandidateError) return cause;
  return databaseError(message, cause);
}

function databaseError(message: string, cause: unknown): InventoryV1CandidateError {
  return new InventoryV1CandidateError('candidate-database-error', message, { cause });
}

function latencyBudgetError(cause: unknown): InventoryV1CandidateError {
  return new InventoryV1CandidateError(
    'latency-budget-exceeded',
    'SQL-1 latency budget was exceeded; the result was discarded and verified reopen is required',
    { cause },
  );
}

function invalidLoad(message: string): never {
  throw new InventoryV1CandidateError('candidate-invalid-load', message);
}

function invalidSession(): InventoryV1CandidateError {
  return new InventoryV1CandidateError(
    'candidate-invalid-session',
    'candidate session is not an adapter-local opaque handle',
  );
}

function invalidRowProof(): InventoryV1CandidateError {
  return new InventoryV1CandidateError(
    'candidate-invalid-row-proof',
    'verified candidate row proof is not an adapter-local opaque handle',
  );
}

function streamComplete(): InventoryV1CandidateError {
  return new InventoryV1CandidateError(
    'candidate-stream-complete',
    'candidate traversal stream already reached its terminal empty page',
  );
}
