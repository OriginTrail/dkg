// SPDX-License-Identifier: Apache-2.0

import {
  UNSCOPED_QUERY_INVALIDATED_CODE,
  UNSCOPED_QUERY_INVALIDATED_MESSAGE,
} from '@origintrail-official/dkg-core';
import { asGraphWriteRevisionSource } from '@origintrail-official/dkg-storage';

const unsupported = () => new Error(
  'Unscoped query requires a store with all-writer consistency coverage; specify contextGraphId to scope the query',
);

/**
 * A local write or a read-authority change landed inside the interval an
 * unscoped query has to hold unchanged, so its result was withheld. The request
 * is sound and the same query can succeed once that change has settled. The
 * code and the sentence are the dkg-core contract the daemon answers with; the
 * class itself stays out of the public agent surface.
 */
export class UnscopedQueryInvalidatedError extends Error {
  readonly code = UNSCOPED_QUERY_INVALIDATED_CODE;
  readonly retryable = true;

  constructor() {
    super(UNSCOPED_QUERY_INVALIDATED_MESSAGE);
    this.name = 'UnscopedQueryInvalidatedError';
  }
}

const invalidated = () => new UnscopedQueryInvalidatedError();

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
