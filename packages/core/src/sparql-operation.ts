import { BoundedLruCache } from './bounded-lru-cache.js';
import {
  maskSparqlLexicalRegions,
  scanSparqlLexically,
  type SparqlLexicalScan,
} from './sparql-lexical-scanner.js';

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

type SparqlOperationFacts = Readonly<{
  form: SparqlDetectedOperation;
  mutatingKeyword: string | null;
}>;

const SPARQL_ANALYSIS_CACHE_MAX_ENTRIES = 256;
const SPARQL_ANALYSIS_CACHE_MAX_SOURCE_LENGTH = 64 * 1024;

// A single query traverses several store decorators (agent invalidation,
// changelog, graph index, then the adapter), each of which needs the same safe
// classification. Exact-string memoization makes that scan/allocation happen
// once and also covers repeated scoring queries. Bound both cardinality and
// source size so an untrusted query stream cannot turn this into an unbounded
// retention surface.
const sparqlAnalysisCache = new BoundedLruCache<string, SparqlOperationFacts>(
  SPARQL_ANALYSIS_CACHE_MAX_ENTRIES,
  (source) => source.length <= SPARQL_ANALYSIS_CACHE_MAX_SOURCE_LENGTH,
);

const MUTATING_KEYWORD_SET = new Set<string>(SPARQL_MUTATING_KEYWORDS);
const UPDATE_OPERATION_SET = new Set<string>(SPARQL_UPDATE_OPERATIONS);
const READ_ONLY_OPERATION_SET = new Set<string>(SPARQL_READ_ONLY_OPERATIONS);

export function stripSparqlLiteralsAndComments(sparql: string): string {
  return maskSparqlLexicalRegions(sparql).masked;
}

function detectSparqlOperationForm(scan: SparqlLexicalScan): SparqlDetectedOperation {
  const token = scan.tokens[scan.prologue.endTokenIndex];
  if (!token || !('value' in token) || token.kind !== 'word') return 'UNKNOWN';
  const operation = token.upper;
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

export function analyzeSparqlOperation(sparql: string): SparqlOperationAnalysis {
  const cached = sparqlAnalysisCache.get(sparql);
  if (cached) return materializeSparqlOperationAnalysis(cached);

  const scan = scanSparqlLexically(sparql);
  const form = detectSparqlOperationForm(scan);
  const mutatingToken = scan.tokens.find(
    (token) => 'value' in token
      && token.kind === 'word'
      && MUTATING_KEYWORD_SET.has(token.upper),
  );
  const facts: SparqlOperationFacts = {
    form,
    mutatingKeyword: mutatingToken && 'value' in mutatingToken
      ? mutatingToken.value
      : null,
  };

  sparqlAnalysisCache.set(sparql, facts);
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
