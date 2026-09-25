import { prepareSparql } from '@origintrail-official/dkg-rdf-utils/sparql';

/**
 * Deliberate Core entry point for the canonical SPARQL lexical artifact.
 *
 * Operation classification owns policy in `sparql-operation`; lexical
 * coordinates, opaque spans, and token materialization belong here. Keeping
 * this boundary in Core lets Query consume the same scanner without depending
 * on the RDF utility package's internal module layout.
 */
export {
  materializePreparedSparql,
  prepareSparql,
  type PreparedSparql,
  type PreparedSparqlQuery,
  type SparqlGraphTarget,
  type SparqlGroupRange,
  type SparqlLexicalToken,
  type SparqlQueryGroupRange,
  type SparqlQueryVariable,
  type ValidPreparedSparql,
  indexSparqlStructure,
  sparqlTokenIndexesAtDepth,
  prepareSparqlQuery,
} from '@origintrail-official/dkg-rdf-utils/sparql';

/** Source-length-preserving view with strings, IRIs, and comments blanked. */
export function stripSparqlLiteralsAndComments(sparql: string): string {
  // Importing through the local re-export above would create a second module
  // boundary at runtime; prepareSparql is intentionally the canonical scanner.
  return prepareSparql(sparql).masked;
}
