import {
  buildWalProjectionCommitPlanV1,
  readWalProjectionMarkerV1,
  tryCommitWalProjectionV1,
  walProjectionMarkerEqualsV1,
  walProjectionStoreCapabilityV1,
  type TripleStore,
  type WalProjectionCommitInputV1,
  type WalProjectionMarkerV1,
} from '@origintrail-official/dkg-storage';
import {
  type MaterializationRecord,
  type RetryQueueEntry,
  type WalControlStore,
} from '@origintrail-official/dkg-wal/control';

const RETRY_KIND = 'WAL_PROJECTION_LOGICAL_KEY';

export type DkgWalProjectionMaterializerErrorCode =
  | 'WAL_PROJECTION_CAPABILITY_UNAVAILABLE'
  | 'WAL_PROJECTION_SCOPE_MISMATCH'
  | 'WAL_PROJECTION_CORRUPT'
  | 'WAL_PROJECTION_RETRY_INVALID';

export class DkgWalProjectionMaterializerError extends Error {
  constructor(
    readonly code: DkgWalProjectionMaterializerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DkgWalProjectionMaterializerError';
  }
}

export interface WalProjectionScopeV1 {
  readonly namespaceId: Uint8Array;
  readonly logicalKey: Uint8Array;
}

/**
 * This is a complete projection outcome returned after the existing shared
 * DKG semantic core has made every semantic decision. The materializer treats
 * all RDF instructions and digests as opaque storage input and adds only its
 * own APPLIED persistence status.
 */
export interface DkgWalSemanticProjectionOutcomeV1 {
  readonly commit: Omit<WalProjectionCommitInputV1, 'materializationStatus'>;
}

export interface DkgWalProjectionRecalculateV1 {
  (
    currentMarker: WalProjectionMarkerV1 | null,
  ): Promise<DkgWalSemanticProjectionOutcomeV1>;
}

export interface LocalWalProjectionRebuildSourceV1 {
  /** Scopes are derived from the local admitted WAL/control index only. */
  listLocalScopes(): Promise<readonly WalProjectionScopeV1[]>;
  /** Replays local complete WalObjects through the existing semantic core. */
  replayLocalScope(
    scope: WalProjectionScopeV1,
  ): Promise<DkgWalSemanticProjectionOutcomeV1>;
}

export type DkgWalProjectionApplyResultV1 =
  | { readonly status: 'APPLIED'; readonly marker: WalProjectionMarkerV1 }
  | { readonly status: 'RECALCULATE'; readonly marker: WalProjectionMarkerV1 | null }
  | { readonly status: 'RETRY'; readonly error: Error }
  | { readonly status: 'BLOCKED'; readonly error: Error };

export interface DkgWalProjectionMaterializerOptionsV1 {
  readonly store: TripleStore;
  readonly control: WalControlStore;
  readonly now?: () => number;
  readonly retryDelayMs?: number;
  readonly maximumGuardRetries?: number;
}

export interface DkgWalProjectionRecoveryAuditV1 {
  readonly verifiedApplied: number;
  readonly requeuedApplied: number;
  readonly blockedApplied: number;
}

/**
 * Serializes and transactionally persists shared-core projection outcomes.
 * It contains no replay scheduler and owns no DKG/SWM/VM behavior.
 */
export class DkgWalProjectionMaterializerV1 {
  private readonly store: TripleStore;
  private readonly control: WalControlStore;
  private readonly now: () => number;
  private readonly retryDelayMs: number;
  private readonly maximumGuardRetries: number;
  private readonly scopeTails = new Map<string, Promise<unknown>>();

  constructor(options: DkgWalProjectionMaterializerOptionsV1) {
    this.store = options.store;
    this.control = options.control;
    this.now = options.now ?? Date.now;
    this.retryDelayMs = safeInteger(options.retryDelayMs ?? 1_000, 'retryDelayMs', 1);
    this.maximumGuardRetries = safeInteger(
      options.maximumGuardRetries ?? 3,
      'maximumGuardRetries',
      0,
    );
  }

  capability(): ReturnType<typeof walProjectionStoreCapabilityV1> {
    return walProjectionStoreCapabilityV1(this.store);
  }

