export {
  materializePreparedSparql,
  prepareSparql,
  type PreparedSparql,
  type SparqlLexicalToken,
  type ValidPreparedSparql,
} from './sparql-lexical-scanner.js';

export { isSparqlVariableNameRaw } from './sparql-lexical-primitives.js';

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
  type SparqlGraphTarget,
} from './sparql-query.js';

export { boundPreparedSelect, type SparqlSolutionModifiers } from './sparql-solution-modifiers.js';
