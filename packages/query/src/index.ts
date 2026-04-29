export * from './query-engine.js';
export * from './query-types.js';
export { DKGQueryEngine, resolveViewGraphs, type ViewResolution } from './dkg-query-engine.js';
export { QueryHandler } from './query-handler.js';
export {
  validateReadOnlySparql,
  detectSparqlQueryForm,
  emptyResultForForm,
  emptyResultForSparql,
  // packages/query/src/index.ts:7).
  // Re-exported as `@deprecated` aliases (defined in `sparql-guard.ts`)
  // so downstream consumers of `@origintrail-official/dkg-query` who
  // imported the legacy symbols don't hit a hard compile failure on
  // the next minor update. Internal call sites in
  // `dkg-query-engine.ts` / `dkg-agent.ts` continue to use the
  // canonical `detectSparqlQueryForm` + `emptyResultForForm` /
  // `emptyResultForSparql` pair so the drift surface r30-3 closed
  // stays closed.
  classifySparqlForm,
  emptyQueryResultForKind,
  type SparqlGuardResult,
  type SparqlQueryForm,
  type SparqlForm,
  type EmptyQueryResultShape,
} from './sparql-guard.js';
