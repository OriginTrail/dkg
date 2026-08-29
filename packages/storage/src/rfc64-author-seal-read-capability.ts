import type {
  CanonicalAuthorSealStoreRowV1,
  Rfc64AuthorSealReadOperationV1,
} from '@origintrail-official/dkg-core';

import type { QueryOptions, TripleStore } from './triple-store.js';
import { executeRfc64ExactBindingsReadCapabilityV1 } from
  './rfc64-semantic-read-capability.js';

export interface Rfc64AuthorSealReadCapabilityV1 {
  rfc64AuthorSealReadV1(
    operation: Rfc64AuthorSealReadOperationV1,
    options?: Pick<QueryOptions, 'signal'>,
  ): Promise<readonly CanonicalAuthorSealStoreRowV1[]>;
}

export function executeRfc64AuthorSealReadCapabilityV1(
  store: Pick<TripleStore, 'query'>,
  operation: Rfc64AuthorSealReadOperationV1,
  options: Pick<QueryOptions, 'signal'> = {},
): Promise<readonly CanonicalAuthorSealStoreRowV1[]> {
  return executeRfc64ExactBindingsReadCapabilityV1(store, operation, options);
}

export function isRfc64AuthorSealReadCapabilityV1(
  candidate: unknown,
): candidate is Rfc64AuthorSealReadCapabilityV1 {
  return candidate !== null
    && typeof candidate === 'object'
    && typeof (candidate as Partial<Rfc64AuthorSealReadCapabilityV1>)
      .rfc64AuthorSealReadV1 === 'function';
}
