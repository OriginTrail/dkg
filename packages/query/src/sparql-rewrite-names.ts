import type { PreparedSparqlQuery } from '@origintrail-official/dkg-rdf-utils/sparql';

function freshNames(taken: Iterable<string>): (preferred: string) => string {
  const used = new Set(taken);
  return (preferred) => {
    let name = preferred;
    let suffix = 0;
    while (used.has(name)) name = `${preferred}${suffix++}`;
    used.add(name);
    return name;
  };
}

export type VariableAllocator = (preferred: string) => string;

/** One allocator per rewrite, seeded with logical names (including UCHAR spellings). */
export function createVariableAllocator(scope: PreparedSparqlQuery): VariableAllocator {
  const fresh = freshNames(scope.queryVariables.map(variable => variable.logicalName));
  return preferred => `?${fresh(preferred)}`;
}

/** Named blank nodes are two adjacent canonical tokens: `_` and `:label`. */
export function namedBlankNodes(scope: PreparedSparqlQuery, from = 0, to = scope.prepared.tokens.length) {
  const { tokens } = scope.prepared;
  const labels: { name: string; start: number; end: number }[] = [];
  for (let index = from; index < to; index++) {
    const token = tokens[index];
    const name = tokens[index + 1];
    if (token.kind !== 'symbol' || token.logicalValue !== '_' || name?.kind !== 'prefixed-name'
      || !name.logicalValue.startsWith(':') || name.logicalValue.length < 2 || token.end !== name.start) continue;
    labels.push({ name: name.logicalValue.slice(1), start: token.start, end: name.end });
    index++;
  }
  return labels;
}

/** Fresh labels per copied branch, retaining repeated references within that branch. */
export function createBlankNodeRenamer(scope: PreparedSparqlQuery): (from: number, to: number) => string {
  const labels = namedBlankNodes(scope);
  const fresh = freshNames(labels.map(label => label.name));
  return (from, to) => {
    const renamed = new Map<string, string>();
    let result = '';
    let cursor = from;
    for (const label of labels) {
      if (label.start < from || label.end > to) continue;
      let name = renamed.get(label.name);
      if (!name) {
        name = `_:${fresh('__dkgBranch0')}`;
        renamed.set(label.name, name);
      }
      result += scope.source.slice(cursor, label.start) + name;
      cursor = label.end;
    }
    return result + scope.source.slice(cursor, to);
  };
}