  async apply(
    initial: DkgWalSemanticProjectionOutcomeV1,
    recalculate?: DkgWalProjectionRecalculateV1,
  ): Promise<DkgWalProjectionApplyResultV1> {
    const scope = scopeFrom(initial.commit);
    return this.runScopeExclusive(scope, async () => {
      const initialInput = storageInput(initial);
      if (!this.capability().authoritativeEligible) {
        const error = new DkgWalProjectionMaterializerError(
          'WAL_PROJECTION_CAPABILITY_UNAVAILABLE',
          'the configured graph backend has not proven WAL-v1 transactional projection commits',
        );
        this.putState(initialInput, 'BLOCKED', error.message);
        return { status: 'BLOCKED', error };
      }

      let outcome = initial;
      for (let attempt = 0; ; attempt += 1) {
        const input = storageInput(outcome);
        assertSameScope(scope, input);
        const plan = buildWalProjectionCommitPlanV1(input);
        this.putState(input, 'PENDING', null);
        try {
          const result = await tryCommitWalProjectionV1(this.store, input);
          if (result === null) {
            const error = new DkgWalProjectionMaterializerError(
              'WAL_PROJECTION_CAPABILITY_UNAVAILABLE',
              'WAL projection capability disappeared before commit',
            );
            this.putState(input, 'BLOCKED', error.message);
            return { status: 'BLOCKED', error };
          }
          if (result.status === 'COMMITTED') {
            return this.recordApplied(input, result.marker);
          }
          if (recalculate !== undefined && attempt < this.maximumGuardRetries) {
            outcome = await recalculate(result.marker);
            continue;
          }
          this.queueRetry(input);
          return { status: 'RECALCULATE', marker: result.marker };
        } catch (cause) {
          const error = asError(cause);
          // A response may be lost after the one store transaction commits.
          // Exact marker post-read is the only success recovery rule.
          try {
            const marker = await readWalProjectionMarkerV1(
              this.store,
              scope.namespaceId,
              scope.logicalKey,
            );
            if (walProjectionMarkerEqualsV1(marker, plan.marker)) {
              return this.recordApplied(input, plan.marker);
            }
          } catch (readCause) {
            const blocked = new DkgWalProjectionMaterializerError(
              'WAL_PROJECTION_CORRUPT',
              'projection content/marker integrity cannot be established; selective rebuild is required',
              { cause: readCause },
            );
            this.putState(input, 'BLOCKED', blocked.message);
            return { status: 'BLOCKED', error: blocked };
          }
          this.putState(input, 'PENDING', error.message, undefined, false);
          this.queueRetry(input);
          return { status: 'RETRY', error };
        }
      }
    });
  }

  /** Re-enqueue durable pending rows after process restart. */
  recoverPendingRetries(limit = 1_000): number {
    const pending = this.control.listMaterializations(['PENDING'], limit);
    for (const record of pending) this.queueRetry(record);
    return pending.length;
  }

  /**
   * Verify APPLIED control rows against the exact graph marker after restart.
   * WAL/control and graph storage do not share a distributed transaction, so a
   * crash may retain the former while losing a debounced/rebuildable graph
   * projection. Missing or different valid markers are requeued; malformed
   * markers fail closed for selective rebuild.
   */
  async auditAppliedMaterializations(
    limit = 1_000,
  ): Promise<DkgWalProjectionRecoveryAuditV1> {
    const records = this.control.listMaterializations(['APPLIED'], limit);
    let verifiedApplied = 0;
    let requeuedApplied = 0;
    let blockedApplied = 0;
    for (const record of records) {
      let expected: WalProjectionMarkerV1;
      try {
        expected = appliedMarker(record);
        const actual = await readWalProjectionMarkerV1(
          this.store,
          record.namespaceId,
          record.logicalKey,
        );
        if (walProjectionMarkerEqualsV1(actual, expected)) {
          verifiedApplied += 1;
          continue;
        }
        this.putRecoveryState(
          record,
          'PENDING',
          'applied projection marker is missing or differs; local WAL replay is required',
        );
        this.queueRetry(record);
        requeuedApplied += 1;
      } catch (cause) {
        const error = new DkgWalProjectionMaterializerError(
          'WAL_PROJECTION_CORRUPT',
          'applied projection marker/control state is malformed; selective rebuild is required',
          { cause },
        );
        this.putRecoveryState(record, 'BLOCKED', error.message);
        blockedApplied += 1;
      }
    }
    return { verifiedApplied, requeuedApplied, blockedApplied };
  }

  /**
   * Full or selective rebuild using only local WAL objects. The source exposes
   * no peer/network method, and every result still comes from the shared core.
   */
  async rebuildFromLocalWal(
    source: LocalWalProjectionRebuildSourceV1,
    selected?: WalProjectionScopeV1,
  ): Promise<readonly DkgWalProjectionApplyResultV1[]> {
    const scopes = selected === undefined
      ? await source.listLocalScopes()
      : [selected];
    const unique = normalizeScopes(scopes);
    const results: DkgWalProjectionApplyResultV1[] = [];
    for (const scope of unique) {
      const outcome = await source.replayLocalScope(scope);
      assertSameScope(scope, outcome.commit);
      results.push(await this.apply({
        commit: {
          ...outcome.commit,
          mode: 'REBUILD',
          expectedActiveHeadsDigest: null,
        },
      }));
    }
    return results;
  }

