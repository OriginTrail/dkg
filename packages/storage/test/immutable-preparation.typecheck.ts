import type { Quad, TripleStore } from '../src/triple-store.js';
import type { NormalizedRfc64AuthorCommitCasV1, Rfc64AuthorCommitCasInputV1, Rfc64AuthorCommitCasResultV1 } from '../src/rfc64-author-commit-cas.js';
import { prepareImmutableMutation, type ImmutableStorePreparation, type PreparedMutation } from '../src/immutable-store-preparation.js';
import type { GraphSetIndexStore } from '../src/graph-set-index-store.js';
import type { SharedMemoryLiteralBlobStore } from '../src/shared-memory-literal-blob-store.js';

declare const store: TripleStore;
declare const graphIndex: GraphSetIndexStore;
declare const literals: SharedMemoryLiteralBlobStore;
declare const quads: Quad[];
declare const cas: Rfc64AuthorCommitCasInputV1;
declare const plan: NormalizedRfc64AuthorCommitCasV1;

async function contracts() {
  for (const owner of [graphIndex, literals] satisfies ImmutableStorePreparation[]) {
    const insert = await owner.prepareImmutableMutation({ operation: 'insert', quads });
    const inserted: Promise<void> = insert.commit(undefined, quads);
    void inserted;
    const replacement = await owner.prepareImmutableMutation({ operation: 'replaceSubject', graphUri: 'urn:graph', subject: 'urn:subject', quads });
    // @ts-expect-error Only prepared insert accepts marker quads.
    replacement.commit(undefined, quads);
    const preparedCas = await owner.prepareImmutableMutation({ operation: 'rfc64AuthorCommitCasV1', plan });
    // @ts-expect-error Public compatibility input must be normalized at the owned entry boundary.
    await owner.prepareImmutableMutation({ operation: 'rfc64AuthorCommitCasV1', input: cas });
    const result: Promise<Rfc64AuthorCommitCasResultV1> = preparedCas.commit();
    // @ts-expect-error CAS cannot accept marker quads.
    preparedCas.commit(undefined, quads);
    void result;
  }
  const replacement = await prepareImmutableMutation(store, { operation: 'replaceGraph', graphUri: 'urn:graph', quads });
  // @ts-expect-error The free boundary retains the replacement marker restriction.
  replacement.commit(undefined, quads);
}
void contracts;

const invalidOwner: ImmutableStorePreparation = {
  // @ts-expect-error A void-only preparer cannot implement the operation-specific CAS contract.
  prepareImmutableMutation: async mutation => ({ operation: mutation.operation, commit: async () => undefined }),
};
void invalidOwner;

const invalidCas: PreparedMutation<{ operation: 'rfc64AuthorCommitCasV1'; plan: NormalizedRfc64AuthorCommitCasV1 }> = {
  operation: 'rfc64AuthorCommitCasV1',
  // @ts-expect-error The prepared CAS model requires a CAS result.
  commit: async () => undefined,
};
void invalidCas;
