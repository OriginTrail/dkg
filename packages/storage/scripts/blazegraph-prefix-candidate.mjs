// Experimental only. Measurements did not justify enabling this on the adapter.
import { sparqlString } from '@origintrail-official/dkg-core';

export function blazegraphGraphPrefixQuery(prefix) {
  // A direct STR(?g) filter after GRAPH ?g {} is ignored by Blazegraph 2.1.6.
  // Binding the string explicitly avoids that optimizer behavior. EXISTS keeps
  // the nonempty-graph semantics of the current enumeration.
  return `SELECT ?g WHERE {
    GRAPH ?g {}
    BIND(STR(?g) AS ?graphName)
    FILTER(STRSTARTS(?graphName, ${sparqlString(prefix)}))
    FILTER EXISTS { GRAPH ?g { ?s ?p ?o } }
  }`;
}

export async function listGraphsByPrefixCandidate(store, prefix, options) {
  // JavaScript permits prefixes ending halfway through an astral character;
  // UTF-8 cannot represent those, so preserve the fresh historical comparison.
  if (/[\uD800-\uDFFF]/u.test(prefix)) {
    return (await store.listGraphs(options)).filter(graph => graph.startsWith(prefix));
  }
  const result = await store.query(blazegraphGraphPrefixQuery(prefix), {
    ...options, source: options?.source ?? 'experiment.blazegraph.listGraphsByPrefix',
  });
  return result.type === 'bindings'
    ? result.bindings.map(b => b.g).filter(store.graphEnumerationVisibility) : [];
}
