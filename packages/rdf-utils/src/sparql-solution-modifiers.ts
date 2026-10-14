import type { ValidPreparedSparql } from './sparql-lexical-scanner.js';
import type { PreparedSparqlQuery } from './sparql-query.js';
import type { SparqlStructure } from './sparql-structure.js';

export interface SparqlSolutionModifiers {
  readonly hasLimit: boolean;
  readonly hasOffset: boolean;
  readonly hasOrderBy: boolean;
  /** Raw source coordinate before trailing VALUES, or the end of the query. */
  readonly insertionOffset: number;
}

/** Syntax facts only; request ceilings and complete/page policy belong to callers. */
export function readSolutionModifiers(prepared: ValidPreparedSparql, structure: SparqlStructure): SparqlSolutionModifiers {
  let hasLimit = false, hasOffset = false, hasOrderBy = false;
  let insertionOffset = prepared.source.length;
  for (const [index, token] of prepared.tokens.entries()) {
    if (token.kind !== 'word' || structure.braces.depthBefore[index] !== 0) continue;
    if (token.upper === 'LIMIT') hasLimit = true;
    if (token.upper === 'OFFSET') hasOffset = true;
    if (token.upper === 'VALUES') insertionOffset = Math.min(insertionOffset, token.start);
    const next = prepared.tokens[index + 1];
    if (token.upper === 'ORDER' && next?.kind === 'word' && next.upper === 'BY') hasOrderBy = true;
  }
  return { hasLimit, hasOffset, hasOrderBy, insertionOffset };
}

/** Add only outer SELECT modifiers, leaving nested queries and raw source intact. */
export function boundPreparedSelect(query: PreparedSparqlQuery, limit: number, offset = 0): string {
  if (query.operation !== 'SELECT' || query.solutionModifiers.hasLimit || query.solutionModifiers.hasOffset) {
    throw new Error('Expected a SELECT query without outer LIMIT or OFFSET');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Expected a positive safe integer limit and nonnegative safe integer offset');
  }
  const insertion = query.solutionModifiers.insertionOffset;
  // VALUES follows solution modifiers in SPARQL 1.1; newlines also close comments.
  const modifiers = `\nLIMIT ${limit}${offset ? ` OFFSET ${offset}` : ''}\n`;
  return query.source.slice(0, insertion) + modifiers + query.source.slice(insertion);
}
