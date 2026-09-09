// SPDX-License-Identifier: Apache-2.0

import type { Quad } from '@origintrail-official/dkg-storage';
import type {
  PublicSnapshotMetadata,
  PublicSnapshotWalkPlan,
  SnapshotWalkPreparation,
  RetainedSharedMemorySnapshotWalkContinuation,
} from './shared-memory-sync.js';

export interface ManifestBoundSnapshotWalkOptions {
  readonly now: () => number;
  readonly retentionTtlMs: number;
  readonly onComplete?: () => void;
  readonly canMutate?: () => boolean;
}

/**
 * Canonical immutable-manifest walk state shared by selected and private SWM.
 * Manifest identity, progress, invalidation, and sliding expiry live here;
 * owners only decide where the walk is retained and when its slot is released.
 */
export class ManifestBoundSnapshotWalk implements RetainedSharedMemorySnapshotWalkContinuation {
  readonly #manifest: readonly PublicSnapshotMetadata[];
  readonly #allowedRefs: ReadonlySet<string>;
  readonly #resolvedRefs = new Set<string>();
  readonly #now: () => number;
  readonly #retentionTtlMs: number;
  readonly #onComplete: (() => void) | undefined;
  readonly #canMutate: () => boolean;
  #expiresAtMs: number;

  constructor(
    orderedManifest: readonly PublicSnapshotMetadata[],
    options: ManifestBoundSnapshotWalkOptions,
  ) {
    if (!Number.isFinite(options.retentionTtlMs) || options.retentionTtlMs <= 0) {
      throw new RangeError('Snapshot-walk retention TTL must be positive');
    }
    this.#manifest = immutableManifestSnapshot(orderedManifest);
    this.#allowedRefs = new Set(this.#manifest.map(({ ref }) => ref));
    this.#now = options.now;
    this.#retentionTtlMs = options.retentionTtlMs;
    this.#onComplete = options.onComplete;
    this.#canMutate = options.canMutate ?? (() => true);
    this.#expiresAtMs = this.#manifest.length > 0
      ? this.#now() + this.#retentionTtlMs
      : 0;
  }

  matches(orderedManifest: readonly PublicSnapshotMetadata[]): boolean {
    return this.#manifest.length === orderedManifest.length
      && this.#manifest.every((snapshot, index) => {
        const candidate = orderedManifest[index];
        return candidate !== undefined
          && snapshot.ref === candidate.ref
          && snapshot.digest === candidate.digest
          && snapshot.count === candidate.count;
      });
  }

  get expiresAtMs(): number {
    return this.#expiresAtMs;
  }

  get incomplete(): boolean {
    return this.#manifest.length > 0 && this.#resolvedRefs.size < this.#manifest.length;
  }

  orderedManifestSnapshot(): readonly PublicSnapshotMetadata[] {
    return this.#manifest;
  }

  prepare({ order, canReuseResolved }: SnapshotWalkPreparation): PublicSnapshotWalkPlan {
    const unresolved: PublicSnapshotMetadata[] = [];
    const resolved: PublicSnapshotMetadata[] = [];
    if (order === 'unresolved-first') {
      for (const snapshot of this.#manifest) {
        (this.isResolved(snapshot.ref) ? resolved : unresolved).push(snapshot);
      }
    }
    return Object.freeze({
      snapshots: order === 'manifest' ? this.#manifest : Object.freeze([...unresolved, ...resolved]),
      canReuse: (ref: string) => this.isResolved(ref) && canReuseResolved(ref),
    });
  }

  isResolved(ref: string): boolean {
    return this.#resolvedRefs.has(ref);
  }

  resolvedCount(): number {
    return this.#resolvedRefs.size;
  }

  resolvedRefsSnapshot(): readonly string[] {
    return Object.freeze([...this.#resolvedRefs]);
  }

  suppressedMetadataRows(_ref: string): readonly Quad[] {
    return [];
  }

  invalidateResolved(ref: string): void {
    if (!this.#canMutate() || !this.#resolvedRefs.delete(ref)) return;
    this.onInvalidated(ref);
    this.#touch();
  }

  markResolved(ref: string, suppressedMetadataRows: readonly Quad[] = []): void {
    if (!this.#canMutate() || !this.#allowedRefs.has(ref) || this.#resolvedRefs.has(ref)) return;
    this.onResolved(ref, suppressedMetadataRows);
    this.#resolvedRefs.add(ref);
    if (!this.incomplete) {
      if (this.#onComplete) {
        this.#expiresAtMs = 0;
        this.#onComplete();
      } else {
        // Private recovery may resolve the final previously-unresolved ref
        // before it has revalidated the retained prefix later in this same
        // reordered walk. Keep the entry alive until its owner observes a
        // fully successful result and releases it explicitly.
        this.#touch();
      }
      return;
    }
    this.#touch();
  }

  protected onResolved(_ref: string, _suppressedMetadataRows: readonly Quad[]): void {}

  protected onInvalidated(_ref: string): void {}

  #touch(): void {
    this.#expiresAtMs = this.#now() + this.#retentionTtlMs;
  }
}

/** Selected-provider decoration retaining verified metadata withheld per ref. */
export class SuppressedMetadataManifestBoundSnapshotWalk extends ManifestBoundSnapshotWalk {
  readonly #suppressedMetadataRowsByRef = new Map<string, readonly Quad[]>();

  override suppressedMetadataRows(ref: string): readonly Quad[] {
    return immutableQuadSnapshot(this.#suppressedMetadataRowsByRef.get(ref) ?? []);
  }

  protected override onResolved(ref: string, rows: readonly Quad[]): void {
    this.#suppressedMetadataRowsByRef.set(ref, immutableQuadSnapshot(rows));
  }

  protected override onInvalidated(ref: string): void {
    this.#suppressedMetadataRowsByRef.delete(ref);
  }
}

function immutableManifestSnapshot(
  manifest: readonly PublicSnapshotMetadata[],
): readonly PublicSnapshotMetadata[] {
  return Object.freeze(manifest.map((snapshot) => Object.freeze({ ...snapshot })));
}

function immutableQuadSnapshot(quads: readonly Quad[]): readonly Quad[] {
  return Object.freeze(quads.map((quad) => Object.freeze({ ...quad })));
}
