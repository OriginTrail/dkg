import { findTripleStoreCapability, type Quad, type QueryOptions, type TripleStore } from './triple-store.js';
import type { AtomicAssetReplacement } from './atomic-asset-group.js';
import type { Rfc64AuthorCommitCasInputV1, Rfc64AuthorCommitCasResultV1 } from './rfc64-author-commit-cas.js';

export type PreparedMutation<T = void> = (options?: QueryOptions) => Promise<T>;
/** Append changelog markers without splitting the data and markers transaction. */
export type PreparedInsert = (appendedQuads: readonly Quad[], options?: QueryOptions) => Promise<void>;

/**
 * The literal owner keeps prepared physical refs inside an operation closure.
 * Commit through the supplied outer target to preserve intervening decorators.
 * Preparation changes neither RDF nor changelog sequence state.
 */
export interface ImmutableStorePreparation {
  prepareImmutableInsert(target: TripleStore, quads: readonly Quad[]): Promise<PreparedInsert>;
  prepareImmutableReplaceGraph(target: TripleStore, graphUri: string, quads: readonly Quad[]): Promise<PreparedMutation>;
  prepareImmutableReplaceAssetGroup(target: TripleStore, assets: readonly AtomicAssetReplacement[]): Promise<PreparedMutation>;
  prepareImmutableReplaceGraphAndSubject(target: TripleStore, graphUri: string, graphQuads: readonly Quad[],
    metaGraphUri: string, metadataSubject: string, metadataQuads: readonly Quad[]): Promise<PreparedMutation>;
  prepareImmutableReplaceSubject(target: TripleStore, graphUri: string, subject: string, quads: readonly Quad[]): Promise<PreparedMutation>;
  prepareImmutableReplaceSubjectAndInsert(target: TripleStore, graphUri: string, subject: string,
    replacementQuads: readonly Quad[], insertQuads: readonly Quad[]): Promise<PreparedMutation>;
  prepareImmutableAuthorCommit(target: TripleStore, input: Rfc64AuthorCommitCasInputV1): Promise<PreparedMutation<Rfc64AuthorCommitCasResultV1>>;
}

const preparationMethods = ['prepareImmutableInsert', 'prepareImmutableReplaceGraph', 'prepareImmutableReplaceAssetGroup',
  'prepareImmutableReplaceGraphAndSubject', 'prepareImmutableReplaceSubject', 'prepareImmutableReplaceSubjectAndInsert',
  'prepareImmutableAuthorCommit'] as const;
export function immutableStorePreparation(store: unknown): ImmutableStorePreparation | null {
  return findTripleStoreCapability(store, (candidate): candidate is ImmutableStorePreparation =>
    typeof candidate === 'object' && candidate !== null
    && preparationMethods.every(method => typeof (candidate as Partial<ImmutableStorePreparation>)[method] === 'function'));
}
