import type { PreparedSparqlQuery } from '@origintrail-official/dkg-rdf-utils/sparql';
import { namedBlankNodes, type VariableAllocator } from './sparql-rewrite-names.js';

/** Render the replayed pattern from canonical coordinates, keeping hidden terms private. */
export function renderDedupPattern(
  scope: PreparedSparqlQuery,
  filters: readonly { readonly start: number; readonly end: number }[],
  allocate: VariableAllocator,
): string {
  const where = scope.where!;
  const labels = new Map<string, string>();
  const edits = filters.map(range => ({ ...range, replacement: 'FILTER(true)' }));
  for (const label of namedBlankNodes(scope, where.openingTokenIndex + 1, where.closingTokenIndex)) {
    if (filters.some(range => label.start >= range.start && label.start < range.end)) continue;
    let variable = labels.get(label.name);
    if (!variable) {
      variable = allocate(`__dkgBlankNode${labels.size}`);
      labels.set(label.name, variable);
    }
    // Named blank nodes cannot be copied across SPARQL basic graph patterns.
    // A private variable preserves each label's joins; the candidate subquery
    // does not project it, so it cannot correlate with the independent replay.
    edits.push({ start: label.start, end: label.end, replacement: variable });
  }
  let from = where.openEnd;
  let pattern = '';
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    pattern += scope.source.slice(from, edit.start) + edit.replacement;
    from = edit.end;
  }
  pattern += scope.source.slice(from, where.close);
  return pattern;
}
