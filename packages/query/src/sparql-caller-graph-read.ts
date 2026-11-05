import { assertSafeIri } from '@origintrail-official/dkg-core';
import { isSparqlKeyword, type PreparedSparqlQuery } from '@origintrail-official/dkg-rdf-utils/sparql';
import { transitionGraphScope } from './sparql-query-transition.js';
import { ScopedQueryViolationError } from './scoped-query-error.js';
import { createBlankNodeRenamer } from './sparql-rewrite-names.js';

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

/** Keep the graph identity of caller paths on engines that flatten GRAPH ?g. */
export function bindCallerGraphsBeforeRead(
  scope: PreparedSparqlQuery, graphs: readonly string[],
): PreparedSparqlQuery {
  const { tokens } = scope.prepared;
  const allowed = [...new Set(graphs)].map(graph => `<${assertSafeIri(graph)}>`);
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
    source += scope.source.slice(from, start) + `{ ${branches.join(' UNION ')} }`;
    from = tokens[closing].end;
  }
  return transitionGraphScope(scope, source + scope.source.slice(from));
}
