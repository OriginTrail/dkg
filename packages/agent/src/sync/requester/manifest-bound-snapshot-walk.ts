// SPDX-License-Identifier: Apache-2.0

import type { Quad } from '@origintrail-official/dkg-storage';
import type {
  PublicSnapshotMetadata,
  PublicSnapshotWalkPlan,
  SharedMemorySnapshotWalkContinuation,
  SnapshotWalkPreparation,
} from './shared-memory-sync.js';

export interface ManifestBoundSnapshotProgressOptions {
  readonly now: () => number;
  readonly retentionTtlMs: number;
}

/** Immutable manifest identity plus the smallest mutable progress set. */
export class ManifestBoundSnapshotProgress {
  readonly #manifest: readonly PublicSnapshotMetadata[];
  readonly #allowedRefs: ReadonlySet<string>;
  readonly #resolvedRefs = new Set<string>();
  readonly #now: () => number;
  readonly #retentionTtlMs: number;
  #expiresAtMs: number;

  constructor(
    orderedManifest: readonly PublicSnapshotMetadata[],
    options: ManifestBoundSnapshotProgressOptions,
  ) {
    if (!Number.isFinite(options.retentionTtlMs) || options.retentionTtlMs <= 0) {
      throw new RangeError('Snapshot-walk retention TTL must be positive');
    }
    this.#manifest = immutableManifestSnapshot(orderedManifest);
    this.#allowedRefs = new Set(this.#manifest.map(({ ref }) => ref));
    this.#now = options.now;
    this.#retentionTtlMs = options.retentionTtlMs;
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

  isResolved(ref: string): boolean {
    return this.#resolvedRefs.has(ref);
  }

  resolvedCount(): number {
    return this.#resolvedRefs.size;
  }

  resolvedRefsSnapshot(): readonly string[] {
    return Object.freeze([...this.#resolvedRefs]);
  }

  invalidateResolved(ref: string): boolean {
    if (!this.#resolvedRefs.delete(ref)) return false;
    this.#touch();
    return true;
  }

  markResolved(ref: string): boolean {
    if (!this.#allowedRefs.has(ref) || this.#resolvedRefs.has(ref)) return false;
    this.#resolvedRefs.add(ref);
    this.#touch();
    return true;
  }

  retire(): void {
    this.#expiresAtMs = 0;
  }

  #touch(): void {
    this.#expiresAtMs = this.#now() + this.#retentionTtlMs;
  }
}

export function prepareManifestBoundSnapshotWalk(
  progress: ManifestBoundSnapshotProgress,
  { order, canReuseResolved }: SnapshotWalkPreparation,
): PublicSnapshotWalkPlan {
  const manifest = progress.orderedManifestSnapshot();
  const resolvedRefs = new Set(progress.resolvedRefsSnapshot());
  const snapshots = order === 'manifest'
    ? manifest
    : Object.freeze([
      ...manifest.filter(({ ref }) => !resolvedRefs.has(ref)),
      ...manifest.filter(({ ref }) => resolvedRefs.has(ref)),
    ]);
  return Object.freeze({
    snapshots,
    reusableRefs: Object.freeze(manifest
      .filter(({ ref }) => resolvedRefs.has(ref) && canReuseResolved(ref))
      .map(({ ref }) => ref)),
  });
}

export interface SelectedManifestBoundSnapshotWalkOptions
  extends ManifestBoundSnapshotProgressOptions {
  readonly onComplete?: () => void;
  readonly canMutate?: () => boolean;
}

/** Selected-provider policy composed over manifest progress and withheld rows. */
export class SelectedManifestBoundSnapshotWalk
implements SharedMemorySnapshotWalkContinuation {
  readonly #progress: ManifestBoundSnapshotProgress;
  readonly #suppressedMetadataRowsByRef = new Map<string, readonly Quad[]>();
  readonly #onComplete: (() => void) | undefined;
  readonly #canMutate: () => boolean;

  constructor(
    orderedManifest: readonly PublicSnapshotMetadata[],
    options: SelectedManifestBoundSnapshotWalkOptions,
  ) {
    this.#progress = new ManifestBoundSnapshotProgress(orderedManifest, options);
    this.#onComplete = options.onComplete;
    this.#canMutate = options.canMutate ?? (() => true);
  }

  matches(manifest: readonly PublicSnapshotMetadata[]): boolean {
    return this.#progress.matches(manifest);
  }

  get expiresAtMs(): number {
    return this.#progress.expiresAtMs;
  }

  get incomplete(): boolean {
    return this.#progress.incomplete;
  }

  prepare(options: SnapshotWalkPreparation): PublicSnapshotWalkPlan {
    return prepareManifestBoundSnapshotWalk(this.#progress, options);
  }

  orderedManifestSnapshot(): readonly PublicSnapshotMetadata[] {
    return this.#progress.orderedManifestSnapshot();
  }

  isResolved(ref: string): boolean {
    return this.#progress.isResolved(ref);
  }

  resolvedCount(): number {
    return this.#progress.resolvedCount();
  }

  resolvedRefsSnapshot(): readonly string[] {
    return this.#progress.resolvedRefsSnapshot();
  }

  suppressedMetadataRows(ref: string): readonly Quad[] {
    return immutableQuadSnapshot(this.#suppressedMetadataRowsByRef.get(ref) ?? []);
  }

  invalidateResolved(ref: string): void {
    if (!this.#canMutate() || !this.#progress.invalidateResolved(ref)) return;
    this.#suppressedMetadataRowsByRef.delete(ref);
  }

  markResolved(ref: string, rows: readonly Quad[] = []): void {
    if (!this.#canMutate() || !this.#progress.markResolved(ref)) return;
    this.#suppressedMetadataRowsByRef.set(ref, immutableQuadSnapshot(rows));
    if (!this.#progress.incomplete && this.#onComplete) {
      this.#progress.retire();
      this.#onComplete();
    }
  }
}

function immutableManifestSnapshot(
  manifest: readonly PublicSnapshotMetadata[],
): readonly PublicSnapshotMetadata[] {
  return Object.freeze(manifest.map(snapshot => Object.freeze({ ...snapshot })));
}

function immutableQuadSnapshot(quads: readonly Quad[]): readonly Quad[] {
  return Object.freeze(quads.map(quad => Object.freeze({ ...quad })));
}
