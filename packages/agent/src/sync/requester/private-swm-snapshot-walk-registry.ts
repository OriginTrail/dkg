// SPDX-License-Identifier: Apache-2.0

import { DURABLE_DATA_SYNC_SESSION_TTL_MS } from '../durable-session.js';
import type {
  PublicSnapshotMetadata,
  SharedMemorySnapshotWalkContinuation,
} from './shared-memory-sync.js';

export interface PrivateSwmSnapshotWalkOwner {
  readonly contextGraphId: string;
  readonly remotePeerId: string;
}

interface RetainedPrivateSnapshotWalk {
  readonly manifestKey: string;
  readonly walk: SharedMemorySnapshotWalkContinuation;
  readonly ordinal: number;
  expiresAtMs: number;
}

const DEFAULT_MAX_RETAINED_PRIVATE_SNAPSHOT_WALKS = 256;

/**
 * Bounded, owner-isolated progress for an incomplete private snapshot walk.
 * Completed, expired, changed-manifest, and capacity-evicted walks are never
 * retained as evidence for a later recovery job.
 */
export class PrivateSwmSnapshotWalkRegistry {
  readonly #walks = new Map<string, RetainedPrivateSnapshotWalk>();
  readonly #now: () => number;
  readonly #retentionTtlMs: number;
  readonly #maxTargets: number;
  #nextOrdinal = 0;

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
  ): SharedMemorySnapshotWalkContinuation {
    this.#pruneExpired();
    const ownerKey = privateSnapshotWalkOwnerKey(owner);
    const manifest = Object.freeze(orderedManifest.map((snapshot) => Object.freeze({ ...snapshot })));
    const manifestKey = privateSnapshotWalkManifestKey(manifest);
    const retained = this.#walks.get(ownerKey);
    if (retained?.manifestKey === manifestKey) return retained.walk;
    if (retained) this.#walks.delete(ownerKey);

    while (this.#walks.size >= this.#maxTargets) this.#evictOldest();
    const allowedRefs = new Set(manifest.map(({ ref }) => ref));
    const resolvedRefs = new Set<string>();
    let entry: RetainedPrivateSnapshotWalk;
    const walk: SharedMemorySnapshotWalkContinuation = {
      orderedManifestSnapshot: () => manifest,
      isResolved: (ref) => resolvedRefs.has(ref),
      resolvedCount: () => resolvedRefs.size,
      resolvedRefsSnapshot: () => Object.freeze([...resolvedRefs]),
      suppressedMetadataRows: () => [],
      invalidateResolved: (ref) => {
        if (this.#walks.get(ownerKey) !== entry || !resolvedRefs.delete(ref)) return;
        entry.expiresAtMs = this.#now() + this.#retentionTtlMs;
      },
      markResolved: (ref) => {
        if (this.#walks.get(ownerKey) !== entry || !allowedRefs.has(ref)) return;
        resolvedRefs.add(ref);
        if (resolvedRefs.size === manifest.length) {
          this.#walks.delete(ownerKey);
          return;
        }
        entry.expiresAtMs = this.#now() + this.#retentionTtlMs;
      },
    };
    entry = {
      manifestKey,
      walk,
      ordinal: this.#nextOrdinal++,
      expiresAtMs: this.#now() + this.#retentionTtlMs,
    };
    if (manifest.length > 0) this.#walks.set(ownerKey, entry);
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
      if (retained.expiresAtMs <= now) this.#walks.delete(ownerKey);
    }
  }

  #evictOldest(): void {
    let oldest: [string, RetainedPrivateSnapshotWalk] | undefined;
    for (const candidate of this.#walks) {
      if (!oldest || candidate[1].ordinal < oldest[1].ordinal) oldest = candidate;
    }
    if (oldest) this.#walks.delete(oldest[0]);
  }
}

function privateSnapshotWalkOwnerKey(owner: PrivateSwmSnapshotWalkOwner): string {
  return `${owner.contextGraphId}\u0000${owner.remotePeerId}`;
}

function privateSnapshotWalkManifestKey(manifest: readonly PublicSnapshotMetadata[]): string {
  return manifest.map(({ ref, digest, count }) => (
    `${ref}\u0000${digest}\u0000${count}`
  )).join('\u0001');
}
