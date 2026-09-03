export {
  prepareSparql,
  type PreparedSparql,
  type SparqlLexicalToken,
} from './sparql-lexical-scanner.js';

// Grammar helpers used by parsers after they have consumed a prepared
// artifact. There is deliberately no second, heuristic IRI cursor.
export {
  readSparqlVariable,
  skipSparqlIriRef,
  skipSparqlSpaceAndLineComments,
  skipSparqlStringLiteral,
} from './sparql-lexical-primitives.js';
