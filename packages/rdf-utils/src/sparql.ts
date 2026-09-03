export {
  materializePreparedSparql,
  prepareSparql,
  type PreparedSparql,
  type SparqlLexicalToken,
  type ValidPreparedSparql,
} from './sparql-lexical-scanner.js';

export {
  indexSparqlStructure,
  sparqlTokenIndexesAtDepth,
  type SparqlDelimiterIndex,
  type SparqlGroupRange,
  type SparqlStructure,
} from './sparql-structure.js';

export {
  prepareSparqlQuery,
  type PreparedSparqlQuery,
  type SparqlQueryGroupRange,
  type SparqlQueryVariable,
} from './sparql-query.js';

// Grammar helpers used by parsers after they have consumed a prepared
// artifact. There is deliberately no second, heuristic IRI cursor.
export {
  readSparqlVariable,
  skipSparqlIriRef,
  skipSparqlSpaceAndLineComments,
  skipSparqlStringLiteral,
} from './sparql-lexical-primitives.js';
