import {
  iterateSparqlCodeTokens,
  readStandaloneSparqlWord,
  stripSparqlLiteralsAndComments,
} from './sparql-lexer.js';

export {
  findMatchingSparqlCloseBrace,
  isSparqlKeyword,
  isSparqlKeywordStart,
  isSparqlWordContinuation,
  iterateSparqlCodeTokens,
  readNextSparqlCodeToken,
  readSparqlPrefixName,
  readSparqlVariable,
  readStandaloneSparqlWord,
  skipSparqlIriRef,
  skipSparqlSpaceAndLineComments,
  skipSparqlStringLiteral,
  stripSparqlLiteralsAndComments,
  type SparqlCodeToken,
  type SparqlPrefixName,
  type StandaloneSparqlWord,
} from './sparql-lexer.js';

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

const PREFIX_DECL = /\s*PREFIX\s+[^\s:]*:\s*(?:<[^<>"{}|^`\\\x00-\x20]*>)?/iy;
const BASE_DECL = /\s*BASE\b\s*(?:<[^<>"{}|^`\\\x00-\x20]*>)?/iy;
const UPDATE_OPERATION_SET = new Set<string>(SPARQL_UPDATE_OPERATIONS);
const READ_ONLY_OPERATION_SET = new Set<string>(SPARQL_READ_ONLY_OPERATIONS);
const MUTATING_KEYWORD_SET = new Set<string>(SPARQL_MUTATING_KEYWORDS);

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
  while (/\s/u.test(stripped[offset] ?? '')) offset++;
  const operationHit = readStandaloneSparqlWord(stripped, offset);
  if (!operationHit) return 'UNKNOWN';
  const operation = operationHit.word;
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

/** Find an executable update keyword using the canonical Core lexer. */
function findMutatingKeyword(stripped: string): string | null {
  for (const token of iterateSparqlCodeTokens(stripped)) {
    if (token.kind === 'word' && MUTATING_KEYWORD_SET.has(token.word)) return token.word;
  }
  return null;
}

export function analyzeSparqlOperation(sparql: string): SparqlOperationAnalysis {
  const stripped = stripSparqlLiteralsAndComments(sparql);
  const form = detectSparqlOperationFormFromStripped(stripped);
  return {
    operation: classifySparqlOperationForm(form),
    mutatingKeyword: findMutatingKeyword(stripped),
  };
}

/** Canonical read-only admission policy for already-analyzed SPARQL. */
export function recognizedReadOnlySparqlForm(
  analysis: SparqlOperationAnalysis,
): SparqlReadOnlyOperation | null {
  return analysis.operation.kind === 'read' && analysis.mutatingKeyword === null
    ? analysis.operation.form
    : null;
}

export function classifySparqlOperation(sparql: string): SparqlOperationClassification {
  return analyzeSparqlOperation(sparql).operation;
}

export function isSparqlUpdateOperation(sparql: string): boolean {
  return analyzeSparqlOperation(sparql).operation.kind === 'update';
}
