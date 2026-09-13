// SPDX-License-Identifier: Apache-2.0

import {
  CONTEXT_GRAPH_AUTHORITY_INDEX_MAX_TARGETS,
  type ContextGraphAuthorityIndexId,
  type ContextGraphAuthoritySnapshot,
} from '@origintrail-official/dkg-chain';

export interface Rfc64FinalizedAuthoritySnapshotEvidenceV1 {
  /** Exact numeric graph whose immutable snapshot this evidence owns. */
  readonly contextGraphAuthorityIndexId: ContextGraphAuthorityIndexId;
  /** Closed target set owned by one logical, possibly chunked projection. */
  readonly batchTargetIds: readonly ContextGraphAuthorityIndexId[];
  /** Null is authoritative only for the closed batch above. */
  readonly snapshot: ContextGraphAuthoritySnapshot | null;
}

export interface Rfc64FinalizedAuthoritySnapshotBatchRuntimeOptionsV1 {
  readonly readSnapshots: (
    contextGraphIds: readonly ContextGraphAuthorityIndexId[],
  ) => Promise<ReadonlyMap<ContextGraphAuthorityIndexId, ContextGraphAuthoritySnapshot>>;
  /** Lazily sampled while the collection window is still open. */
  readonly collectAdditionalTargetIds?: () => Iterable<ContextGraphAuthorityIndexId>;
  readonly collectionDelayMs?: number;
  /** Physical reader limit; defaults to the production chain capability contract. */
  readonly maxTargetsPerRead?: number;
}

interface Rfc64PendingFinalizedAuthoritySnapshotBatchV1 {
  readonly collectingTargetIds: Set<ContextGraphAuthorityIndexId>;
  closedTargetIds?: ReadonlySet<ContextGraphAuthorityIndexId>;
  readonly result: Promise<ReadonlyMap<
    ContextGraphAuthorityIndexId,
    ContextGraphAuthoritySnapshot
  >>;
}

const DEFAULT_COLLECTION_DELAY_MS_V1 = 10;

function immutableAuthoritySnapshotV1(
  snapshot: ContextGraphAuthoritySnapshot,
): ContextGraphAuthoritySnapshot {
  return Object.freeze({
    ...snapshot,
    participantAgents: Object.freeze([...snapshot.participantAgents]),
  });
}

function waitForBatchV1<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return pending;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(
      signal.reason
      ?? new DOMException('RFC-64 finalized authority snapshot read aborted', 'AbortError'),
    );
    signal.addEventListener('abort', onAbort, { once: true });
    void pending.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

/**
 * Owns short-lived finalized-index batches without retaining time-based
 * authority cache state. A batch's target set closes before its physical reads
 * start; callers may share that result only when their ID is in that exact
 * set. Oversized sets are read in bounded chunks, and snapshot evidence is
 * copied and frozen before it leaves this owner.
 */
export class Rfc64FinalizedAuthoritySnapshotBatchRuntimeV1 {
  readonly #active = new Set<Rfc64PendingFinalizedAuthoritySnapshotBatchV1>();
  readonly #maxTargetsPerRead: number;
  #collecting: Rfc64PendingFinalizedAuthoritySnapshotBatchV1 | undefined;

  constructor(
    private readonly options: Rfc64FinalizedAuthoritySnapshotBatchRuntimeOptionsV1,
  ) {
    this.#maxTargetsPerRead = options.maxTargetsPerRead
      ?? CONTEXT_GRAPH_AUTHORITY_INDEX_MAX_TARGETS;
    if (
      !Number.isSafeInteger(this.#maxTargetsPerRead)
      || this.#maxTargetsPerRead < 1
    ) {
      throw new TypeError('RFC-64 finalized authority batch limit must be a positive integer');
    }
  }

  async read(
    contextGraphAuthorityIndexId: ContextGraphAuthorityIndexId,
    signal?: AbortSignal,
    options: Readonly<{ requireReadAfterRequest?: boolean }> = {},
  ): Promise<Rfc64FinalizedAuthoritySnapshotEvidenceV1> {
    signal?.throwIfAborted();
    // A revision-triggered refresh must not join a physical read which began
    // before that revision was observed. An open collection window is safe:
    // its finalized anchor will be selected only after this request joined.
    let batch = options.requireReadAfterRequest === true
      ? undefined
      : [...this.#active].find(
        (candidate) => candidate.closedTargetIds?.has(contextGraphAuthorityIndexId) === true,
      );
    if (batch === undefined) {
      batch = this.#collecting;
      if (batch === undefined) batch = this.#createBatch(contextGraphAuthorityIndexId);
      else batch.collectingTargetIds.add(contextGraphAuthorityIndexId);
    }
    const snapshots = await waitForBatchV1(batch.result, signal);
    const closedTargetIds = batch.closedTargetIds;
    if (closedTargetIds === undefined || !closedTargetIds.has(contextGraphAuthorityIndexId)) {
      throw new Error('RFC-64 finalized authority batch did not own the requested graph');
    }
    return Object.freeze({
      contextGraphAuthorityIndexId,
      batchTargetIds: Object.freeze([...closedTargetIds]),
      snapshot: snapshots.get(contextGraphAuthorityIndexId) ?? null,
    });
  }

  async whenIdle(): Promise<void> {
    for (;;) {
      const active = [...this.#active];
      await Promise.allSettled(active.map(({ result }) => result));
      if (
        active.length === this.#active.size
        && active.every((batch) => this.#active.has(batch))
      ) return;
    }
  }

  #createBatch(
    firstTargetId: ContextGraphAuthorityIndexId,
  ): Rfc64PendingFinalizedAuthoritySnapshotBatchV1 {
    const collectingTargetIds = new Set<ContextGraphAuthorityIndexId>([firstTargetId]);
    const batch = {} as Rfc64PendingFinalizedAuthoritySnapshotBatchV1;
    const result = new Promise<void>((resolve) => {
      setTimeout(
        resolve,
        this.options.collectionDelayMs ?? DEFAULT_COLLECTION_DELAY_MS_V1,
      );
    }).then(async () => {
      if (this.#collecting === batch) this.#collecting = undefined;
      for (const targetId of this.options.collectAdditionalTargetIds?.() ?? []) {
        collectingTargetIds.add(targetId);
      }
      const closedTargetIds = new Set(collectingTargetIds);
      batch.closedTargetIds = closedTargetIds;
      const requestedTargetIds = Object.freeze([...closedTargetIds]);
      const owned = new Map<ContextGraphAuthorityIndexId, ContextGraphAuthoritySnapshot>();
      for (
        let offset = 0;
        offset < requestedTargetIds.length;
        offset += this.#maxTargetsPerRead
      ) {
        const chunk = Object.freeze(requestedTargetIds.slice(
          offset,
          offset + this.#maxTargetsPerRead,
        ));
        const snapshots = await this.options.readSnapshots(chunk);
        // Only merge keys owned by this closed chunk. A custom reader cannot
        // inject unrelated authority into another caller's logical batch.
        for (const targetId of chunk) {
          const snapshot = snapshots.get(targetId);
          if (snapshot !== undefined) {
            owned.set(targetId, immutableAuthoritySnapshotV1(snapshot));
          }
        }
      }
      return owned as ReadonlyMap<ContextGraphAuthorityIndexId, ContextGraphAuthoritySnapshot>;
    }).finally(() => {
      this.#active.delete(batch);
      if (this.#collecting === batch) this.#collecting = undefined;
    });
    Object.assign(batch, { collectingTargetIds, result });
    this.#collecting = batch;
    this.#active.add(batch);
    return batch;
  }
}
