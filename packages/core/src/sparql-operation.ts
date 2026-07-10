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

const PREFIX_DECL = /^\s*PREFIX\s+[^\s:]*:\s*(?:<[^<>"{}|^`\\\x00-\x20]*>)?/i;
const BASE_DECL = /^\s*BASE\b\s*(?:<[^<>"{}|^`\\\x00-\x20]*>)?/i;
const OPERATION_AT_START = new RegExp(
  `^\\s*(${[...SPARQL_READ_ONLY_OPERATIONS, ...SPARQL_UPDATE_OPERATIONS].join('|')})\\b`,
  'i',
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
  let cursor = stripped;
  while (true) {
    const prefixHit = PREFIX_DECL.exec(cursor);
    if (prefixHit) {
      cursor = cursor.slice(prefixHit[0].length);
      continue;
    }
    const baseHit = BASE_DECL.exec(cursor);
    if (baseHit) {
      cursor = cursor.slice(baseHit[0].length);
      continue;
    }
    break;
  }
  const operationHit = OPERATION_AT_START.exec(cursor);
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
  const stripped = stripSparqlLiteralsAndComments(sparql);
  const form = detectSparqlOperationFormFromStripped(stripped);
  const match = MUTATING_PATTERN.exec(stripped);
  return {
    operation: classifySparqlOperationForm(form),
    mutatingKeyword: match?.[1] ?? null,
  };
}

export function classifySparqlOperation(sparql: string): SparqlOperationClassification {
  return analyzeSparqlOperation(sparql).operation;
}

export function isSparqlUpdateOperation(sparql: string): boolean {
  return analyzeSparqlOperation(sparql).operation.kind === 'update';
}
