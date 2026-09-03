import {
  indexSparqlStructure,
  prepareSparql,
  sparqlTokenIndexesAtDepth,
  type PreparedSparql,
  type SparqlLexicalToken,
  type SparqlStructure,
} from '@origintrail-official/dkg-rdf-utils/sparql';

type ValuedToken = Extract<SparqlLexicalToken, { value: string }>;

function isValuedToken(token: SparqlLexicalToken | undefined): token is ValuedToken {
  return token !== undefined && 'value' in token;
}

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

/** Neutral prepared query facts shared by independent rewrite policies. */
export interface PreparedSparqlQuery {
  readonly source: string;
  readonly prepared: PreparedSparql;
  readonly structure: SparqlStructure;
  readonly operation: string | null;
  readonly where: SparqlQueryGroupRange | null;
  readonly queryVariables: readonly SparqlQueryVariable[];
  readonly whereVariables: readonly SparqlQueryVariable[];
}

export type SparqlRewriteResult<Value, Reason extends string, Original = Value> =
  | { readonly kind: 'ready'; readonly value: Value }
  | { readonly kind: 'unsupported'; readonly original: Original; readonly reason: Reason };

export function sparqlRewriteReady<Value>(value: Value): { readonly kind: 'ready'; readonly value: Value } {
  return { kind: 'ready', value };
}

export function sparqlRewriteUnsupported<Original, Reason extends string>(
  original: Original,
  reason: Reason,
): { readonly kind: 'unsupported'; readonly original: Original; readonly reason: Reason } {
  return { kind: 'unsupported', original, reason };
}

function whereRange(
  prepared: PreparedSparql,
  structure: SparqlStructure,
): SparqlQueryGroupRange | null {
  const { tokens } = prepared;
  const topLevelOpenings: number[] = [];
  let explicitOpening = -1;

  for (const index of sparqlTokenIndexesAtDepth(structure.braces, 0)) {
    const token = tokens[index];
    if (
      isValuedToken(token)
      && token.kind === 'word'
      && token.upper === 'WHERE'
    ) {
      const next = tokens[index + 1];
      if (!isValuedToken(next) || next.kind !== 'symbol' || next.logicalValue !== '{') {
        return null;
      }
      explicitOpening = index + 1;
      break;
    }
    if (
      isValuedToken(token)
      && token.kind === 'symbol'
      && token.logicalValue === '{'
    ) topLevelOpenings.push(index);
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
    return isValuedToken(token) && token.kind === 'word' && token.upper === 'UNION';
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
  prepared: PreparedSparql,
  start: number,
  end: number,
): SparqlQueryVariable[] {
  const variables: SparqlQueryVariable[] = [];
  const seen = new Set<string>();
  for (let index = start; index < end; index++) {
    const token = prepared.tokens[index];
    if (!isValuedToken(token) || token.kind !== 'variable') continue;
    const logicalName = token.logicalValue.slice(1);
    if (seen.has(logicalName)) continue;
    seen.add(logicalName);
    variables.push({ source: token.value, logicalName });
  }
  return variables;
}

export function prepareSparqlQuery(
  source: string,
  prepared: PreparedSparql = prepareSparql(source),
): PreparedSparqlQuery {
  const structure = indexSparqlStructure(prepared);
  const where = whereRange(prepared, structure);
  const operationToken = prepared.tokens[prepared.prologue.endTokenIndex];
  return {
    source,
    prepared,
    structure,
    operation: isValuedToken(operationToken) && operationToken.kind === 'word'
      ? operationToken.upper
      : null,
    where,
    queryVariables: variablesInRange(prepared, 0, prepared.tokens.length),
    whereVariables: where
      ? variablesInRange(prepared, where.openingTokenIndex + 1, where.closingTokenIndex)
      : [],
  };
}
