// SPDX-License-Identifier: Apache-2.0

import { asGraphWriteRevisionSource } from '@origintrail-official/dkg-storage';

const unsupported = () => new Error(
  'Unscoped query requires a store with all-writer consistency coverage; specify contextGraphId to scope the query',
);
const invalidated = () => new Error(
  'Unscoped query dataset or read authority changed; retry the query or specify contextGraphId',
);

/**
 * Own result release across one unchanged local dataset/metadata interval.
 * Chain authorization retains the admission-time semantics of scoped reads;
 * this local revision does not certify an on-chain snapshot or later revocation.
 */
export async function executeUnscopedQuery<T>(deps: {
  store: unknown;
  readMetadataRevision(): number;
  admit(): Promise<boolean>;
  execute(): Promise<T>;
  denied(): T;
}): Promise<T> {
  const assertUnchanged = captureUnscopedQueryConsistency(deps.store, deps.readMetadataRevision);
  if (!(await deps.admit())) return deps.denied();
  assertUnchanged();
  const result = await deps.execute();
  assertUnchanged();
  return result;
}

/**
 * Bind discovery, authorization, and result materialization to one unchanged
 * store interval. The empty prefix includes the physical default graph as well
 * as every named graph; a graph inventory alone cannot detect same-URI or ABA
 * writes. Call the returned check before releasing any materialized result.
 */
export function captureUnscopedQueryConsistency(
  store: unknown,
  readMetadataRevision: () => number,
): () => void {
  const source = asGraphWriteRevisionSource(store);
  if (source?.writeRevisionCoverage !== 'all-writers') throw unsupported();
  const before = source.getWriteRevision('');
  const generation = before.generation;
  if (before.stable !== true || !Number.isSafeInteger(generation) || generation < 0) throw invalidated();
  const metadataRevision = readMetadataRevision();

  return () => {
    const currentSource = asGraphWriteRevisionSource(store);
    if (currentSource?.writeRevisionCoverage !== 'all-writers') throw unsupported();
    const current = currentSource.getWriteRevision('');
    if (
      current.stable !== true
      || current.generation !== generation
      || readMetadataRevision() !== metadataRevision
    ) throw invalidated();
  };
}
