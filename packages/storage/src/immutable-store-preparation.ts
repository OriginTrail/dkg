import { runLogicalStoreMutation, type Quad, type QueryOptions, type TripleStore } from './triple-store.js';
import type { AtomicAssetReplacement } from './atomic-asset-group.js';
import { assertSubjectAndInsertPayload } from './atomic-subject-insert.js';
import { normalizeRfc64AuthorCommitCasV1, sourceFromNormalizedRfc64AuthorCommitCasV1,
  type Rfc64AuthorCommitCasInputV1, type Rfc64AuthorCommitCasResultV1 } from './rfc64-author-commit-cas.js';
import { UnsupportedTripleStoreCapabilityError } from './unsupported-capability-error.js';

export type ImmutableStoreMutation =
  | { operation: 'insert'; quads: readonly Quad[] }
  | { operation: 'replaceGraph'; graphUri: string; quads: readonly Quad[] }
  | { operation: 'replaceAssetGroup'; assets: readonly AtomicAssetReplacement[] }
  | { operation: 'replaceGraphAndSubject'; graphUri: string; graphQuads: readonly Quad[];
      metaGraphUri: string; metadataSubject: string; metadataQuads: readonly Quad[] }
  | { operation: 'replaceSubject'; graphUri: string; subject: string; quads: readonly Quad[] }
  | { operation: 'replaceSubjectAndInsert'; graphUri: string; subject: string;
      replacementQuads: readonly Quad[]; insertQuads: readonly Quad[] }
  | { operation: 'rfc64AuthorCommitCasV1'; input: Rfc64AuthorCommitCasInputV1 };
export type ImmutableMutationResult<M extends ImmutableStoreMutation> =
  M extends { operation: 'rfc64AuthorCommitCasV1' } ? Rfc64AuthorCommitCasResultV1 : void;
/** Only insert accepts appended marker quads; every layer forwards one commit. */
export type PreparedMutation<T = void> = (options?: QueryOptions, appendedQuads?: readonly Quad[]) => Promise<T>;
export interface ImmutableStorePreparation {
  prepareImmutableMutation(mutation: ImmutableStoreMutation): Promise<PreparedMutation<void | Rfc64AuthorCommitCasResultV1>>;
}

/** Each decorator composes directly with its inner boundary; never search past it. */
export function prepareImmutableMutation<M extends ImmutableStoreMutation>(
  store: TripleStore, mutation: M,
): Promise<PreparedMutation<ImmutableMutationResult<M>>> {
  if (mutation.operation === 'replaceSubjectAndInsert') {
    assertSubjectAndInsertPayload(mutation.graphUri, mutation.subject, mutation.replacementQuads, mutation.insertQuads);
  }
  const owner = store as TripleStore & Partial<ImmutableStorePreparation>;
  const prepared = owner.prepareImmutableMutation
    ? owner.prepareImmutableMutation(mutation) : Promise.resolve(prepareDirectMutation(store, mutation));
  // The discriminant binds both the adapter dispatch and its result type.
  return prepared as Promise<PreparedMutation<ImmutableMutationResult<M>>>;
}

/** Public writes own admission before preparation; prepared commits never re-enter it. */
export function runImmutableMutation<M extends ImmutableStoreMutation>(store: TripleStore, mutation: M,
  options?: QueryOptions): Promise<ImmutableMutationResult<M>> {
  return runLogicalStoreMutation(store, mutation.operation, options, async scoped =>
    (await prepareImmutableMutation(store, mutation))(scoped));
}

export function assertImmutableMutationCapability(store: TripleStore, operation: ImmutableStoreMutation['operation']): void {
  if (operation === 'insert') return; // Required by TripleStore, unlike the optional atomic capabilities.
  if (typeof store[operation] !== 'function') throw new UnsupportedTripleStoreCapabilityError(operation, 'immutable mutation');
}

function prepareDirectMutation(store: TripleStore, mutation: ImmutableStoreMutation): PreparedMutation<void | Rfc64AuthorCommitCasResultV1> {
  assertImmutableMutationCapability(store, mutation.operation);
  let commit: PreparedMutation<void | Rfc64AuthorCommitCasResultV1>;
  switch (mutation.operation) {
    case 'insert': {
      const rows = [...mutation.quads];
      return (options, appended = []) => store.insert([...rows, ...appended], options);
    }
    case 'replaceGraph': {
      const rows = [...mutation.quads];
      commit = options => store.replaceGraph!(mutation.graphUri, rows, options); break;
    }
    case 'replaceAssetGroup': {
      const assets = mutation.assets.map(asset => ({ ...asset, graphQuads: [...asset.graphQuads], metadataQuads: [...asset.metadataQuads] }));
      commit = options => store.replaceAssetGroup!(assets, options); break;
    }
    case 'replaceGraphAndSubject': {
      const rows = [...mutation.graphQuads], metadata = [...mutation.metadataQuads];
      commit = options => store.replaceGraphAndSubject!(mutation.graphUri, rows, mutation.metaGraphUri, mutation.metadataSubject, metadata, options); break;
    }
    case 'replaceSubject': {
      const rows = [...mutation.quads];
      commit = options => store.replaceSubject!(mutation.graphUri, mutation.subject, rows, options); break;
    }
    case 'replaceSubjectAndInsert': {
      const rows = [...mutation.replacementQuads], inserted = [...mutation.insertQuads];
      commit = options => store.replaceSubjectAndInsert!(mutation.graphUri, mutation.subject, rows, inserted, options); break;
    }
    case 'rfc64AuthorCommitCasV1': {
      const input = sourceFromNormalizedRfc64AuthorCommitCasV1(normalizeRfc64AuthorCommitCasV1(mutation.input));
      commit = options => store.rfc64AuthorCommitCasV1!(input, options); break;
    }
  }
  return (options, appended) => {
    if (appended?.length) return Promise.reject(new Error('Only insert accepts appended immutable mutation quads'));
    return commit(options);
  };
}
