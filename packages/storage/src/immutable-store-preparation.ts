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

/** Own pre-sequence work through flush/close, without serializing its disk waits. */
const admissionBrand = Symbol('immutable-preparation-admission');
export interface StorePreparationAdmission { readonly [admissionBrand]: true }

export class StoreMutationPreparation {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly admitted = new Set<StorePreparationAdmission>();
  constructor(private readonly closing: () => boolean) {}

  owns(admission?: StorePreparationAdmission): boolean { return admission !== undefined && this.admitted.has(admission); }

  run<T>(work: (admission: StorePreparationAdmission) => Promise<T>): Promise<T> {
    if (this.closing()) return Promise.reject(new Error('ChangelogStore: store is closing; write rejected'));
    const admission: StorePreparationAdmission = { [admissionBrand]: true };
    this.admitted.add(admission);
    let task: Promise<T>;
    try { task = work(admission); }
    catch (error) { this.admitted.delete(admission); return Promise.reject(error); }
    this.pending.add(task);
    void task.finally(() => { this.pending.delete(task); this.admitted.delete(admission); }).catch(() => undefined);
    return task;
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.pending);
  }
}
