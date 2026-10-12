import { formatCanonicalRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import {
  prepareSparql,
  prepareSparqlQuery,
  type SparqlLexicalToken,
} from '@origintrail-official/dkg-rdf-utils/sparql';

// The same serialization a store adapter gives the terms of a real answer.
const INTEGER_ZERO = formatCanonicalRdfLiteralTerm({
  kind: 'typed',
  value: '0',
  datatype: 'http://www.w3.org/2001/XMLSchema#integer',
});
const EMPTY_STRING = formatCanonicalRdfLiteralTerm({ kind: 'plain', value: '' });

/**
 * What each SPARQL 1.1 set function yields for a group with no solutions
 * (section 18.5.1). `null` is an error there, which leaves the projected
 * variable unbound.
 */
const EMPTY_GROUP_VALUES: ReadonlyMap<string, string | null> = new Map([
  ['COUNT', INTEGER_ZERO],
  ['SUM', INTEGER_ZERO],
  ['AVG', INTEGER_ZERO],
  ['GROUP_CONCAT', EMPTY_STRING],
  ['MIN', null],
  ['MAX', null],
  ['SAMPLE', null],
]);

function isWord(token: SparqlLexicalToken | undefined, upper: string): boolean {
  return token?.kind === 'word' && token.upper === upper;
}

function isSymbol(token: SparqlLexicalToken | undefined, value: string): boolean {
  return token?.kind === 'symbol' && token.logicalValue === value;
}

/**
 * Whether the solution modifiers after the WHERE group keep the single row of
 * an implicit group. GROUP BY makes the groups explicit (none, over no data),
 * HAVING and a trailing VALUES need an evaluator, and LIMIT 0 or a positive
 * OFFSET drop the row.
 */
function modifiersKeepTheSingleRow(
  tokens: readonly SparqlLexicalToken[],
  start: number,
): boolean {
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.kind !== 'word') continue;
    if (token.upper === 'GROUP' || token.upper === 'HAVING' || token.upper === 'VALUES') return false;
    if (token.upper !== 'LIMIT' && token.upper !== 'OFFSET') continue;
    const count = tokens[index + 1];
    if (count?.kind !== 'number' || !/^[0-9]+$/.test(count.logicalValue)) return false;
    const isZero = /^0+$/.test(count.logicalValue);
    if (token.upper === 'LIMIT' ? isZero : !isZero) return false;
  }
  return true;
}

/**
 * The one solution a SELECT whose projection is made only of set functions
 * has over a dataset with no matching data, or `null` when the query is not of
 * that shape.
 *
 * A query that aggregates without GROUP BY has exactly one group, also when
 * nothing matched, so its answer over no data is one row (`COUNT` is 0), never
 * no rows. An empty answer the node builds instead of running the query has
 * to be that row too: a client that asked for a count reads the count.
 *
 * Only a projection of bare calls, `(COUNT(...) AS ?n)` and the like, is
 * answered here: their values over no data are constants. An expression around
 * a set function needs an evaluator, so such a query keeps the answer without
 * rows, as do GROUP BY (no group at all), HAVING and a trailing VALUES.
 */
export function emptyImplicitGroupSolution(sparql: string): Record<string, string> | null {
  const prepared = prepareSparql(sparql);
  if (prepared.status !== 'valid' || prepared.unterminated) return null;
  const query = prepareSparqlQuery(prepared);
  if (query.operation !== 'SELECT' || query.where === null || !query.structure.balanced) return null;

  const { tokens } = prepared;
  const closingParenthesisOf = query.structure.parentheses.matchingTokenIndexes;
  const explicitWhere = isWord(tokens[query.where.openingTokenIndex - 1], 'WHERE');
  const projectionEnd = query.where.openingTokenIndex - (explicitWhere ? 1 : 0);
  let index = prepared.prologue.endTokenIndex + 1;
  if (isWord(tokens[index], 'DISTINCT') || isWord(tokens[index], 'REDUCED')) index += 1;

  const solution: Record<string, string> = {};
  const projected = new Set<string>();
  while (index < projectionEnd && !isWord(tokens[index], 'FROM')) {
    // One item: ( <set function> ( ... ) AS ?variable )
    const itemEnd = closingParenthesisOf[index] ?? -1;
    const setFunction = tokens[index + 1];
    const callEnd = closingParenthesisOf[index + 2] ?? -1;
    const variable = tokens[itemEnd - 1];
    if (
      !isSymbol(tokens[index], '(')
      || itemEnd < 0
      || itemEnd >= projectionEnd
      || setFunction?.kind !== 'word'
      || !EMPTY_GROUP_VALUES.has(setFunction.upper)
      || !isSymbol(tokens[index + 2], '(')
      || callEnd !== itemEnd - 3
      || !isWord(tokens[itemEnd - 2], 'AS')
      || variable?.kind !== 'variable'
    ) return null;
    const name = variable.logicalValue.slice(1);
    if (projected.has(name)) return null;
    projected.add(name);
    const value = EMPTY_GROUP_VALUES.get(setFunction.upper);
    if (typeof value === 'string') solution[name] = value;
    index = itemEnd + 1;
  }
  if (projected.size === 0) return null;
  return modifiersKeepTheSingleRow(tokens, query.where.closingTokenIndex + 1) ? solution : null;
}
