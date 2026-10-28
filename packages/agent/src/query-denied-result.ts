import { QueryAccessDeniedError } from '@origintrail-official/dkg-core';
import { emptyQueryResultForKind } from '@origintrail-official/dkg-query';

/** Explicit mode is opt-in; existing callers retain their empty-per-form contract. */
export function deniedResult(sparql: string, mode?: 'empty' | 'error') {
  if (mode === 'error') {
    throw new QueryAccessDeniedError();
  }
  return emptyQueryResultForKind(sparql);
}
