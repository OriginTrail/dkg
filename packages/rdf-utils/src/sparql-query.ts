import {
  type SparqlLexicalToken,
  type ValidPreparedSparql,
} from './sparql-lexical-scanner.js';
import {
  indexSparqlStructure,
  sparqlTokenIndexesAtDepth,
  type SparqlStructure,
} from './sparql-structure.js';

export interface SparqlQueryGroupRange {
  /** Raw source span of the opening brace token. */
  readonly openStart: number;
  readonly openEnd: number;
  readonly close: number;
  readonly hasUnion: boolean;
  readonly openingTokenIndex: number;
  readonly closingTokenIndex: number;
}

/** A variable's source spelling and its UCHAR-decoded SPARQL identity. */
export interface SparqlQueryVariable {
  readonly source: string;
  readonly logicalName: string;
}

interface SparqlGraphTargetCoordinates {
  readonly keywordTokenIndex: number;
  readonly targetTokenIndex: number;
  readonly braceDepth: number;
}

/** One standard SPARQL GRAPH operand with canonical source coordinates. */
export type SparqlGraphTarget = SparqlGraphTargetCoordinates & (
  | { readonly kind: 'iri'; readonly iri: string }
  | { readonly kind: 'variable'; readonly variable: SparqlQueryVariable }
  | { readonly kind: 'invalid' }
);

/** Reusable prepared query facts derived from one canonical lexical artifact. */
export interface PreparedSparqlQuery {
  readonly source: string;
  readonly prepared: ValidPreparedSparql;
  readonly structure: SparqlStructure;
  readonly operation: string | null;
  readonly where: SparqlQueryGroupRange | null;
  readonly queryVariables: readonly SparqlQueryVariable[];
  readonly whereVariables: readonly SparqlQueryVariable[];
  readonly prefixes: ReadonlyMap<string, string>;
  readonly hasDatasetClause: boolean;
  readonly hasGraphClause: boolean;
  readonly graphTargets: readonly SparqlGraphTarget[];
  readonly graphVariables: readonly SparqlQueryVariable[];
}

function iriValue(token: SparqlLexicalToken | undefined): string | null {
  return token?.kind === 'iri' ? token.logicalValue : null;
}

function prefixesFromTokens(prepared: ValidPreparedSparql): Map<string, string> {
  const prefixes = new Map<string, string>();
  for (let index = 0; index + 2 < prepared.prologue.endTokenIndex; index++) {
    const keyword = prepared.tokens[index];
    const name = prepared.tokens[index + 1];
    const iri = prepared.tokens[index + 2];
    if (
      keyword?.kind !== 'word'
      || keyword.upper !== 'PREFIX'
      || name?.kind !== 'prefixed-name'
      || !name.logicalValue.endsWith(':')
    ) continue;
    const declaredIri = iriValue(iri);
    if (declaredIri !== null) prefixes.set(name.logicalValue.slice(0, -1), declaredIri);
    index += 2;
  }
  return prefixes;
}

function whereRange(
  prepared: ValidPreparedSparql,
  structure: SparqlStructure,
): SparqlQueryGroupRange | null {
  const { tokens } = prepared;
  const topLevelOpenings: number[] = [];
  let explicitOpening = -1;

  for (const index of sparqlTokenIndexesAtDepth(structure.braces, 0)) {
    const token = tokens[index];
    if (token?.kind === 'word' && token.upper === 'WHERE') {
      const next = tokens[index + 1];
      if (next?.kind !== 'symbol' || next.logicalValue !== '{') {
        return null;
      }
      explicitOpening = index + 1;
      break;
    }
    if (token?.kind === 'symbol' && token.logicalValue === '{') {
      topLevelOpenings.push(index);
    }
  }

  const openingIndex = explicitOpening >= 0
    ? explicitOpening
    : structure.braces.balanced
      ? (topLevelOpenings.at(-1) ?? -1)
      : -1;
  if (openingIndex < 0) return null;
  const closingIndex = structure.braces.matchingTokenIndexes[openingIndex] ?? -1;
  if (closingIndex < 0) return null;
  const bodyDepth = structure.braces.depthBefore[openingIndex] + 1;
  const hasUnion = sparqlTokenIndexesAtDepth(
    structure.braces,
    bodyDepth,
    openingIndex + 1,
    closingIndex,
  ).some((index) => {
    const token = tokens[index];
    return token?.kind === 'word' && token.upper === 'UNION';
  });
  return {
    openStart: tokens[openingIndex].start,
    openEnd: tokens[openingIndex].end,
    close: tokens[closingIndex].start,
    hasUnion,
    openingTokenIndex: openingIndex,
    closingTokenIndex: closingIndex,
  };
}

