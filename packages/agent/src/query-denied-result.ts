import { emptyQueryResultForKind } from '@origintrail-official/dkg-query';

/** Explicit mode is opt-in; existing callers retain their empty-per-form contract. */
export function deniedResult(sparql: string, mode?: 'empty' | 'error') {
  if (mode === 'error') {
    throw Object.assign(new Error('Context Graph read denied'), { code: 'QUERY_ACCESS_DENIED' });
  }
  return emptyQueryResultForKind(sparql);
}
