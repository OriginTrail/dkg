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

/** Private retained-walk policy composed over the narrow manifest progress core. */
export class PrivateSwmSnapshotWalkCoordinator {
  constructor(readonly progress: ManifestBoundSnapshotProgress) {}

  matches(manifest: readonly PublicSnapshotMetadata[]): boolean {
    return this.progress.matches(manifest);
  }

  get expiresAtMs(): number {
    return this.progress.expiresAtMs;
  }

  isResolved(ref: string): boolean {
    return this.progress.isResolved(ref);
  }

  resolvedCount(): number {
    return this.progress.resolvedCount();
  }

  markResolved(ref: string): void {
    this.progress.markResolved(ref);
  }

  /**
   * Own private-only retained validation and unresolved-first preparation.
   * A caller receives either one usable plan or a fail-closed local yield.
   */
  async prepare(options: {
    readonly workAdmission: SyncWorkAdmission;
    readonly validateRef: (ref: string) => Promise<boolean>;
  }): Promise<PrivateSwmSnapshotWalkPreparation> {
    const manifest = this.progress.orderedManifestSnapshot();
    const hasUnresolved = manifest.some(({ ref }) => !this.progress.isResolved(ref));
    const validatedRefs = new Set<string>();
    if (!hasUnresolved) {
      const retainedRefs = this.progress.resolvedRefsSnapshot();
      for (const [index, ref] of retainedRefs.entries()) {
        if (!options.workAdmission.canAdmitWork()) {
          for (const unvalidatedRef of retainedRefs.slice(index)) {
            this.progress.invalidateResolved(unvalidatedRef);
          }
          return { kind: 'local-budget-yield', validatedRefs: validatedRefs.size };
        }
        if (await options.validateRef(ref)) validatedRefs.add(ref);
        else this.progress.invalidateResolved(ref);
      }
    }
    return {
      kind: 'prepared',
      validatedRefs: validatedRefs.size,
      plan: prepareManifestBoundSnapshotWalk(this.progress, {
        order: 'unresolved-first',
        canReuseResolved: ref => validatedRefs.has(ref),
      }),
    };
  }
}

interface RetainedPrivateSnapshotWalk {
  readonly coordinator: PrivateSwmSnapshotWalkCoordinator;
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
  ): PrivateSwmSnapshotWalkCoordinator {
    this.#pruneExpired();
    const ownerKey = privateSnapshotWalkOwnerKey(owner);
    const retained = this.#walks.get(ownerKey);
    if (retained?.coordinator.matches(orderedManifest)) return retained.coordinator;
    if (retained) this.#walks.delete(ownerKey);

    const coordinator = new PrivateSwmSnapshotWalkCoordinator(
      new ManifestBoundSnapshotProgress(orderedManifest, {
        now: this.#now,
        retentionTtlMs: this.#retentionTtlMs,
      }),
    );
    if (orderedManifest.length === 0 || this.#walks.size >= this.#maxTargets) {
      return coordinator;
    }
    this.#walks.set(ownerKey, { coordinator });
    return coordinator;
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
      if (retained.coordinator.expiresAtMs <= now) this.#walks.delete(ownerKey);
    }
  }
}

function privateSnapshotWalkOwnerKey(owner: PrivateSwmSnapshotWalkOwner): string {
  return `${owner.contextGraphId}\u0000${owner.remotePeerId}`;
}