  /** Process a queue entry already leased by the shared durable dispatcher. */
  async handleLeasedRetry(
    entry: RetryQueueEntry,
    source: LocalWalProjectionRebuildSourceV1,
  ): Promise<DkgWalProjectionApplyResultV1> {
    if (entry.kind !== RETRY_KIND || entry.state !== 'LEASED') {
      throw new DkgWalProjectionMaterializerError(
        'WAL_PROJECTION_RETRY_INVALID',
        'leased retry is not WAL projection work',
      );
    }
    const scope = decodeScope(entry.payload);
    try {
      const outcome = await source.replayLocalScope(scope);
      assertSameScope(scope, outcome.commit);
      const result = await this.apply(outcome);
      if (result.status === 'APPLIED') {
        this.control.completeRetry(entry.key);
      } else {
        this.control.failRetry(
          entry.key,
          retryMessage(result),
          checkedAdd(this.now(), this.retryDelayMs),
        );
      }
      return result;
    } catch (cause) {
      const error = asError(cause);
      this.control.failRetry(
        entry.key,
        error.message,
        checkedAdd(this.now(), this.retryDelayMs),
      );
      throw error;
    }
  }

  private recordApplied(
    input: WalProjectionCommitInputV1,
    marker: WalProjectionMarkerV1,
  ): DkgWalProjectionApplyResultV1 {
    this.putState(input, 'APPLIED', null, marker);
    this.control.completeLocalCommitWorkForScope(input.namespaceId, input.logicalKey);
    this.control.cancelRetry(queueKey(input));
    return { status: 'APPLIED', marker };
  }

  private putState(
    input: WalProjectionCommitInputV1,
    status: MaterializationRecord['status'],
    lastError: string | null,
    applied?: WalProjectionMarkerV1,
    countPendingAttempt = true,
  ): void {
    const current = this.control.getMaterialization(input.namespaceId, input.logicalKey);
    const timestamp = safeInteger(this.now(), 'materialization timestamp', 0);
    this.control.putMaterialization({
      namespaceId: input.namespaceId,
      logicalKey: input.logicalKey,
      desiredHeadsDigest: input.newActiveHeadsDigest,
      desiredConflictHeadsDigest: input.newConflictHeadsDigest,
      desiredStateDigest: input.newStateDigest,
      sourceVectorId: input.sourceVectorId,
      appliedHeadsDigest: applied?.activeHeadsDigest ?? current?.appliedHeadsDigest ?? null,
      appliedConflictHeadsDigest:
        applied?.conflictHeadsDigest ?? current?.appliedConflictHeadsDigest ?? null,
      appliedStateDigest: applied?.stateDigest ?? current?.appliedStateDigest ?? null,
      status,
      attempts: (current?.attempts ?? 0) + (status === 'PENDING' && countPendingAttempt ? 1 : 0),
      retryAtMs: status === 'PENDING' ? checkedAdd(timestamp, this.retryDelayMs) : timestamp,
      lastError,
      updatedAtMs: timestamp,
    });
  }

  private queueRetry(value: WalProjectionCommitInputV1 | MaterializationRecord): void {
    const scope = {
      namespaceId: value.namespaceId,
      logicalKey: value.logicalKey,
    };
    this.control.enqueueRetry({
      key: queueKey(scope),
      kind: RETRY_KIND,
      payload: encodeScope(scope),
      priority: 10,
      maximumAttempts: 32,
      availableAtMs: checkedAdd(this.now(), this.retryDelayMs),
    });
  }

  private putRecoveryState(
    record: MaterializationRecord,
    status: MaterializationRecord['status'],
    lastError: string,
  ): void {
    const timestamp = safeInteger(this.now(), 'materialization timestamp', 0);
    this.control.putMaterialization({
      ...record,
      status,
      retryAtMs: status === 'PENDING'
        ? checkedAdd(timestamp, this.retryDelayMs)
        : timestamp,
      lastError,
      updatedAtMs: timestamp,
    });
  }

  private async runScopeExclusive<T>(
    scope: WalProjectionScopeV1,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = scopeKey(scope);
    const previous = this.scopeTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    this.scopeTails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.scopeTails.get(key) === tail) this.scopeTails.delete(key);
    }
  }
}

function storageInput(
  outcome: DkgWalSemanticProjectionOutcomeV1,
): WalProjectionCommitInputV1 {
  return {
    ...outcome.commit,
    // This is WAL-015 persistence bookkeeping, never a semantic-core choice.
    materializationStatus: 'APPLIED',
  };
}

