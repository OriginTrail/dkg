import {
  findMatchingSparqlCloseBrace as findMatchingCloseBrace,
  readStandaloneSparqlWord,
  readSparqlVariable,
  skipSparqlIriRef,
  skipSparqlSpaceAndLineComments,
  skipSparqlStringLiteral,
} from './sparql-utils.js';

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
    const token = readStandaloneSparqlWord(sparql, i);
    if (token) {
      if (token.word === 'PREFIX') {
        const prefixStart = skipSparqlSpaceAndLineComments(sparql, token.end);
        const prefix = readSparqlPrefixName(sparql, prefixStart);
        if (!prefix || prefix.local.length > 0) {
          i = token.end;
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
      i = token.end;
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
    const token = depth === 0 ? readStandaloneSparqlWord(sparql, i) : null;
    if (!token) {
      i++;
      continue;
    }

    if (token.word !== 'VALUES') {
      i = token.end;
      continue;
    }

    const variableStart = skipSparqlSpaceAndLineComments(sparql, token.end);
    const candidate = readSparqlVariable(sparql, variableStart);
    if (candidate !== variable) {
      i = token.end;
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
