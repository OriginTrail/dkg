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
