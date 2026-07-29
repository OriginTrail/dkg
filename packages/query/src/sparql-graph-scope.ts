import { skipSparqlStringLiteral } from './sparql-utils.js';

export interface SparqlPrefixName {
  prefix: string;
  local: string;
  length: number;
}

export function collectPrefixDeclarations(sparql: string): Map<string, string> {
  const prefixes = new Map<string, string>();
  const n = sparql.length;
  let i = 0;

  while (i < n) {
    const ch = sparql[i];
    if (ch === '#') {
      while (i < n && sparql[i] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipSparqlStringLiteral(sparql, i);
      continue;
    }
    if (ch === '<') {
      const end = skipSparqlIriRef(sparql, i);
      i = end ?? i + 1;
      continue;
    }
    if (isKeywordStart(sparql, i)) {
      let j = i + 1;
      while (j < n && isWordContinuation(sparql[j])) j++;
      if (isSparqlKeyword(sparql, i, j, 'PREFIX')) {
        const prefixStart = skipSparqlSpaceAndLineComments(sparql, j);
        const prefix = readSparqlPrefixName(sparql, prefixStart);
        if (!prefix || prefix.local.length > 0) {
          i = j;
          continue;
        }
        const iriStart = skipSparqlSpaceAndLineComments(
          sparql,
          prefixStart + prefix.length,
        );
        const iriEnd = skipSparqlIriRef(sparql, iriStart);
        if (iriEnd) {
          prefixes.set(prefix.prefix, sparql.slice(iriStart + 1, iriEnd - 1));
          i = iriEnd;
          continue;
        }
      }
      i = j;
      continue;
    }
    i++;
  }

  return prefixes;
}

export function readSparqlPrefixName(
  sparql: string,
  start: number,
): SparqlPrefixName | null {
  let colon = start;
  while (colon < sparql.length && isSparqlPrefixLabelChar(sparql[colon])) colon++;
  if (sparql[colon] !== ':') return null;

  let end = colon + 1;
  while (end < sparql.length && isSparqlPrefixedLocalChar(sparql[end])) end++;

  return {
    prefix: sparql.slice(start, colon),
    local: sparql.slice(colon + 1, end),
    length: end - start,
  };
}

export function resolveSparqlPrefixedName(
  prefixedName: SparqlPrefixName,
  prefixes: Map<string, string>,
): string | null {
  const base = prefixes.get(prefixedName.prefix);
  if (base === undefined) return null;
  return `${base}${prefixedName.local}`;
}

/**
 * Return true only for the narrow fail-closed elision shape:
 * `VALUES ?g { <iri> prefix:name ... }` at the outer WHERE level, with every
 * resolved graph already present in the DKG allow-list.
 */
export function callerGraphValuesAreAuthorized(
  sparql: string,
  braceStart: number,
  variable: string,
  allowedGraphs: ReadonlySet<string>,
): boolean {
  const values = readTopLevelStaticGraphValues(sparql, braceStart, variable);
  return values !== null && values.every((graph) => allowedGraphs.has(graph));
}

function readTopLevelStaticGraphValues(
  sparql: string,
  braceStart: number,
  variable: string,
): string[] | null {
  const braceEnd = findMatchingCloseBrace(sparql, braceStart);
  if (braceEnd === -1) return null;
  const prefixes = collectPrefixDeclarations(sparql);
  let depth = 0;
  let i = braceStart + 1;

  while (i < braceEnd) {
    const ch = sparql[i];
    if (ch === '#') {
      while (i < braceEnd && sparql[i] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipSparqlStringLiteral(sparql, i);
      continue;
    }
    if (ch === '<') {
      i = skipSparqlIriRef(sparql, i) ?? i + 1;
      continue;
    }
    if (ch === '{') {
      depth++;
      i++;
      continue;
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (depth !== 0 || !isKeywordStart(sparql, i)) {
      i++;
      continue;
    }

    let keywordEnd = i + 1;
    while (keywordEnd < braceEnd && isWordContinuation(sparql[keywordEnd])) keywordEnd++;
    if (!isSparqlKeyword(sparql, i, keywordEnd, 'VALUES')) {
      i = keywordEnd;
      continue;
    }

    const variableStart = skipSparqlSpaceAndLineComments(sparql, keywordEnd);
    const candidate = readSparqlVariable(sparql, variableStart);
    if (candidate !== variable) {
      i = keywordEnd;
      continue;
    }
    const valuesStart = skipSparqlSpaceAndLineComments(
      sparql,
      variableStart + candidate.length,
    );
    if (sparql[valuesStart] !== '{') return null;
    const valuesEnd = findMatchingCloseBrace(sparql, valuesStart);
    if (valuesEnd === -1 || valuesEnd > braceEnd) return null;
    return parseStaticGraphValues(sparql, valuesStart + 1, valuesEnd, prefixes);
  }

  return null;
}

function parseStaticGraphValues(
  sparql: string,
  start: number,
  end: number,
  prefixes: Map<string, string>,
): string[] | null {
  const values: string[] = [];
  let i = start;
  while (i < end) {
    i = skipSparqlSpaceAndLineComments(sparql, i);
    if (i >= end) break;

    if (sparql[i] === '<') {
      const iriEnd = skipSparqlIriRef(sparql, i);
      if (!iriEnd || iriEnd > end) return null;
      values.push(sparql.slice(i + 1, iriEnd - 1));
      i = iriEnd;
      continue;
    }

    const prefixedName = readSparqlPrefixName(sparql, i);
    if (!prefixedName) return null;
    const iri = resolveSparqlPrefixedName(prefixedName, prefixes);
    if (!iri) return null;
    values.push(iri);
    i += prefixedName.length;
  }
  return values;
}

function findMatchingCloseBrace(sparql: string, openIdx: number): number {
  if (sparql[openIdx] !== '{') return -1;
  let depth = 0;
  let i = openIdx;
  while (i < sparql.length) {
    const ch = sparql[i];
    if (ch === '#') {
      while (i < sparql.length && sparql[i] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipSparqlStringLiteral(sparql, i);
      continue;
    }
    if (ch === '<') {
      const iriEnd = skipSparqlIriRef(sparql, i);
      if (iriEnd) {
        i = iriEnd;
        continue;
      }
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
    i++;
  }
  return -1;
}

function skipSparqlIriRef(sparql: string, start: number): number | null {
  if (sparql[start] !== '<') return null;
  const next = sparql[start + 1];
  if (!next || !(/[A-Za-z]/.test(next) || '#_/.'.includes(next))) return null;
  for (let i = start + 1; i < sparql.length; i++) {
    const ch = sparql[i];
    if (ch === '>') return i + 1;
    if (
      ch === '<' ||
      ch === '"' ||
      ch === '{' ||
      ch === '}' ||
      ch === '|' ||
      ch === '\\' ||
      ch === '^' ||
      ch === '`' ||
      /\s/.test(ch)
    ) {
      return null;
    }
  }
  return null;
}

function readSparqlVariable(sparql: string, start: number): string | null {
  const sigil = sparql[start];
  if (sigil !== '?' && sigil !== '$') return null;
  let end = start + 1;
  if (!isVariableChar(sparql[end])) return null;
  while (isVariableChar(sparql[end])) end++;
  return sparql.slice(start, end);
}

function isVariableChar(ch: string | undefined): ch is string {
  return !!ch && /[\p{L}\p{N}_\u00B7\u0300-\u036F\u203F-\u2040]/u.test(ch);
}

function skipSparqlSpaceAndLineComments(sparql: string, start: number): number {
  let i = start;
  while (i < sparql.length) {
    if (/\s/.test(sparql[i])) {
      i++;
      continue;
    }
    if (sparql[i] === '#') {
      while (i < sparql.length && sparql[i] !== '\n') i++;
      continue;
    }
    break;
  }
  return i;
}

function isKeywordStart(src: string, idx: number): boolean {
  const ch = src[idx];
  if (!isWordStart(ch)) return false;
  const prev = idx > 0 ? src[idx - 1] : '';
  return !prev || (
    !isWordContinuation(prev) &&
    prev !== '?' &&
    prev !== '$' &&
    prev !== ':' &&
    prev !== '#'
  );
}

function isSparqlKeyword(
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

function isWordStart(ch: string | undefined): boolean {
  return !!ch && (
    (ch >= 'A' && ch <= 'Z') ||
    (ch >= 'a' && ch <= 'z') ||
    ch === '_'
  );
}

function isWordContinuation(ch: string | undefined): boolean {
  return isWordStart(ch) || (!!ch && ch >= '0' && ch <= '9');
}

function isSparqlPrefixLabelChar(ch: string | undefined): ch is string {
  return !!ch && (
    (ch >= 'A' && ch <= 'Z') ||
    (ch >= 'a' && ch <= 'z') ||
    (ch >= '0' && ch <= '9') ||
    ch === '_' ||
    ch === '-'
  );
}

function isSparqlPrefixedLocalChar(ch: string | undefined): ch is string {
  return !!ch &&
    !/\s/.test(ch) &&
    ch !== '{' &&
    ch !== '}' &&
    ch !== '(' &&
    ch !== ')' &&
    ch !== ';' &&
    ch !== ',';
}
