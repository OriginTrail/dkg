import { findTripleStoreCapability, type Quad } from './triple-store.js';
import type { Rfc64AuthorCommitCasInputV1 } from './rfc64-author-commit-cas.js';

/** Prepare durable immutable bytes without changing RDF or allocating a sequence. */
export interface ImmutableStorePreparation {
  prepareImmutableQuads(quads: readonly Quad[]): Promise<Quad[]>;
  prepareImmutableAuthorCommit(input: Rfc64AuthorCommitCasInputV1): Promise<Rfc64AuthorCommitCasInputV1>;
}

export function immutableStorePreparation(store: unknown): ImmutableStorePreparation | null {
  return findTripleStoreCapability(store, (candidate): candidate is ImmutableStorePreparation =>
    typeof candidate === 'object' && candidate !== null
    && typeof (candidate as Partial<ImmutableStorePreparation>).prepareImmutableQuads === 'function'
    && typeof (candidate as Partial<ImmutableStorePreparation>).prepareImmutableAuthorCommit === 'function');
}
