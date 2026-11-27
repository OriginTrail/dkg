import { isSparqlKeyword, type PreparedSparqlQuery, type SparqlLexicalToken } from '@origintrail-official/dkg-rdf-utils/sparql';

function isSymbol(token: SparqlLexicalToken | undefined, value: string): boolean {
  return token?.kind === 'symbol' && token.logicalValue === value;
}

/** Keywords that start a construct which is not itself a triple pattern. */
const NON_TRIPLE_WORDS = new Set(['VALUES', 'BIND', 'FILTER', 'OPTIONAL', 'MINUS', 'UNION', 'EXISTS', 'NOT', 'GRAPH', 'SERVICE', 'SILENT', 'AS']);

/** Whether the group between these braces is a subquery: its content is a SELECT. */
export function isSubqueryGroup(scope: PreparedSparqlQuery, opening: number): boolean {
  return isSparqlKeyword(scope.prepared.tokens, opening + 1, 'SELECT');
}

/** Whether the group between these braces has a path with `*` or `?` of its own, which matches without a triple. */
function hasOwnZeroLengthPath(scope: PreparedSparqlQuery, opening: number, closing: number): boolean {
  const { tokens } = scope.prepared;
  const depth = scope.structure.braces.depthBefore[opening] + 1;
  for (let index = opening + 1; index < closing; index++) {
    if (scope.structure.braces.depthBefore[index] !== depth) continue;
    if (!isSymbol(tokens[index], '*') && !isSymbol(tokens[index], '?')) continue;
    const before = tokens[index - 1];
    if (before?.kind === 'iri' || before?.kind === 'prefixed-name' || isSymbol(before, ')')
      || (before?.kind === 'word' && before.logicalValue === 'a' && isSparqlKeyword(tokens, index - 1, 'A'))) return true;
  }
  return false;
}

/**
 * Whether the group between these braces has a triple pattern of its own, not
 * only in nested groups, that needs a stored triple to match. A path with `*` or
 * `?` matches its endpoints without one, so a group that has one counts as having
 * no pattern of its own.
 */
export function hasOwnTriplePattern(scope: PreparedSparqlQuery, opening: number, closing: number): boolean {
  const { tokens } = scope.prepared;
  // A group that is a subquery has no pattern of its own; the subquery's are nested.
  if (isSubqueryGroup(scope, opening) || hasOwnZeroLengthPath(scope, opening, closing)) return false;
  const depth = scope.structure.braces.depthBefore[opening] + 1;
  for (let index = opening + 1; index < closing; index++) {
    if (scope.structure.braces.depthBefore[index] !== depth) continue;
    const token = tokens[index];
    if (token.kind === 'symbol') {
      // An expression of BIND, FILTER or a VALUES header: no triple inside.
      if (token.logicalValue === '(') index = scope.structure.parentheses.matchingTokenIndexes[index] ?? closing;
      continue;
    }
    if (token.kind === 'word' && NON_TRIPLE_WORDS.has(token.upper)) {
      // The term after GRAPH, SERVICE or VALUES names a graph, an endpoint or a variable.
      if ((token.upper === 'GRAPH' || token.upper === 'SERVICE' || token.upper === 'VALUES') && tokens[index + 1]?.kind !== 'symbol') index++;
      // A FILTER whose constraint is a function named by an IRI, such as xsd:boolean(...).
      const after = tokens[index + 1];
      if (token.upper === 'FILTER' && (after?.kind === 'iri' || after?.kind === 'prefixed-name') && isSymbol(tokens[index + 2], '(')) index++;
      continue;
    }
    // A function call of a FILTER written without brackets, such as regex(...).
    const next = tokens[index + 1];
    if (token.kind === 'word' && next?.kind === 'symbol' && next.logicalValue === '(') continue;
    return true;
  }
  return false;
}

/**
 * Whether Oxigraph reads the GRAPH ?var block between these braces without
 * binding ?var once per graph of the dataset: the block has no triple pattern of
 * its own and holds a VALUES, a subquery or a nested GRAPH, so ?var stays unbound
 * or collapses there. Such a block keeps the graph list, which binds ?var.
 */
export function graphBlockNeedsList(scope: PreparedSparqlQuery, opening: number, closing: number): boolean {
  const { tokens } = scope.prepared;
  let holds = false;
  for (let index = opening + 1; index < closing && !holds; index++) {
    holds = ['SELECT', 'GRAPH', 'VALUES'].some(keyword => isSparqlKeyword(tokens, index, keyword));
  }
  return holds && !hasOwnTriplePattern(scope, opening, closing);
}
