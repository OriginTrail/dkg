import { assertSafeIri } from '@origintrail-official/dkg-core';
import { isSparqlKeyword, type PreparedSparqlQuery } from '@origintrail-official/dkg-rdf-utils/sparql';
import { transitionGraphScope } from './sparql-query-transition.js';
import { ScopedQueryViolationError } from './scoped-query-error.js';
import { createBlankNodeRenamer } from './sparql-rewrite-names.js';

const MAX_CALLER_GRAPH_BRANCHES = 128;

/** Bound UNION nesting instead of giving the parser a linear chain of branches. */
function balancedUnion(branches: readonly string[], start = 0, end = branches.length): string {
  if (end - start <= 16) return branches.slice(start, end).join(' UNION ');
  const middle = start + Math.floor((end - start) / 2);
  return `{ ${balancedUnion(branches, start, middle)} } UNION { ${balancedUnion(branches, middle, end)} }`;
}

/** A generated binding must not precede a caller assignment in the same group. */
function assignsGraphVariable(scope: PreparedSparqlQuery, opening: number, closing: number, variable: string): boolean {
  const { tokens } = scope.prepared;
  const depth = scope.structure.braces.depthBefore[opening] + 1;
  for (let index = opening + 1; index < closing; index++) {
    if (scope.structure.braces.depthBefore[index] !== depth || !isSparqlKeyword(tokens, index, 'BIND')) continue;
    const end = scope.structure.parentheses.matchingTokenIndexes[index + 1] ?? -1;
    const target = tokens[end - 1];
    if (end > index && end < closing && isSparqlKeyword(tokens, end - 2, 'AS')
      && target?.kind === 'variable' && target.logicalValue.slice(1) === variable) return true;
  }
  return false;
}

/**
 * The assignments of each caller GRAPH ?var block to ?var, at any depth inside
 * it: `AS ?var` in a BIND or in a subquery's projection. An assignment of a
 * single IRI is `constant`; any other expression, which may fail and leave
 * ?var unbound, is `expression`.
 */
function callerGraphAssignmentsInside(scope: PreparedSparqlQuery): Array<'constant' | 'expression'> {
  const { tokens } = scope.prepared;
  const found: Array<'constant' | 'expression'> = [];
  for (const target of scope.graphTargets) {
    if (target.kind !== 'variable') continue;
    const opening = target.targetTokenIndex + 1;
    const closing = scope.structure.braces.matchingTokenIndexes[opening] ?? -1;
    for (let index = opening + 1; index < closing - 1; index++) {
      const next = tokens[index + 1];
      if (!isSparqlKeyword(tokens, index, 'AS') || next?.kind !== 'variable' || next.logicalValue.slice(1) !== target.variable.logicalName) continue;
      const term = tokens[index - 1];
      const before = tokens[index - 2];
      const constant = (term?.kind === 'iri' || term?.kind === 'prefixed-name') && before?.kind === 'symbol' && before.logicalValue === '(';
      found.push(constant ? 'constant' : 'expression');
    }
  }
  return found;
}

/** Whether one branch per graph of `graphs` for every caller GRAPH ?var block stays within the rewrite's bound. */
export function callerGraphBranchesFit(scope: PreparedSparqlQuery, graphs: readonly string[]): boolean {
  return new Set(graphs).size * scope.graphTargets.filter(target => target.kind === 'variable').length <= MAX_CALLER_GRAPH_BRANCHES;
}

/** Whether caller GRAPH ?var blocks assign ?var inside them, every time to a single IRI. */
export function hasCallerGraphAssignmentsInside(scope: PreparedSparqlQuery): boolean {
  const found = callerGraphAssignmentsInside(scope);
  return found.length > 0 && found.every(kind => kind === 'constant');
}

/** Whether a caller GRAPH ?var block assigns ?var an expression other than a single IRI, at any depth. */
export function hasCallerGraphExpressionAssignments(scope: PreparedSparqlQuery): boolean {
  return callerGraphAssignmentsInside(scope).includes('expression');
}

export function hasCallerGraphAssignments(scope: PreparedSparqlQuery): boolean {
  return scope.graphTargets.some(target => {
    if (target.kind !== 'variable') return false;
    const opening = target.targetTokenIndex + 1;
    const closing = scope.structure.braces.matchingTokenIndexes[opening] ?? -1;
    return closing >= 0 && assignsGraphVariable(scope, opening, closing, target.variable.logicalName);
  });
}

/** Keep the graph identity of caller paths on engines that flatten GRAPH ?g. */
export function bindCallerGraphsBeforeRead(
  scope: PreparedSparqlQuery, graphs: readonly string[],
): PreparedSparqlQuery {
  const { tokens } = scope.prepared;
  const allowed = [...new Set(graphs)].map(graph => `<${assertSafeIri(graph)}>`);
  // Bound the entire expansion, including queries with several GRAPH operands.
  // Larger native plans can overflow even when the textual UNION is balanced.
  if (allowed.length * scope.graphTargets.filter(target => target.kind === 'variable').length > MAX_CALLER_GRAPH_BRANCHES) {
    throw new ScopedQueryViolationError(`caller GRAPH rewrite requires at most ${MAX_CALLER_GRAPH_BRANCHES} graph branches on this store`);
  }
  const branchSource = createBlankNodeRenamer(scope);
  let from = 0;
  let source = '';
  for (const target of scope.graphTargets) {
    if (target.kind !== 'variable') continue;
    const opening = target.targetTokenIndex + 1;
    const closing = scope.structure.braces.matchingTokenIndexes[opening] ?? -1;
    const start = tokens[target.keywordTokenIndex].start;
    if (closing < 0 || start < from) {
      throw new ScopedQueryViolationError('unable to bind caller GRAPH before evaluation');
    }
    const variable = scope.source.slice(tokens[target.targetTokenIndex].start, tokens[target.targetTokenIndex].end);
    const needsOwnGroup = isSparqlKeyword(tokens, opening + 1, 'SELECT')
      || assignsGraphVariable(scope, opening, closing, target.variable.logicalName);
    // Even an OPTIONAL barrier loses GRAPH ?g on Blazegraph's repeated
    // alternative paths. Constant targets retain it. Keep the graph binding
    // available to ordinary FILTERs, outside caller assignments and subqueries.
    const branches = allowed.map(graph => {
      const inner = branchSource(tokens[opening].end, tokens[closing].start);
      const pattern = needsOwnGroup ? `{ ${inner} }` : inner;
      return `{ GRAPH ${graph} { VALUES ${variable} { ${graph} } ${pattern} } }`;
    });
    source += scope.source.slice(from, start) + `{ ${balancedUnion(branches)} }`;
    from = tokens[closing].end;
  }
  return transitionGraphScope(scope, source + scope.source.slice(from));
}
