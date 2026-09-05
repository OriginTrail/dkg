import { BoundedLruCache } from './bounded-lru-cache.js';
import {
  prepareSparql,
  prepareSparqlQuery,
  type PreparedSparql,
  type PreparedSparqlQuery,
} from '@origintrail-official/dkg-rdf-utils/sparql';

const SPARQL_READ_ONLY_OPERATIONS = ['SELECT', 'CONSTRUCT', 'ASK', 'DESCRIBE'] as const;
const SPARQL_MUTATING_KEYWORDS = [
  'INSERT',
  'DELETE',
  'LOAD',
  'CLEAR',
  'DROP',
  'CREATE',
  'COPY',
  'MOVE',
  'ADD',
] as const;
const SPARQL_UPDATE_OPERATIONS = [...SPARQL_MUTATING_KEYWORDS, 'WITH'] as const;

export type SparqlReadOnlyOperation = typeof SPARQL_READ_ONLY_OPERATIONS[number];
type SparqlUpdateOperation = typeof SPARQL_UPDATE_OPERATIONS[number];
type SparqlDetectedOperation = SparqlReadOnlyOperation | SparqlUpdateOperation | 'UNKNOWN';
export type SparqlOperationClassification =
  | { kind: 'read'; form: SparqlReadOnlyOperation }
  | { kind: 'update' }
  | { kind: 'unknown' };
export interface SparqlOperationAnalysis {
  operation: SparqlOperationClassification;
  mutatingKeyword: string | null;
}

export type SparqlOperationFacts = Readonly<{
  form: SparqlDetectedOperation;
  mutatingKeyword: string | null;
}>;

const SPARQL_ANALYSIS_CACHE_MAX_ENTRIES = 256;
const SPARQL_ANALYSIS_CACHE_MAX_SOURCE_LENGTH = 64 * 1024;
const SPARQL_LARGE_ANALYSIS_CACHE_MAX_ENTRIES = 4;
const SPARQL_LARGE_ANALYSIS_CACHE_MAX_SOURCE_LENGTH = 2 * 1024 * 1024;

// A single query traverses several store decorators (agent invalidation,
// changelog, graph index, then the adapter), each of which needs the same safe
// classification. Exact-string memoization makes that scan/allocation happen
// once. The established small tier accepts UNKNOWN results, while the tiny
// large tier admits only successfully classified generated sync queries so
// malformed untrusted input cannot displace useful entries.
function createSparqlAnalysisCacheTiers() {
  return {
    small: new BoundedLruCache<string, SparqlOperationFacts>(
      SPARQL_ANALYSIS_CACHE_MAX_ENTRIES,
      (source) => source.length <= SPARQL_ANALYSIS_CACHE_MAX_SOURCE_LENGTH,
    ),
    large: new BoundedLruCache<string, SparqlOperationFacts>(
      SPARQL_LARGE_ANALYSIS_CACHE_MAX_ENTRIES,
      (source, facts) => source.length > SPARQL_ANALYSIS_CACHE_MAX_SOURCE_LENGTH
        && source.length <= SPARQL_LARGE_ANALYSIS_CACHE_MAX_SOURCE_LENGTH
        && facts.form !== 'UNKNOWN',
    ),
  };
}

const sparqlAnalysisCaches = createSparqlAnalysisCacheTiers();

function analysisCacheFor(source: string): BoundedLruCache<string, SparqlOperationFacts> {
  return source.length <= SPARQL_ANALYSIS_CACHE_MAX_SOURCE_LENGTH
    ? sparqlAnalysisCaches.small
    : sparqlAnalysisCaches.large;
}

/** Narrow cache-policy seam used by regression tests. */
export const sparqlAnalysisCacheTesting = {
  createTiers: createSparqlAnalysisCacheTiers,
  smallMaxSourceLength: SPARQL_ANALYSIS_CACHE_MAX_SOURCE_LENGTH,
  largeMaxSourceLength: SPARQL_LARGE_ANALYSIS_CACHE_MAX_SOURCE_LENGTH,
};

const MUTATING_KEYWORD_SET = new Set<string>(SPARQL_MUTATING_KEYWORDS);
const UPDATE_OPERATION_SET = new Set<string>(SPARQL_UPDATE_OPERATIONS);
const READ_ONLY_OPERATION_SET = new Set<string>(SPARQL_READ_ONLY_OPERATIONS);

export function stripSparqlLiteralsAndComments(sparql: string): string {
  return prepareSparql(sparql).masked;
}

function detectSparqlOperationForm(query: PreparedSparqlQuery): SparqlDetectedOperation {
  const { operation } = query;
  if (operation === null) return 'UNKNOWN';
  return isReadOnlySparqlOperation(operation) || isSparqlUpdateOperationForm(operation)
    ? operation
    : 'UNKNOWN';
}

function isReadOnlySparqlOperation(form: string): form is SparqlReadOnlyOperation {
  return READ_ONLY_OPERATION_SET.has(form);
}

function isSparqlUpdateOperationForm(form: string): form is SparqlUpdateOperation {
  return UPDATE_OPERATION_SET.has(form);
}

function classifySparqlOperationForm(form: SparqlDetectedOperation): SparqlOperationClassification {
  if (isReadOnlySparqlOperation(form)) return { kind: 'read', form };
  if (isSparqlUpdateOperationForm(form)) return { kind: 'update' };
  return { kind: 'unknown' };
}

function materializeSparqlOperationAnalysis(
  facts: SparqlOperationFacts,
): SparqlOperationAnalysis {
  return {
    operation: classifySparqlOperationForm(facts.form),
    mutatingKeyword: facts.mutatingKeyword,
  };
}

function analyzePreparedSparql(scan: PreparedSparql): SparqlOperationFacts {
  if (scan.status !== 'valid') {
    return { form: 'UNKNOWN', mutatingKeyword: null };
  }
  const query = prepareSparqlQuery(scan);
  const form = detectSparqlOperationForm(query);
  const mutatingToken = scan.tokens.find(
    (token) => token.kind === 'word'
      && MUTATING_KEYWORD_SET.has(token.upper),
  );
  return {
    form,
    mutatingKeyword: mutatingToken?.kind === 'word'
      ? mutatingToken.raw
      : null,
  };
}

export function analyzeSparqlOperation(
  input: string | PreparedSparql,
): SparqlOperationAnalysis {
  if (typeof input !== 'string') {
    return materializeSparqlOperationAnalysis(analyzePreparedSparql(input));
  }

  const cache = analysisCacheFor(input);
  const cached = cache.get(input);
  if (cached) return materializeSparqlOperationAnalysis(cached);

  const facts = analyzePreparedSparql(prepareSparql(input));

  // Each tier owns its complete admission policy. In particular, short
  // UNKNOWN inputs retain their established reuse while malformed large
  // inputs cannot churn the four-entry large-query cache.
  cache.set(input, facts);
  // The cache owns only immutable scalar facts. Materializing at the public
  // boundary preserves the API's mutable, caller-isolated response objects.
  return materializeSparqlOperationAnalysis(facts);
}

export function classifySparqlOperation(sparql: string): SparqlOperationClassification {
  return analyzeSparqlOperation(sparql).operation;
}

export function isSparqlUpdateOperation(sparql: string): boolean {
  return analyzeSparqlOperation(sparql).operation.kind === 'update';
}
