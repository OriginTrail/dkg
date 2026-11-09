import type { TripleStore } from '@origintrail-official/dkg-storage';

/** Read the lifecycle root and events whose provenance proves ownership. */
export function readAssertionLifecycleSubjects(store: TripleStore, metaGraph: string, lifecycleSubject: string) {
  // All lifecycle writers link events via generated/used, even after the root
  // has been removed. Also accept the inverse links carried by older metadata.
  // Keep the URI boundary: an activity for another assertion may refer to this
  // one without being owned by it. Unlinked unknown rows are not safe to delete.
  return store.query(
    `SELECT DISTINCT ?s WHERE { GRAPH <${metaGraph}> {
      { <${lifecycleSubject}> ?p ?o . BIND(<${lifecycleSubject}> AS ?s) }
      UNION { ?s <http://www.w3.org/ns/prov#generated> <${lifecycleSubject}> }
      UNION { ?s <http://www.w3.org/ns/prov#used> <${lifecycleSubject}> }
      UNION { <${lifecycleSubject}> <http://www.w3.org/ns/prov#wasGeneratedBy> ?s }
      UNION { <${lifecycleSubject}> <http://www.w3.org/ns/prov#wasInvalidatedBy> ?s }
      FILTER(STR(?s) = "${lifecycleSubject}" || STRSTARTS(STR(?s), "${lifecycleSubject}/"))
    } }`,
    { source: 'publisher.assertionCreate.staleLifecycleSubjects' },
  );
}
