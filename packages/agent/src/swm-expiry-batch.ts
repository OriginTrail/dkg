import { assertSafeIri, sparqlString } from '@origintrail-official/dkg-core';
import type { QueryResult, TripleStore } from '@origintrail-official/dkg-storage';

/** Walk expired operation identities even when a whole page must be retained. */
export function readExpiredSwmOperationBatch(store: TripleStore, input: {
  metaGraph: string;
  cutoff: string;
  afterOperation: string;
  retentionFilters: string;
  limit: number;
}): Promise<QueryResult> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 250) {
    throw new Error('SWM expiry batch must contain between 1 and 250 operations');
  }
  return store.query(`SELECT DISTINCT ?op WHERE {
    GRAPH <${assertSafeIri(input.metaGraph)}> {
      ?op a <http://dkg.io/ontology/WorkspaceOperation> ; <http://dkg.io/ontology/publishedAt> ?ts .
      FILTER(?ts < "${input.cutoff}"^^<http://www.w3.org/2001/XMLSchema#dateTime>)
    }
    FILTER(isIRI(?op) && STR(?op) > ${sparqlString(input.afterOperation)})
    ${input.retentionFilters}
  } ORDER BY STR(?op) LIMIT ${input.limit}`, { source: 'agent.swmCleanup.expiredOperations' });
}