function variablesInRange(
  prepared: ValidPreparedSparql,
  start: number,
  end: number,
): SparqlQueryVariable[] {
  const variables: SparqlQueryVariable[] = [];
  const seen = new Set<string>();
  for (let index = start; index < end; index++) {
    const token = prepared.tokens[index];
    if (token?.kind !== 'variable') continue;
    const logicalName = token.logicalValue.slice(1);
    if (seen.has(logicalName)) continue;
    seen.add(logicalName);
    variables.push({ source: token.raw, logicalName });
  }
  return variables;
}

export function prepareSparqlQuery(prepared: ValidPreparedSparql): PreparedSparqlQuery {
  const structure = indexSparqlStructure(prepared);
  const where = whereRange(prepared, structure);
  const operationToken = prepared.tokens[prepared.prologue.endTokenIndex];
  const prefixes = prefixesFromTokens(prepared);
  const braceDepths = structure.braces.depthBefore;
  const graphTargets: SparqlGraphTarget[] = [];
  const graphVariables: SparqlQueryVariable[] = [];
  const graphVariableSet = new Set<string>();
  let hasDatasetClause = false;

  for (let index = 0; index < prepared.tokens.length; index++) {
    const token = prepared.tokens[index];
    if (token.kind !== 'word') continue;
    if (token.upper === 'FROM') hasDatasetClause = true;
    if (token.upper !== 'GRAPH') continue;

    const target = prepared.tokens[index + 1];
    if (target?.kind === 'variable') {
      const variable = {
        source: target.raw,
        logicalName: target.logicalValue.slice(1),
      };
      graphTargets.push({
        kind: 'variable',
        variable,
        keywordTokenIndex: index,
        targetTokenIndex: index + 1,
        braceDepth: braceDepths[index],
      });
      if (!graphVariableSet.has(variable.logicalName)) {
        graphVariableSet.add(variable.logicalName);
        graphVariables.push(variable);
      }
      continue;
    }

    const directIri = iriValue(target);
    if (directIri !== null) {
      graphTargets.push({
        kind: 'iri',
        iri: directIri,
        keywordTokenIndex: index,
        targetTokenIndex: index + 1,
        braceDepth: braceDepths[index],
      });
      continue;
    }

    if (target?.kind === 'prefixed-name') {
      const colon = target.logicalValue.indexOf(':');
      const base = prefixes.get(target.logicalValue.slice(0, colon));
      if (colon >= 0 && base !== undefined) {
        graphTargets.push({
          kind: 'iri',
          iri: `${base}${target.logicalValue.slice(colon + 1)}`,
          keywordTokenIndex: index,
          targetTokenIndex: index + 1,
          braceDepth: braceDepths[index],
        });
        continue;
      }
    }

    graphTargets.push({
      kind: 'invalid',
      keywordTokenIndex: index,
      targetTokenIndex: index + 1,
      braceDepth: braceDepths[index],
    });
  }

  return {
    source: prepared.source,
    prepared,
    structure,
    operation: operationToken?.kind === 'word'
      ? operationToken.upper
      : null,
    where,
    queryVariables: variablesInRange(prepared, 0, prepared.tokens.length),
    whereVariables: where
      ? variablesInRange(prepared, where.openingTokenIndex + 1, where.closingTokenIndex)
      : [],
    prefixes,
    hasDatasetClause,
    hasGraphClause: graphTargets.length > 0,
    graphTargets,
    graphVariables,
  };
}
