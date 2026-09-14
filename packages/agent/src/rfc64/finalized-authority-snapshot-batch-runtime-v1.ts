// SPDX-License-Identifier: Apache-2.0

import {
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
  /** Complete opportunistic target inventory, sampled once before the read starts. */
  readonly snapshotTargetIds?: () => Iterable<ContextGraphAuthorityIndexId>;
}

interface Rfc64PendingFinalizedAuthoritySnapshotBatchV1 {
  readonly closedTargetIds: ReadonlySet<ContextGraphAuthorityIndexId>;
  readonly result: Promise<ReadonlyMap<
    ContextGraphAuthorityIndexId,
    ContextGraphAuthoritySnapshot
  >>;
}

export type Rfc64FinalizedAuthoritySnapshotFreshnessRequestV1 = object;

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
 * set. The chain capability owns any physical chunking. Snapshot evidence is
 * copied and frozen before it leaves this owner.
 */
export class Rfc64FinalizedAuthoritySnapshotBatchRuntimeV1 {
  readonly #active = new Set<Rfc64PendingFinalizedAuthoritySnapshotBatchV1>();
  readonly #freshnessBatches = new WeakMap<
    Rfc64FinalizedAuthoritySnapshotFreshnessRequestV1,
    Set<Rfc64PendingFinalizedAuthoritySnapshotBatchV1>
  >();

  constructor(
    private readonly options: Rfc64FinalizedAuthoritySnapshotBatchRuntimeOptionsV1,
  ) {}

  async read(
    contextGraphAuthorityIndexId: ContextGraphAuthorityIndexId,
    signal?: AbortSignal,
    options: Readonly<{
      freshnessRequest?: Rfc64FinalizedAuthoritySnapshotFreshnessRequestV1;
    }> = {},
  ): Promise<Rfc64FinalizedAuthoritySnapshotEvidenceV1> {
    signal?.throwIfAborted();
    // Let same-turn callers publish their complete subscription/binding state
    // before one owner snapshots it. This is a scheduler turn, not a mutable
    // collection window: no batch exists until its target set is closed.
    await Promise.resolve();
    signal?.throwIfAborted();
    // Every refresh pass owns an opaque request token. All of its CG lanes use
    // the same immutable batch even when a fast read completes before a later
    // lane reaches this boundary. A later pass has another token and therefore
    // cannot reuse evidence selected before its revision was observed.
    const freshnessRequest = options.freshnessRequest;
    const requestBatches = freshnessRequest === undefined
      ? undefined
      : this.#freshnessBatches.get(freshnessRequest);
    const eligibleBatches = freshnessRequest === undefined
      ? this.#active
      : requestBatches ?? [];
    let batch = [...eligibleBatches].find(
      (candidate) => candidate.closedTargetIds.has(contextGraphAuthorityIndexId),
    );
    if (batch === undefined) {
      batch = this.#createBatch(contextGraphAuthorityIndexId);
      if (freshnessRequest !== undefined) {
        const batches = requestBatches ?? new Set();
        batches.add(batch);
        if (requestBatches === undefined) {
          this.#freshnessBatches.set(freshnessRequest, batches);
        }
      }
    }
    const snapshots = await waitForBatchV1(batch.result, signal);
    const closedTargetIds = batch.closedTargetIds;
    if (!closedTargetIds.has(contextGraphAuthorityIndexId)) {
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
    const closedTargetIds = new Set<ContextGraphAuthorityIndexId>([firstTargetId]);
    for (const targetId of this.options.snapshotTargetIds?.() ?? []) {
      closedTargetIds.add(targetId);
    }
    const requestedTargetIds = Object.freeze([...closedTargetIds]);
    // Defer the physical read by one microtask only so the fully initialized,
    // closed batch is visible to concurrent callers before transport starts.
    const result = Promise.resolve().then(async () => {
      const owned = new Map<ContextGraphAuthorityIndexId, ContextGraphAuthoritySnapshot>();
      const snapshots = await this.options.readSnapshots(requestedTargetIds);
      // Only merge keys owned by this closed logical set. A custom reader
      // cannot inject unrelated authority into another caller's batch.
      for (const targetId of requestedTargetIds) {
        const snapshot = snapshots.get(targetId);
        if (snapshot !== undefined) {
          owned.set(targetId, immutableAuthoritySnapshotV1(snapshot));
        }
      }
      return owned as ReadonlyMap<ContextGraphAuthorityIndexId, ContextGraphAuthoritySnapshot>;
    });
    const batch: Rfc64PendingFinalizedAuthoritySnapshotBatchV1 = {
      closedTargetIds,
      result,
    };
    this.#active.add(batch);
    const remove = () => this.#active.delete(batch);
    void result.then(remove, remove);
    return batch;
  }
}
