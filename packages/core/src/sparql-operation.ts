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

    if (ch === '#' && !isEscapedPnLocalCharAt(sparql, i)) {
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

function isSparqlNameCharacter(ch: string | undefined): boolean {
  return ch !== undefined && (
    isSparqlWordContinuation(ch)
    || /[\p{L}\p{N}\p{M}:@-]/u.test(ch)
  );
}

// SPARQL 1.1 PN_LOCAL_ESC. Escaped punctuation remains part of a prefixed
// local name, so an update word beside it is not an executable keyword.
const PN_LOCAL_ESC_CHAR = /[_~.\-!$&'()*+,;=/?#@%]/u;

function isEscapedPnLocalCharAt(src: string, index: number): boolean {
  return index >= 1
    && src[index - 1] === '\\'
    && PN_LOCAL_ESC_CHAR.test(src[index] ?? '');
}

/** A dot joins PN_LOCAL text only when the same uninterrupted token has a prefix colon. */
function isPrefixedNameDotBefore(src: string, index: number): boolean {
  if (src[index - 1] !== '.') return false;
  for (let cursor = index - 2; cursor >= 0; cursor--) {
    const ch = src[cursor];
    if (ch === ':') return true;
    if (ch === '.' || isSparqlNameCharacter(ch)) continue;
    if (isEscapedPnLocalCharAt(src, cursor)) {
      cursor--;
      continue;
    }
    return false;
  }
  return false;
}

function isSparqlNameAdjacentBefore(src: string, index: number): boolean {
  const previous = src[index - 1];
  return isSparqlNameCharacter(previous)
    || previous === '?'
    || previous === '$'
    || isPrefixedNameDotBefore(src, index)
    || isEscapedPnLocalCharAt(src, index - 1);
}

function isSparqlNameAdjacentAfter(src: string, index: number): boolean {
  return isSparqlNameCharacter(src[index])
    || (src[index] === '\\' && PN_LOCAL_ESC_CHAR.test(src[index + 1] ?? ''));
}

function isSparqlWordStart(ch: string | undefined): boolean {
  return !!ch && (
    (ch >= 'A' && ch <= 'Z')
    || (ch >= 'a' && ch <= 'z')
    || ch === '_'
  );
}

/** @deprecated Use readStandaloneSparqlWord so boundary and token length share one model. */
export function isSparqlWordContinuation(ch: string | undefined): ch is string {
  return isSparqlWordStart(ch) || (!!ch && ch >= '0' && ch <= '9');
}

export interface StandaloneSparqlWord {
  readonly word: string;
  readonly start: number;
  readonly end: number;
}

/** Read one standalone ASCII SPARQL word using the canonical name boundary model. */
export function readStandaloneSparqlWord(
  src: string,
  start: number,
): StandaloneSparqlWord | null {
  if (!isSparqlWordStart(src[start]) || isSparqlNameAdjacentBefore(src, start)) return null;
  let end = start + 1;
  while (end < src.length && isSparqlWordContinuation(src[end])) end++;
  if (isSparqlNameAdjacentAfter(src, end)) return null;
  return Object.freeze({ word: src.slice(start, end).toUpperCase(), start, end });
}

/** @deprecated Use readStandaloneSparqlWord and inspect the returned token. */
export function isSparqlKeywordStart(src: string, start: number): boolean {
  return readStandaloneSparqlWord(src, start) !== null;
}

/** @deprecated Use readStandaloneSparqlWord and inspect the returned token. */
export function isSparqlKeyword(
  src: string,
  start: number,
  end: number,
  keyword: string,
): boolean {
  const token = readStandaloneSparqlWord(src, start);
  return token?.end === end && token.word === keyword;
}

/**
 * Find an executable update keyword without mistaking it for a legal SPARQL
 * name such as `?delete`, `insert:p`, `ex:drop`, or `"x"@add`.
 * Literals, comments, and IRI references have already been blanked by the
 * caller. The remaining adjacency check distinguishes standalone grammar
 * tokens from variable, prefixed-name, language-tag, and identifier text.
 */
function findMutatingKeyword(stripped: string): string | null {
  for (let index = 0; index < stripped.length;) {
    const token = readStandaloneSparqlWord(stripped, index);
    if (!token) {
      index++;
      continue;
    }
    if (MUTATING_KEYWORD_SET.has(token.word)) return token.word;
    index = token.end;
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
