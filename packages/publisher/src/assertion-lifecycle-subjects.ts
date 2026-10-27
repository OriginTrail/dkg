import type { TripleStore } from '@origintrail-official/dkg-storage';

/** Keep cleanup complete, including unlinked legacy/orphaned event subjects. */
export function readAssertionLifecycleSubjects(store: TripleStore, metaGraph: string, lifecycleSubject: string) {
  // A bare DISTINCT subquery lets Blazegraph walk the subject index instead of
  // materializing every metadata statement. Filter after that projection;
  // putting the filter inside prevents the distinct-term scan optimization.
  return store.query(
    `SELECT ?s WHERE {
      { SELECT DISTINCT ?s WHERE { GRAPH <${metaGraph}> { ?s ?p ?o } } }
      FILTER(STR(?s) = "${lifecycleSubject}" || STRSTARTS(STR(?s), "${lifecycleSubject}/"))
    }`,
    { source: 'publisher.assertionCreate.staleLifecycleSubjects' },
  );
}
