import { isRdfBlankNodeLabel } from '@origintrail-official/dkg-rdf-utils';
import type { PreparedSparqlQuery } from '@origintrail-official/dkg-rdf-utils/sparql';

/**
 * A blank-node label is scoped to one basic graph pattern. Repeating source in
 * another GRAPH/UNION/EXISTS must therefore alpha-rename its labels, preserving
 * repeated uses within each copy and leaving opaque text and templates alone.
 */
export function graphPatternCopies(scope: PreparedSparqlQuery): () => string {
  const { where, prepared, source } = scope;
  if (!where) throw new Error('A graph pattern is required');
  const labels: { name: string; start: number; end: number }[] = [];
  const occupied = new Set<string>();
  for (let index = 0; index + 1 < prepared.tokens.length; index++) {
    const marker = prepared.tokens[index];
    const local = prepared.tokens[index + 1];
    if (marker.kind !== 'symbol' || marker.logicalValue !== '_'
      || local.kind !== 'prefixed-name' || marker.end !== local.start
      || !local.logicalValue.startsWith(':')) continue;
    const name = local.logicalValue.slice(1);
    if (!isRdfBlankNodeLabel(name)) continue;
    occupied.add(name);
    if (marker.start >= where.openEnd && local.end <= where.close) {
      labels.push({ name, start: marker.start, end: local.end });
    }
  }
  const original = source.slice(where.openEnd, where.close);
  let first = true;
  let nextName = 0;
  return () => {
    if (first || labels.length === 0) {
      first = false;
      return original;
    }
    const replacements = new Map<string, string>();
    let result = '';
    let offset = where.openEnd;
    for (const label of labels) {
      let name = replacements.get(label.name);
      if (name === undefined) {
        do { name = `__dkgCopy${nextName++}`; } while (occupied.has(name));
        occupied.add(name);
        replacements.set(label.name, name);
      }
      result += source.slice(offset, label.start) + '_:' + name;
      offset = label.end;
    }
    return result + source.slice(offset, where.close);
  };
}
