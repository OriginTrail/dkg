import { SparqlAnalysisCache } from './sparql-analysis-cache.js';
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

type PreparedSparqlOperationAnalysis = Readonly<{
  facts: SparqlOperationFacts;
  largeCacheable: boolean;
}>;

const sparqlAnalysisCache = new SparqlAnalysisCache<PreparedSparqlOperationAnalysis>();

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

function analyzePreparedSparql(scan: PreparedSparql): PreparedSparqlOperationAnalysis {
  if (scan.status !== 'valid') {
    return Object.freeze({
      facts: Object.freeze({ form: 'UNKNOWN' as const, mutatingKeyword: null }),
      largeCacheable: false,
    });
  }
  const query = prepareSparqlQuery(scan);
  const form = detectSparqlOperationForm(query);
  const mutatingToken = scan.tokens.find(
    (token) => token.kind === 'word'
      && MUTATING_KEYWORD_SET.has(token.upper),
  );
  return Object.freeze({
    facts: Object.freeze({
      form,
      mutatingKeyword: mutatingToken?.kind === 'word'
        ? mutatingToken.raw
        : null,
    }),
    // Recognition of SELECT/INSERT alone is not validity evidence. Retain a
    // large source only when the lexical artifact is complete and every
    // structural delimiter family is balanced. Small UNKNOWN inputs keep the
    // established bounded reuse behavior.
    largeCacheable: form !== 'UNKNOWN'
      && !scan.unterminated
      && query.structure.balanced,
  });
}

export function analyzeSparqlOperation(
  input: string | PreparedSparql,
): SparqlOperationAnalysis {
  if (typeof input !== 'string') {
    return materializeSparqlOperationAnalysis(analyzePreparedSparql(input).facts);
  }

  const cached = sparqlAnalysisCache.get(input);
  if (cached) return materializeSparqlOperationAnalysis(cached.facts);

  const analysis = analyzePreparedSparql(prepareSparql(input));

  // Each tier owns its complete admission policy. In particular, short
  // UNKNOWN inputs retain their established reuse while malformed large
  // inputs cannot churn the four-entry large-query cache.
  sparqlAnalysisCache.set(input, analysis);
  // The cache owns only immutable scalar facts. Materializing at the public
  // boundary preserves the API's mutable, caller-isolated response objects.
  return materializeSparqlOperationAnalysis(analysis.facts);
}

export function classifySparqlOperation(sparql: string): SparqlOperationClassification {
  return analyzeSparqlOperation(sparql).operation;
}

export function isSparqlUpdateOperation(sparql: string): boolean {
  return analyzeSparqlOperation(sparql).operation.kind === 'update';
}
