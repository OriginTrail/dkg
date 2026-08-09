import {
  findMatchingSparqlCloseBrace as findMatchingCloseBrace,
  readNextSparqlCodeToken,
  readSparqlPrefixName,
  type SparqlPrefixName,
  readSparqlVariable,
  skipSparqlIriRef,
  skipSparqlSpaceAndLineComments,
} from './sparql-utils.js';

export function collectPrefixDeclarations(sparql: string): Map<string, string> {
  const prefixes = new Map<string, string>();
  let i = 0;

  for (let token = readNextSparqlCodeToken(sparql, i); token !== null;
    token = readNextSparqlCodeToken(sparql, i)) {
    i = token.end;
    if (token.kind === 'word') {
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
    }
  }

  return prefixes;
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

  for (let token = readNextSparqlCodeToken(sparql, i, braceEnd); token !== null;
    token = readNextSparqlCodeToken(sparql, i, braceEnd)) {
    i = token.end;
    if (token.kind === 'char' && token.value === '{') {
      depth++;
      continue;
    }
    if (token.kind === 'char' && token.value === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0 || token.kind !== 'word') continue;

    if (token.word !== 'VALUES') {
      continue;
    }

    const variableStart = skipSparqlSpaceAndLineComments(sparql, token.end);
    const candidate = readSparqlVariable(sparql, variableStart);
    if (candidate !== variable) {
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
