import { assertSafeIri } from '@origintrail-official/dkg-core';
import type { PreparedSparqlQuery } from '@origintrail-official/dkg-rdf-utils/sparql';
import { transitionGraphScope } from './sparql-query-transition.js';
import { ScopedQueryViolationError } from './scoped-query-error.js';

/** Keep the graph identity of caller paths on engines that flatten GRAPH ?g. */
export function bindCallerGraphsBeforeRead(
  scope: PreparedSparqlQuery, graphs: readonly string[],
): PreparedSparqlQuery {
  const { tokens } = scope.prepared;
  const allowed = [...new Set(graphs)].map(graph => `<${assertSafeIri(graph)}>`);
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
    const inner = scope.source.slice(tokens[opening].end, tokens[closing].start);
    // Even an OPTIONAL barrier loses GRAPH ?g on Blazegraph's repeated
    // alternative paths. Constant targets retain it. Bind the caller's variable
    // inside each graph so its FILTERs and SELECT * retain the same bindings.
    const branches = allowed.map(graph => `{ GRAPH ${graph} { VALUES ${variable} { ${graph} } ${inner} } }`);
    source += scope.source.slice(from, start) + `{ ${branches.join(' UNION ')} }`;
    from = tokens[closing].end;
  }
  return transitionGraphScope(scope, source + scope.source.slice(from));
}