function scopeFrom(
  input: Pick<WalProjectionCommitInputV1, 'namespaceId' | 'logicalKey'>,
): WalProjectionScopeV1 {
  return {
    namespaceId: bytes32(input.namespaceId, 'namespaceId'),
    logicalKey: bytes32(input.logicalKey, 'logicalKey'),
  };
}

function assertSameScope(
  expected: WalProjectionScopeV1,
  input: Pick<WalProjectionCommitInputV1, 'namespaceId' | 'logicalKey'>,
): void {
  const actual = scopeFrom(input);
  if (scopeKey(expected) !== scopeKey(actual)) {
    throw new DkgWalProjectionMaterializerError(
      'WAL_PROJECTION_SCOPE_MISMATCH',
      'recalculated or rebuilt projection changed namespace/logical-key scope',
    );
  }
}

function normalizeScopes(values: readonly WalProjectionScopeV1[]): WalProjectionScopeV1[] {
  const byKey = new Map<string, WalProjectionScopeV1>();
  for (const value of values) byKey.set(scopeKey(value), {
    namespaceId: bytes32(value.namespaceId, 'namespaceId'),
    logicalKey: bytes32(value.logicalKey, 'logicalKey'),
  });
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

function queueKey(value: WalProjectionScopeV1 | WalProjectionCommitInputV1): string {
  const scope = 'newActiveHeadsDigest' in value ? scopeFrom(value) : value;
  return `wal-projection:${scopeKey(scope)}`;
}

function scopeKey(scope: WalProjectionScopeV1): string {
  return `${hex(bytes32(scope.namespaceId, 'namespaceId'))}:${hex(bytes32(scope.logicalKey, 'logicalKey'))}`;
}

function encodeScope(scope: WalProjectionScopeV1): Uint8Array {
  const output = new Uint8Array(64);
  output.set(bytes32(scope.namespaceId, 'namespaceId'), 0);
  output.set(bytes32(scope.logicalKey, 'logicalKey'), 32);
  return output;
}

function decodeScope(value: Uint8Array): WalProjectionScopeV1 {
  if (!(value instanceof Uint8Array) || value.length !== 64) {
    throw new DkgWalProjectionMaterializerError(
      'WAL_PROJECTION_RETRY_INVALID',
      'WAL projection retry payload must be exactly 64 bytes',
    );
  }
  return { namespaceId: value.slice(0, 32), logicalKey: value.slice(32) };
}

function bytes32(value: Uint8Array, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new DkgWalProjectionMaterializerError(
      'WAL_PROJECTION_SCOPE_MISMATCH',
      `${label} must be exactly 32 bytes`,
    );
  }
  return new Uint8Array(value);
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function safeInteger(value: number, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new DkgWalProjectionMaterializerError(
      'WAL_PROJECTION_RETRY_INVALID',
      `${label} must be a safe integer greater than or equal to ${minimum}`,
    );
  }
  return value;
}

function checkedAdd(left: number, right: number): number {
  const value = left + right;
  return safeInteger(value, 'retry deadline', 0);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function retryMessage(result: Exclude<DkgWalProjectionApplyResultV1, { status: 'APPLIED' }>): string {
  return result.status === 'RECALCULATE'
    ? 'projection guard changed; replay must recalculate from the current marker'
    : result.error.message;
}

function appliedMarker(record: MaterializationRecord): WalProjectionMarkerV1 {
  if (
    record.appliedHeadsDigest === undefined
    || record.appliedHeadsDigest === null
    || record.appliedConflictHeadsDigest === undefined
    || record.appliedConflictHeadsDigest === null
    || record.appliedStateDigest === undefined
    || record.appliedStateDigest === null
  ) {
    throw new DkgWalProjectionMaterializerError(
      'WAL_PROJECTION_CORRUPT',
      'APPLIED materialization control state is missing exact applied digests',
    );
  }
  return {
    adapterVersion: 1,
    namespaceId: bytes32(record.namespaceId, 'namespaceId'),
    logicalKey: bytes32(record.logicalKey, 'logicalKey'),
    activeHeadsDigest: bytes32(record.appliedHeadsDigest, 'appliedHeadsDigest'),
    conflictHeadsDigest: bytes32(
      record.appliedConflictHeadsDigest,
      'appliedConflictHeadsDigest',
    ),
    stateDigest: bytes32(record.appliedStateDigest, 'appliedStateDigest'),
    sourceVectorId: bytes32(record.sourceVectorId, 'sourceVectorId'),
    materializationStatus: 'APPLIED',
  };
}
