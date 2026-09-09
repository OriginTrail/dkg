// SPDX-License-Identifier: Apache-2.0

import type { Quad } from '@origintrail-official/dkg-storage';
import type {
  PublicSnapshotMetadata,
  SharedMemorySnapshotWalkContinuation,
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
export class ManifestBoundSnapshotWalk implements SharedMemorySnapshotWalkContinuation {
  readonly #manifest: readonly PublicSnapshotMetadata[];
  readonly #manifestKey: string;
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
    this.#manifestKey = manifestIdentity(this.#manifest);
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
    return this.#manifestKey === manifestIdentity(orderedManifest);
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
      this.#expiresAtMs = 0;
      this.#onComplete?.();
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

function manifestIdentity(manifest: readonly PublicSnapshotMetadata[]): string {
  return manifest.map(({ ref, digest, count }) => (
    `${ref}\u0000${digest}\u0000${count}`
  )).join('\u0001');
}
