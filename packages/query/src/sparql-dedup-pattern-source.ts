import type { PreparedSparqlQuery } from '@origintrail-official/dkg-rdf-utils/sparql';

/** Render the replayed pattern from canonical coordinates, keeping hidden terms private. */
export function renderDedupPattern(
  scope: PreparedSparqlQuery,
  filters: readonly { readonly start: number; readonly end: number }[],
): { pattern: string; helperVariables: readonly string[] } {
  const where = scope.where!;
  const { tokens } = scope.prepared;
  const used = new Set(scope.queryVariables.map(variable => variable.logicalName));
  const labels = new Map<string, string>();
  const edits = filters.map(range => ({ ...range, replacement: 'FILTER(true)' }));
  for (let index = where.openingTokenIndex + 1; index < where.closingTokenIndex; index++) {
    const token = tokens[index];
    const name = tokens[index + 1];
    if (token.kind !== 'symbol' || token.logicalValue !== '_' || name?.kind !== 'prefixed-name'
      || !name.logicalValue.startsWith(':') || name.logicalValue.length < 2 || token.end !== name.start) continue;
    if (filters.some(range => token.start >= range.start && token.start < range.end)) continue;
    let variable = labels.get(name.logicalValue);
    if (!variable) {
      let suffix = 0;
      while (used.has(`__dkgBlankNode${suffix}`)) suffix++;
      const logicalName = `__dkgBlankNode${suffix}`;
      used.add(logicalName);
      variable = `?${logicalName}`;
      labels.set(name.logicalValue, variable);
    }
    // Named blank nodes cannot be copied across SPARQL basic graph patterns.
    // A private variable preserves each label's joins; the candidate subquery
    // does not project it, so it cannot correlate with the independent replay.
    edits.push({ start: token.start, end: name.end, replacement: variable });
    index++;
  }
  let from = where.openEnd;
  let pattern = '';
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    pattern += scope.source.slice(from, edit.start) + edit.replacement;
    from = edit.end;
  }
  pattern += scope.source.slice(from, where.close);
  return { pattern, helperVariables: [...labels.values()] };
}
