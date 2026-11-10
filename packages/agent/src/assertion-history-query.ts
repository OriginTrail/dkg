import type { QueryOptions, TripleStore } from '@origintrail-official/dkg-storage';

/** Keep late adapter completions from starting another lifecycle lookup after cancellation. */
export async function queryAssertionHistory(
  store: Pick<TripleStore, 'query'>,
  sparql: string,
  options: QueryOptions,
) {
  options.signal?.throwIfAborted();
  const result = await store.query(sparql, options);
  options.signal?.throwIfAborted();
  return result;
}
