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
const OPERATION_AT_START = new RegExp(
  `\\s*(${[...SPARQL_READ_ONLY_OPERATIONS, ...SPARQL_UPDATE_OPERATIONS].join('|')})\\b`,
  'iy',
);
const MUTATING_TOKEN_PATTERN = new RegExp(
  `\\b(${SPARQL_MUTATING_KEYWORDS.join('|')})\\b`,
  'ig',
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

function isSparqlNameAdjacent(ch: string | undefined): boolean {
  return ch !== undefined && (
    isSparqlWordContinuation(ch)
    || /[\p{L}\p{N}\p{M}?$:@.-]/u.test(ch)
  );
}

function isSparqlWordStart(ch: string | undefined): boolean {
  return !!ch && (
    (ch >= 'A' && ch <= 'Z')
    || (ch >= 'a' && ch <= 'z')
    || ch === '_'
  );
}

/** Shared ASCII keyword boundary used by admission and query rewriting. */
export function isSparqlWordContinuation(ch: string | undefined): ch is string {
  return isSparqlWordStart(ch) || (!!ch && ch >= '0' && ch <= '9');
}

export function isSparqlKeywordStart(src: string, idx: number): boolean {
  const ch = src[idx];
  if (!isSparqlWordStart(ch)) return false;
  const prev = idx > 0 ? src[idx - 1] : '';
  return !prev || (
    !isSparqlWordContinuation(prev)
    && prev !== '?'
    && prev !== '$'
    && prev !== ':'
    && prev !== '#'
  );
}

export function isSparqlKeyword(
  src: string,
  start: number,
  end: number,
  keyword: string,
): boolean {
  const next = src[end];
  return src.slice(start, end).toUpperCase() === keyword
    && next !== ':'
    && next !== '-'
    && next !== '.';
}

/**
 * Find an executable update keyword without mistaking it for a legal SPARQL
 * name such as `?delete`, `insert:p`, `ex:drop`, or `"x"@add`.
 * Literals, comments, and IRI references have already been blanked by the
 * caller. The remaining adjacency check distinguishes standalone grammar
 * tokens from variable, prefixed-name, language-tag, and identifier text.
 */
function findMutatingKeyword(stripped: string): string | null {
  MUTATING_TOKEN_PATTERN.lastIndex = 0;
  for (;;) {
    const match = MUTATING_TOKEN_PATTERN.exec(stripped);
    if (!match) return null;
    const start = match.index;
    const end = start + match[0].length;
    if (
      !isSparqlNameAdjacent(stripped[start - 1])
      && !isSparqlNameAdjacent(stripped[end])
    ) {
      return match[1] ?? null;
    }
  }
}

export function analyzeSparqlOperation(sparql: string): SparqlOperationAnalysis {
  const stripped = stripSparqlLiteralsAndComments(sparql);
  const form = detectSparqlOperationFormFromStripped(stripped);
  return {
    operation: classifySparqlOperationForm(form),
    mutatingKeyword: findMutatingKeyword(stripped),
  };
}

/**
 * Canonical read-only admission policy for already-analyzed SPARQL.
 * A recognized read form is safe only when no standalone executable update
 * keyword remains elsewhere in the program (for example after a semicolon).
 */
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
