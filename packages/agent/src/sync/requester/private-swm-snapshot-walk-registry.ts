// SPDX-License-Identifier: Apache-2.0

import { DURABLE_DATA_SYNC_SESSION_TTL_MS } from '../durable-session.js';
import type { SyncWorkAdmission } from '../work-admission.js';
import type {
  PublicSnapshotMetadata,
  PublicSnapshotWalkPlan,
} from './shared-memory-sync.js';
import {
  ManifestBoundSnapshotProgress,
  prepareManifestBoundSnapshotWalk,
} from './manifest-bound-snapshot-walk.js';

export interface PrivateSwmSnapshotWalkOwner {
  readonly contextGraphId: string;
  readonly remotePeerId: string;
}

export type PrivateSwmSnapshotWalkPreparation =
  | {
    readonly kind: 'prepared';
    readonly plan: PublicSnapshotWalkPlan;
    readonly validatedRefs: number;
  }
  | {
    readonly kind: 'local-budget-yield';
    readonly validatedRefs: number;
  };

/** Prepare private retained progress without introducing a forwarding owner. */
export async function preparePrivateSwmSnapshotWalk(
  progress: ManifestBoundSnapshotProgress,
  options: {
    readonly workAdmission: SyncWorkAdmission;
    readonly validateRef: (ref: string) => Promise<boolean>;
  },
): Promise<PrivateSwmSnapshotWalkPreparation> {
  const manifest = progress.orderedManifestSnapshot();
  const hasUnresolved = manifest.some(({ ref }) => !progress.isResolved(ref));
  const validatedRefs = new Set<string>();
  if (!hasUnresolved) {
    const retainedRefs = progress.resolvedRefsSnapshot();
    for (const [index, ref] of retainedRefs.entries()) {
      if (!options.workAdmission.canAdmitWork()) {
        for (const unvalidatedRef of retainedRefs.slice(index)) {
          progress.invalidateResolved(unvalidatedRef);
        }
        return { kind: 'local-budget-yield', validatedRefs: validatedRefs.size };
      }
      if (await options.validateRef(ref)) validatedRefs.add(ref);
      else progress.invalidateResolved(ref);
    }
  }
  return {
    kind: 'prepared',
    validatedRefs: validatedRefs.size,
    plan: prepareManifestBoundSnapshotWalk(progress, {
      order: 'unresolved-first',
      canReuseResolved: ref => validatedRefs.has(ref),
    }),
  };
}

interface RetainedPrivateSnapshotWalk {
  readonly progress: ManifestBoundSnapshotProgress;
}

const DEFAULT_MAX_RETAINED_PRIVATE_SNAPSHOT_WALKS = 256;

/**
 * Bounded, owner-isolated private coordinators. Capacity saturation returns a
 * detached coordinator rather than evicting another owner's active progress.
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
  ): ManifestBoundSnapshotProgress {
    this.#pruneExpired();
    const ownerKey = privateSnapshotWalkOwnerKey(owner);
    const retained = this.#walks.get(ownerKey);
    if (retained?.progress.matches(orderedManifest)) return retained.progress;
    if (retained) this.#walks.delete(ownerKey);

    const progress = new ManifestBoundSnapshotProgress(orderedManifest, {
      now: this.#now,
      retentionTtlMs: this.#retentionTtlMs,
    });
    if (orderedManifest.length === 0 || this.#walks.size >= this.#maxTargets) {
      return progress;
    }
    this.#walks.set(ownerKey, { progress });
    return progress;
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
      if (retained.progress.expiresAtMs <= now) this.#walks.delete(ownerKey);
    }
  }
}

function privateSnapshotWalkOwnerKey(owner: PrivateSwmSnapshotWalkOwner): string {
  return `${owner.contextGraphId}\u0000${owner.remotePeerId}`;
}
