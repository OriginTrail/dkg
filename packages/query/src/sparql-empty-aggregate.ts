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

/** What the reading of a WHERE group goes by. */
interface GroupReading {
  readonly tokens: readonly SparqlLexicalToken[];
  readonly closingBraceOf: readonly number[];
  readonly closingParenthesisOf: readonly number[];
}

/** The words that stand for a term in a triple pattern. */
const TERM_WORDS: ReadonlySet<string> = new Set(['A', 'TRUE', 'FALSE']);

/** Groups nested deeper than this are not read: the query keeps its answer without rows. */
const MAX_GROUP_DEPTH = 16;

/**
 * Whether the group that opens at `opening` has no solution unless the reader
 * can read stored data. `false` also stands for "cannot tell".
 *
 * A group joins its elements, and a join with an element that has no solution
 * has none. The element that has none over no data is a triple pattern of
 * plain terms, so one has to be there whatever stands beside it: in the group
 * itself, inside a GRAPH clause or a nested group, or in every branch of a
 * UNION. Without one the group can have solutions over no data at all: inline
 * VALUES, BIND, OPTIONAL alone, FILTER NOT EXISTS, an empty group. So can a
 * property path that matches at length zero and a subquery that aggregates,
 * which is why neither is read as a proof.
 */
function groupNeedsStoredData(reading: GroupReading, opening: number, depth = 0): boolean {
  const { tokens, closingBraceOf } = reading;
  const closing = closingBraceOf[opening]!;
  if (depth > MAX_GROUP_DEPTH || isWord(tokens[opening + 1], 'SELECT')) return false;
  let proven = false;
  let index = opening + 1;
  while (index < closing) {
    const token = tokens[index]!;
    if (isSymbol(token, '.')) {
      index += 1;
    } else if (isSymbol(token, '{')) {
      // A nested group, or the branches of a UNION: every branch has to need the data.
      let everyBranch = groupNeedsStoredData(reading, index, depth + 1);
      index = closingBraceOf[index]! + 1;
      while (isWord(tokens[index], 'UNION') && isSymbol(tokens[index + 1], '{')) {
        everyBranch = groupNeedsStoredData(reading, index + 1, depth + 1) && everyBranch;
        index = closingBraceOf[index + 1]! + 1;
      }
      proven ||= everyBranch;
    } else if (token.kind !== 'word' || TERM_WORDS.has(token.upper)) {
      const end = plainTriplesBlockEnd(tokens, index, closing);
      if (end < 0) return false;
      proven = true;
      index = end;
    } else if (token.upper === 'GRAPH' && isSymbol(tokens[index + 2], '{')) {
      // GRAPH <name> { ... }: no solution when its own group has none.
      proven ||= groupNeedsStoredData(reading, index + 2, depth + 1);
      index = closingBraceOf[index + 2]! + 1;
    } else {
      const end = unreadElementEnd(reading, index, token.upper);
      if (end < 0) return false;
      index = end;
    }
  }
  return proven;
}

/**
 * The index after the element the keyword at `index` opens, for the elements
 * that filter, extend or join what the group has and are never read as a
 * proof; -1 for a keyword this reading does not know (SERVICE among them).
 */
function unreadElementEnd(reading: GroupReading, index: number, keyword: string): number {
  const { tokens, closingBraceOf, closingParenthesisOf } = reading;
  const next = index + 1;
  const afterBraces = (at: number): number => (isSymbol(tokens[at], '{') ? closingBraceOf[at]! + 1 : -1);
  const afterParentheses = (at: number): number => (
    isSymbol(tokens[at], '(') ? closingParenthesisOf[at]! + 1 : -1
  );
  switch (keyword) {
    case 'OPTIONAL':
    case 'MINUS':
      return afterBraces(next);
    case 'VALUES':
      // VALUES ?x { ... } or VALUES ( ?x ?y ) { ... }
      return afterBraces(isSymbol(tokens[next], '(') ? afterParentheses(next) : next + 1);
    case 'BIND':
      return afterParentheses(next);
    case 'FILTER': {
      const exists = isWord(tokens[next], 'NOT') ? next + 1 : next;
      if (isWord(tokens[exists], 'EXISTS')) return afterBraces(exists + 1);
      // FILTER ( ... ) or FILTER fn( ... )
      return afterParentheses(isSymbol(tokens[next], '(') ? next : next + 1);
    }
    default:
      return -1;
  }
}

