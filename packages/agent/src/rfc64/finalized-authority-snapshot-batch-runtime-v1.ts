// SPDX-License-Identifier: Apache-2.0

import {
  type ContextGraphAuthorityIndexId,
  type ContextGraphAuthoritySnapshot,
} from '@origintrail-official/dkg-chain';

export interface Rfc64FinalizedAuthoritySnapshotEvidenceV1 {
  readonly contextGraphAuthorityIndexId: ContextGraphAuthorityIndexId;
  readonly batchTargetIds: readonly ContextGraphAuthorityIndexId[];
  readonly snapshot: ContextGraphAuthoritySnapshot | null;
}

export interface Rfc64FinalizedAuthoritySnapshotBatchRuntimeOptionsV1 {
  /**
   * Physical read of one batch. `signal` is supplied only for a batch with a
   * single owner (see {@link Rfc64FinalizedAuthoritySnapshotBatchRuntimeV1.read}),
   * whose cancellation must also cancel the read and release its turn on the
   * shared authority coordinator. A shared batch is never given one.
   */
  readonly readSnapshots: (
    contextGraphIds: readonly ContextGraphAuthorityIndexId[],
    signal?: AbortSignal,
  ) => Promise<ReadonlyMap<ContextGraphAuthorityIndexId, ContextGraphAuthoritySnapshot>>;
}

export interface Rfc64FinalizedAuthoritySnapshotBatchSessionV1 {
  readonly targetIds: readonly ContextGraphAuthorityIndexId[];
  read(
    contextGraphAuthorityIndexId: ContextGraphAuthorityIndexId,
    signal?: AbortSignal,
  ): Promise<Rfc64FinalizedAuthoritySnapshotEvidenceV1>;
}

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
 * Owns explicit finalized-index batch sessions. The caller that selected the
 * workload supplies the complete immutable target set; no scheduler turn,
 * ambient subscription scan, object-identity token, or time cache participates
 * in evidence ownership.
 */
export class Rfc64FinalizedAuthoritySnapshotBatchRuntimeV1 {
  readonly #active = new Set<Promise<unknown>>();

  constructor(
    private readonly options: Rfc64FinalizedAuthoritySnapshotBatchRuntimeOptionsV1,
  ) {}

  createBatch(
    contextGraphAuthorityIndexIds: readonly ContextGraphAuthorityIndexId[],
  ): Rfc64FinalizedAuthoritySnapshotBatchSessionV1 {
    return this.#createBatch(contextGraphAuthorityIndexIds);
  }

  #createBatch(
    contextGraphAuthorityIndexIds: readonly ContextGraphAuthorityIndexId[],
    ownerSignal?: AbortSignal,
  ): Rfc64FinalizedAuthoritySnapshotBatchSessionV1 {
    const targetIds = Object.freeze([...new Set(contextGraphAuthorityIndexIds)]);
    const targetSet = new Set(targetIds);
    const physicalRead = ownerSignal === undefined
      ? this.options.readSnapshots(targetIds)
      : this.options.readSnapshots(targetIds, ownerSignal);
    const result = physicalRead.then((snapshots) => {
      const owned = new Map<ContextGraphAuthorityIndexId, ContextGraphAuthoritySnapshot>();
      for (const targetId of targetIds) {
        const snapshot = snapshots.get(targetId);
        if (snapshot !== undefined) {
          owned.set(targetId, immutableAuthoritySnapshotV1(snapshot));
        }
      }
      return owned as ReadonlyMap<ContextGraphAuthorityIndexId, ContextGraphAuthoritySnapshot>;
    });
    this.#active.add(result);
    const remove = () => this.#active.delete(result);
    void result.then(remove, remove);

    return Object.freeze({
      targetIds,
      read: async (
        contextGraphAuthorityIndexId: ContextGraphAuthorityIndexId,
        signal?: AbortSignal,
      ): Promise<Rfc64FinalizedAuthoritySnapshotEvidenceV1> => {
        if (!targetSet.has(contextGraphAuthorityIndexId)) {
          throw new Error('RFC-64 finalized authority batch did not own the requested graph');
        }
        const snapshots = await waitForBatchV1(result, signal);
        return Object.freeze({
          contextGraphAuthorityIndexId,
          batchTargetIds: targetIds,
          snapshot: snapshots.get(contextGraphAuthorityIndexId) ?? null,
        });
      },
    });
  }

  /**
   * Read one graph through a batch this caller alone owns. With no other
   * waiter to serve, the caller's signal also cancels the physical read, so a
   * caller that gives up (for example on a deadline) neither keeps its turn
   * on the shared authority coordinator nor leaves a read queued behind it.
   */
  read(
    contextGraphAuthorityIndexId: ContextGraphAuthorityIndexId,
    signal?: AbortSignal,
  ): Promise<Rfc64FinalizedAuthoritySnapshotEvidenceV1> {
    return this.#createBatch([contextGraphAuthorityIndexId], signal)
      .read(contextGraphAuthorityIndexId, signal);
  }

  async whenIdle(): Promise<void> {
    for (;;) {
      const active = [...this.#active];
      await Promise.allSettled(active);
      if (
        active.length === this.#active.size
        && active.every((pending) => this.#active.has(pending))
      ) return;
    }
  }
}
