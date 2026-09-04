import type { PreparedSparql, SparqlLexicalToken } from './sparql-lexical-scanner.js';

export interface SparqlDelimiterIndex {
  /** Nesting depth immediately before each token. */
  readonly depthBefore: readonly number[];
  /** Matching delimiter token index, or -1 for non-delimiters/unmatched input. */
  readonly matchingTokenIndexes: readonly number[];
  /** Matched group spans, ordered by opening token index. */
  readonly ranges: readonly SparqlGroupRange[];
  readonly balanced: boolean;
}

export interface SparqlGroupRange {
  readonly openingTokenIndex: number;
  readonly closingTokenIndex: number;
  /** Nesting depth before the opening delimiter. */
  readonly depth: number;
}

export interface SparqlStructure {
  readonly braces: SparqlDelimiterIndex;
  readonly parentheses: SparqlDelimiterIndex;
  readonly brackets: SparqlDelimiterIndex;
}

function indexDelimiter(
  tokens: readonly SparqlLexicalToken[],
  open: string,
  close: string,
): SparqlDelimiterIndex {
  const depthBefore: number[] = [];
  const matchingTokenIndexes = Array<number>(tokens.length).fill(-1);
  const ranges: SparqlGroupRange[] = [];
  const openings: number[] = [];
  let depth = 0;
  let balanced = true;

  for (let index = 0; index < tokens.length; index++) {
    depthBefore.push(depth);
    const token = tokens[index];
    if (token.kind !== 'symbol') continue;
    if (token.logicalValue === open) {
      openings.push(index);
      depth++;
      continue;
    }
    if (token.logicalValue !== close) continue;

    const opening = openings.pop();
    if (opening === undefined) {
      balanced = false;
    } else {
      matchingTokenIndexes[opening] = index;
      matchingTokenIndexes[index] = opening;
      ranges.push({
        openingTokenIndex: opening,
        closingTokenIndex: index,
        depth: depthBefore[opening],
      });
    }
    depth--;
  }

  return Object.freeze({
    depthBefore: Object.freeze(depthBefore),
    matchingTokenIndexes: Object.freeze(matchingTokenIndexes),
    ranges: Object.freeze(ranges.sort(
      (left, right) => left.openingTokenIndex - right.openingTokenIndex,
    )),
    balanced: balanced && openings.length === 0 && depth === 0,
  });
}

/** Build the one shared shallow delimiter/group index for policy consumers. */
export function indexSparqlStructure(prepared: PreparedSparql): SparqlStructure {
  const { tokens } = prepared;
  return Object.freeze({
    braces: indexDelimiter(tokens, '{', '}'),
    parentheses: indexDelimiter(tokens, '(', ')'),
    brackets: indexDelimiter(tokens, '[', ']'),
  });
}

/** Iterate a source range at one delimiter depth without reconstructing nesting. */
export function sparqlTokenIndexesAtDepth(
  delimiter: SparqlDelimiterIndex,
  depth: number,
  start = 0,
  end = delimiter.depthBefore.length,
): number[] {
  const indexes: number[] = [];
  for (let index = start; index < end; index++) {
    if (delimiter.depthBefore[index] === depth) indexes.push(index);
  }
  return indexes;
}