/**
 * The index after the triples block that starts at `start`, or -1 when it is
 * not made of plain terms only: at least a subject, a predicate and an object,
 * continued with `;` and `,`, and nothing a property path, a collection or a
 * blank node property list is written with.
 */
function plainTriplesBlockEnd(
  tokens: readonly SparqlLexicalToken[],
  start: number,
  closing: number,
): number {
  let terms = 0;
  let index = start;
  while (index < closing) {
    const token = tokens[index]!;
    if (isSymbol(token, '.') || isSymbol(token, '{')) break;
    if (token.kind === 'word') {
      // Any word that is not a term opens the next element.
      if (!TERM_WORDS.has(token.upper)) break;
      terms += 1;
      index += 1;
    } else if (token.kind === 'string') {
      terms += 1;
      index += 1;
      // "..."@lang and "..."^^<datatype>
      if (isSymbol(tokens[index], '@') && tokens[index + 1]?.kind === 'word') {
        index += 2;
      } else if (isSymbol(tokens[index], '^') && isSymbol(tokens[index + 1], '^')) {
        const datatype = tokens[index + 2]?.kind;
        if (datatype !== 'iri' && datatype !== 'prefixed-name') return -1;
        index += 3;
      }
    } else if (isSymbol(token, '_') && tokens[index + 1]?.kind === 'prefixed-name') {
      // A labelled blank node, _:b
      terms += 1;
      index += 2;
    } else if (token.kind === 'symbol') {
      if (token.logicalValue !== ';' && token.logicalValue !== ',') return -1;
      index += 1;
    } else {
      // A variable, an IRI, a prefixed name or a number.
      terms += 1;
      index += 1;
    }
  }
  return terms >= 3 ? index : -1;
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
 * has over data the reader cannot read, or `null` when the query is not of a
 * shape this can answer.
 *
 * A query that aggregates without GROUP BY has exactly one group, also when
 * nothing matched, so its answer over no data is one row (`COUNT` is 0), never
 * no rows. An empty answer the node builds instead of running the query has
 * to be that row too: a client that asked for a count reads the count.
 *
 * Two things have to hold for the row to be known without running the query.
 * The projection is made only of bare calls, `(COUNT(...) AS ?n)` and the
 * like: their values over an empty group are constants, where an expression
 * around a set function needs an evaluator. And the WHERE group is one that
 * has no solution without stored data (see `groupNeedsStoredData`):
 * `{ VALUES ?x { 1 2 } }` counts 2 over no data, not 0. Every other query
 * keeps the answer without rows, as do GROUP BY (no group at all), HAVING and
 * a trailing VALUES.
 */
export function emptyImplicitGroupSolution(sparql: string): Record<string, string> | null {
  const prepared = prepareSparql(sparql);
  if (prepared.status !== 'valid' || prepared.unterminated) return null;
  const query = prepareSparqlQuery(prepared);
  if (query.operation !== 'SELECT' || query.where === null || !query.structure.balanced) return null;

  const { tokens } = prepared;
  const closingParenthesisOf = query.structure.parentheses.matchingTokenIndexes;
  const reading: GroupReading = {
    tokens,
    closingBraceOf: query.structure.braces.matchingTokenIndexes,
    closingParenthesisOf,
  };
  if (!groupNeedsStoredData(reading, query.where.openingTokenIndex)) return null;
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
    if (typeof value === 'string') {
      // Defined, not assigned: `?__proto__` is a legal variable, and an
      // assignment to that name hits the inherited setter and drops the column.
      Object.defineProperty(solution, name, {
        value, writable: true, enumerable: true, configurable: true,
      });
    }
    index = itemEnd + 1;
  }
  if (projected.size === 0) return null;
  return modifiersKeepTheSingleRow(tokens, query.where.closingTokenIndex + 1) ? solution : null;
}
