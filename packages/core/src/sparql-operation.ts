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
  readonly operation: SparqlOperationClassification;
  readonly mutatingKeyword: string | null;
}

// A single query traverses several store decorators (agent invalidation,
// changelog, graph index, then the adapter), each of which needs the same safe
// classification. Exact-string memoization makes that scan/allocation happen
// once and also covers repeated scoring queries. Bound both cardinality and
// source size so an untrusted query stream cannot turn this into an unbounded
// retention surface.
const SPARQL_ANALYSIS_CACHE_MAX_ENTRIES = 256;
const SPARQL_ANALYSIS_CACHE_MAX_SOURCE_LENGTH = 64 * 1024;
const sparqlAnalysisCache = new Map<string, SparqlOperationAnalysis>();

const PREFIX_DECL = /\s*PREFIX\s+[^\s:]*:\s*(?:<[^<>"{}|^`\\\x00-\x20]*>)?/iy;
const BASE_DECL = /\s*BASE\b\s*(?:<[^<>"{}|^`\\\x00-\x20]*>)?/iy;
const OPERATION_AT_START = new RegExp(
  `\\s*(${[...SPARQL_READ_ONLY_OPERATIONS, ...SPARQL_UPDATE_OPERATIONS].join('|')})\\b`,
  'iy',
);
const MUTATING_PATTERN = new RegExp(
  `\\b(${SPARQL_MUTATING_KEYWORDS.join('|')})\\b`,
  'i',
);
const UPDATE_OPERATION_SET = new Set<string>(SPARQL_UPDATE_OPERATIONS);
const READ_ONLY_OPERATION_SET = new Set<string>(SPARQL_READ_ONLY_OPERATIONS);

function isSparqlIriRefBodyChar(ch: string | undefined): ch is string {
  return !!ch && !/[<>"{}|^`\\\s]/.test(ch) && ch >= '\x21';
}

export function stripSparqlLiteralsAndComments(sparql: string): string {
  const out = new Array<string>(sparql.length);
  let i = 0;
  const n = sparql.length;

  while (i < n) {
    const ch = sparql[i];

    if (
      (ch === '"' || ch === "'") &&
      sparql[i + 1] === ch &&
      sparql[i + 2] === ch
    ) {
      const start = i;
      i += 3;
      while (i < n) {
        if (sparql[i] === '\\') { i += 2; continue; }
        if (sparql[i] === ch && sparql[i + 1] === ch && sparql[i + 2] === ch) {
          i += 3;
          break;
        }
        i++;
      }
      for (let j = start; j < i && j < n; j++) out[j] = ' ';
      continue;
    }

    if (ch === '"' || ch === "'") {
      const start = i;
      i++;
      while (i < n) {
        if (sparql[i] === '\\') { i += 2; continue; }
        if (sparql[i] === ch) { i++; break; }
        i++;
      }
      for (let j = start; j < i && j < n; j++) out[j] = ' ';
      continue;
    }

    if (ch === '<') {
      const prev = i > 0 ? sparql[i - 1] : '';
      const isComparison = prev && (/[a-zA-Z0-9?$_]/.test(prev) || prev === ')' || prev === ']');
      if (!isComparison) {
        const next = sparql[i + 1];
        if (next === '>' || isSparqlIriRefBodyChar(next)) {
          const start = i;
          i++;
          while (i < n && isSparqlIriRefBodyChar(sparql[i])) i++;
          if (i < n && sparql[i] === '>') {
            i++;
            for (let j = start; j < i; j++) out[j] = ' ';
            continue;
          }
        }
      }
    }

    if (ch === '#') {
      const start = i;
      while (i < n && sparql[i] !== '\n') i++;
      for (let j = start; j < i; j++) out[j] = ' ';
      continue;
    }

    out[i] = ch;
    i++;
  }

  return out.join('');
}

function detectSparqlOperationFormFromStripped(stripped: string): SparqlDetectedOperation {
  let offset = 0;
  while (true) {
    PREFIX_DECL.lastIndex = offset;
    const prefixHit = PREFIX_DECL.exec(stripped);
    if (prefixHit) {
      offset = PREFIX_DECL.lastIndex;
      continue;
    }
    BASE_DECL.lastIndex = offset;
    const baseHit = BASE_DECL.exec(stripped);
    if (baseHit) {
      offset = BASE_DECL.lastIndex;
      continue;
    }
    break;
  }
  OPERATION_AT_START.lastIndex = offset;
  const operationHit = OPERATION_AT_START.exec(stripped);
  if (!operationHit) return 'UNKNOWN';
  const operation = operationHit[1].toUpperCase();
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

export function analyzeSparqlOperation(sparql: string): SparqlOperationAnalysis {
  if (sparql.length <= SPARQL_ANALYSIS_CACHE_MAX_SOURCE_LENGTH) {
    const cached = sparqlAnalysisCache.get(sparql);
    if (cached) {
      // Refresh insertion order to keep frequently repeated queries resident.
      sparqlAnalysisCache.delete(sparql);
      sparqlAnalysisCache.set(sparql, cached);
      return cached;
    }
  }

  const stripped = stripSparqlLiteralsAndComments(sparql);
  const form = detectSparqlOperationFormFromStripped(stripped);
  const match = MUTATING_PATTERN.exec(stripped);
  const analysis = Object.freeze({
    operation: Object.freeze(classifySparqlOperationForm(form)),
    mutatingKeyword: match?.[1] ?? null,
  });

  if (sparql.length <= SPARQL_ANALYSIS_CACHE_MAX_SOURCE_LENGTH) {
    sparqlAnalysisCache.set(sparql, analysis);
    if (sparqlAnalysisCache.size > SPARQL_ANALYSIS_CACHE_MAX_ENTRIES) {
      const oldest = sparqlAnalysisCache.keys().next().value;
      if (oldest !== undefined) sparqlAnalysisCache.delete(oldest);
    }
  }
  return analysis;
}

export function classifySparqlOperation(sparql: string): SparqlOperationClassification {
  return analyzeSparqlOperation(sparql).operation;
}

export function isSparqlUpdateOperation(sparql: string): boolean {
  return analyzeSparqlOperation(sparql).operation.kind === 'update';
}
