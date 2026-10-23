import { namedGraphsFromQuads } from './graph-set-index-utils.js';
import type { StoreWorkDrain } from './store-work-drain.js';
import { runLogicalStoreMutation, type Quad, type QueryOptions, type TripleStore } from './triple-store.js';
import type { AtomicAssetReplacement } from './atomic-asset-group.js';
import { assertSubjectAndInsertPayload } from './atomic-subject-insert.js';
import { normalizeRfc64AuthorCommitCasV1, sourceFromNormalizedRfc64AuthorCommitCasV1, type NormalizedRfc64AuthorCommitCasV1,
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
  | { operation: 'rfc64AuthorCommitCasV1'; plan: NormalizedRfc64AuthorCommitCasV1 };
/** Graph attribution comes from the same typed command used for preparation. */
export function immutableMutationTouchedGraphs(mutation: ImmutableStoreMutation): string[] {
  switch (mutation.operation) {
    case 'insert': return namedGraphsFromQuads(mutation.quads);
    case 'replaceAssetGroup': return [...new Set(mutation.assets.flatMap(asset => [asset.graphUri, asset.metaGraphUri]))];
    case 'replaceGraphAndSubject': return [mutation.graphUri, mutation.metaGraphUri];
    case 'rfc64AuthorCommitCasV1': return [...mutation.plan.touchedGraphs];
    default: return [mutation.graphUri];
  }
}
export type ImmutableMutationResult<M extends ImmutableStoreMutation> =
  M extends { operation: 'rfc64AuthorCommitCasV1' } ? Rfc64AuthorCommitCasResultV1 : void;
export type MutationCommit<T = void> = (options?: QueryOptions) => Promise<T>;
/** The admitted operation owns its result and only insert can append markers. */
export interface PreparedMutation<M extends ImmutableStoreMutation> {
  readonly operation: M['operation'];
  readonly commit: (options?: QueryOptions,
    appendedQuads?: M extends { operation: 'insert' } ? readonly Quad[] : never) => Promise<ImmutableMutationResult<M>>;
}
export type PreparedInsertMutation = PreparedMutation<Extract<ImmutableStoreMutation, { operation: 'insert' }>>;
type AnyPreparedMutation = {
  [O in ImmutableStoreMutation['operation']]: PreparedMutation<Extract<ImmutableStoreMutation, { operation: O }>>;
}[ImmutableStoreMutation['operation']];
export interface ImmutableStorePreparation {
  prepareImmutableMutation<M extends ImmutableStoreMutation>(mutation: M): Promise<PreparedMutation<M>>;
}

/** Each decorator composes directly with its inner boundary; never search past it. */
export function prepareImmutableMutation<M extends ImmutableStoreMutation>(
  store: TripleStore, mutation: M,
): Promise<PreparedMutation<M>> {
  if (mutation.operation === 'replaceSubjectAndInsert') {
    assertSubjectAndInsertPayload(mutation.graphUri, mutation.subject, mutation.replacementQuads, mutation.insertQuads);
  }
  const owner = store as TripleStore & Partial<ImmutableStorePreparation>;
  return owner.prepareImmutableMutation
    ? owner.prepareImmutableMutation(mutation) : Promise.resolve(prepareDirectMutation(store, mutation));
}

/** An inner logical owner already covers preparation and can cancel dispatched work.
 * Physical cleanup still follows this decorator's entire drain, including hydration. */
export function closeImmutableStoreMutations(drain: StoreWorkDrain, inner: TripleStore,
  afterInnerClose?: () => Promise<void>): Promise<void> {
  const innerOwnsWork = typeof inner.runLogicalMutation === 'function';
  return drain.close(async () => {
    try { if (!innerOwnsWork) await inner.close(); }
    finally { await afterInnerClose?.(); }
  }, innerOwnsWork ? () => inner.close() : undefined);
}

/** Public writes own admission before preparation; prepared commits never re-enter it. */
export function runImmutableMutation<M extends ImmutableStoreMutation>(store: TripleStore, mutation: M,
  options?: QueryOptions): Promise<ImmutableMutationResult<M>> {
  return runLogicalStoreMutation(store, mutation.operation, options, async scoped =>
    (await prepareImmutableMutation(store, mutation)).commit(scoped));
}

/** Own public compatibility normalization before entering the private command protocol. */
export function runRfc64AuthorCommitCasMutation(store: TripleStore, input: Rfc64AuthorCommitCasInputV1,
  options?: QueryOptions): Promise<Rfc64AuthorCommitCasResultV1> {
  return runLogicalStoreMutation(store, 'rfc64AuthorCommitCasV1', options, async scoped => {
    const command = { operation: 'rfc64AuthorCommitCasV1', plan: normalizeRfc64AuthorCommitCasV1(input) } as const;
    return (await prepareImmutableMutation(store, command)).commit(scoped);
  });
}

export function assertImmutableMutationCapability(store: TripleStore, operation: ImmutableStoreMutation['operation']): void {
  if (operation === 'insert') return; // Required by TripleStore, unlike the optional atomic capabilities.
  if (typeof store[operation] !== 'function') throw new UnsupportedTripleStoreCapabilityError(operation, 'immutable mutation');
}

function prepareDirectMutation<M extends ImmutableStoreMutation>(store: TripleStore, mutation: M): PreparedMutation<M>;
function prepareDirectMutation(store: TripleStore, mutation: ImmutableStoreMutation): AnyPreparedMutation {
  assertImmutableMutationCapability(store, mutation.operation);
  switch (mutation.operation) {
    case 'insert': {
      const rows = [...mutation.quads];
      return { operation: mutation.operation, commit: (options, appended = []) => store.insert([...rows, ...appended], options) };
    }
    case 'replaceGraph': {
      const rows = [...mutation.quads];
      return { operation: mutation.operation, commit: options => store.replaceGraph!(mutation.graphUri, rows, options) };
    }
    case 'replaceAssetGroup': {
      const assets = mutation.assets.map(asset => ({ ...asset, graphQuads: [...asset.graphQuads], metadataQuads: [...asset.metadataQuads] }));
      return { operation: mutation.operation, commit: options => store.replaceAssetGroup!(assets, options) };
    }
    case 'replaceGraphAndSubject': {
      const rows = [...mutation.graphQuads], metadata = [...mutation.metadataQuads];
      return { operation: mutation.operation, commit: options => store.replaceGraphAndSubject!(mutation.graphUri, rows, mutation.metaGraphUri, mutation.metadataSubject, metadata, options) };
    }
    case 'replaceSubject': {
      const rows = [...mutation.quads];
      return { operation: mutation.operation, commit: options => store.replaceSubject!(mutation.graphUri, mutation.subject, rows, options) };
    }
    case 'replaceSubjectAndInsert': {
      const rows = [...mutation.replacementQuads], inserted = [...mutation.insertQuads];
      return { operation: mutation.operation, commit: options => store.replaceSubjectAndInsert!(mutation.graphUri, mutation.subject, rows, inserted, options) };
    }
    case 'rfc64AuthorCommitCasV1': {
      return { operation: mutation.operation, commit: options =>
        store.rfc64AuthorCommitCasV1!(sourceFromNormalizedRfc64AuthorCommitCasV1(mutation.plan), options) };
    }
  }
}
