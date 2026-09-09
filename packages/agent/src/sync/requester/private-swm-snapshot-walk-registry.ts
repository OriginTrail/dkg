// SPDX-License-Identifier: Apache-2.0

import { DURABLE_DATA_SYNC_SESSION_TTL_MS } from '../durable-session.js';
import type {
  PublicSnapshotMetadata,
  RetainedSharedMemorySnapshotWalkContinuation,
} from './shared-memory-sync.js';
import { ManifestBoundSnapshotWalk } from './manifest-bound-snapshot-walk.js';

export interface PrivateSwmSnapshotWalkOwner {
  readonly contextGraphId: string;
  readonly remotePeerId: string;
}

interface RetainedPrivateSnapshotWalk {
  readonly walk: ManifestBoundSnapshotWalk;
}

const DEFAULT_MAX_RETAINED_PRIVATE_SNAPSHOT_WALKS = 256;

/**
 * Bounded, owner-isolated progress for an incomplete private snapshot walk.
 * Completed, expired, and changed-manifest walks are never retained as
 * evidence for a later recovery job. Capacity saturation returns a detached
 * walk instead of evicting an active owner: admitted owners therefore keep
 * monotonic progress and eventually release slots for the waiting targets.
 */
export class PrivateSwmSnapshotWalkRegistry {
  readonly #walks = new Map<string, RetainedPrivateSnapshotWalk>();
  readonly #now: () => number;
  readonly #retentionTtlMs: number;
  readonly #maxTargets: number;

  constructor(options: {
    readonly now?: () => number;
    readonly retentionTtlMs?: number;
    readonly maxTargets?: number;
  } = {}) {
    this.#now = options.now ?? Date.now;
    this.#retentionTtlMs = options.retentionTtlMs ?? DURABLE_DATA_SYNC_SESSION_TTL_MS;
    this.#maxTargets = options.maxTargets ?? DEFAULT_MAX_RETAINED_PRIVATE_SNAPSHOT_WALKS;
    if (!Number.isFinite(this.#retentionTtlMs) || this.#retentionTtlMs <= 0) {
      throw new RangeError('Private snapshot-walk retention TTL must be positive');
    }
    if (!Number.isSafeInteger(this.#maxTargets) || this.#maxTargets <= 0) {
      throw new RangeError('Private snapshot-walk capacity must be a positive integer');
    }
  }

  open(
    owner: PrivateSwmSnapshotWalkOwner,
    orderedManifest: readonly PublicSnapshotMetadata[],
  ): RetainedSharedMemorySnapshotWalkContinuation {
    this.#pruneExpired();
    const ownerKey = privateSnapshotWalkOwnerKey(owner);
    const retained = this.#walks.get(ownerKey);
    if (retained?.walk.matches(orderedManifest)) return retained.walk;
    if (retained) this.#walks.delete(ownerKey);

    const walk = new ManifestBoundSnapshotWalk(orderedManifest, {
      now: this.#now,
      retentionTtlMs: this.#retentionTtlMs,
    });
    // Do not evict an active target. A saturated caller gets useful in-job
    // state but no cross-job evidence; retained owners continue advancing and
    // completion opens capacity for cyclically waiting owners.
    if (orderedManifest.length === 0 || this.#walks.size >= this.#maxTargets) return walk;
    const entry = { walk };
    this.#walks.set(ownerKey, entry);
    return walk;
  }

  release(owner: PrivateSwmSnapshotWalkOwner): void {
    this.#walks.delete(privateSnapshotWalkOwnerKey(owner));
  }

  get retainedTargetCount(): number {
    this.#pruneExpired();
    return this.#walks.size;
  }

  #pruneExpired(): void {
    const now = this.#now();
    for (const [ownerKey, retained] of this.#walks) {
      if (retained.walk.expiresAtMs <= now) this.#walks.delete(ownerKey);
    }
  }
}

function privateSnapshotWalkOwnerKey(owner: PrivateSwmSnapshotWalkOwner): string {
  return `${owner.contextGraphId}\u0000${owner.remotePeerId}`;
}
