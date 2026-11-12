import type { PreparedSparqlQuery } from '@origintrail-official/dkg-rdf-utils/sparql';
import { namedBlankNodes, type VariableAllocator } from './sparql-rewrite-names.js';

export interface DedupPatternSource {
  readonly pattern: string;
  /**
   * The private variables that stand for the pattern's blank nodes: each label, and each empty `[]`.
   * A blank node is a variable the caller cannot project, so it keys the graph choice beside the caller's
   * variables: a mirrored match is read once, and distinct blank matches keep their rows.
   */
  readonly blankVariables: readonly string[];
}

/** Render the replayed pattern from canonical coordinates, keeping hidden terms private. */
export function renderDedupPattern(
  scope: PreparedSparqlQuery,
  filters: readonly { readonly start: number; readonly end: number }[],
  allocate: VariableAllocator,
): DedupPatternSource {
  const where = scope.where!;
  const labels = new Map<string, string>();
  const blankVariables: string[] = [];
  const blankVariable = () => {
    const variable = allocate(`__dkgBlankNode${blankVariables.length}`);
    blankVariables.push(variable);
    return variable;
  };
  const inFilter = (start: number) => filters.some(range => start >= range.start && start < range.end);
  const edits = filters.map(range => ({ ...range, replacement: 'FILTER(true)' }));
  for (const label of namedBlankNodes(scope, where.openingTokenIndex + 1, where.closingTokenIndex)) {
    if (inFilter(label.start)) continue;
    let variable = labels.get(label.name);
    if (!variable) {
      variable = blankVariable();
      labels.set(label.name, variable);
    }
    // Named blank nodes cannot be copied across SPARQL basic graph patterns.
    // A private variable preserves each label's joins across graph choice and replay.
    edits.push({ start: label.start, end: label.end, replacement: variable });
  }
  const { tokens } = scope.prepared;
  for (let index = where.openingTokenIndex + 1; index < where.closingTokenIndex - 1; index++) {
    const opening = tokens[index];
    const closing = tokens[index + 1];
    // An empty `[]` is a fresh blank node; a `[ … ]` property list stays as written. No FILTER expression holds one.
    if (opening.kind !== 'symbol' || opening.logicalValue !== '[' || closing.kind !== 'symbol' || closing.logicalValue !== ']') continue;
    edits.push({ start: opening.start, end: closing.end, replacement: blankVariable() });
    index++;
  }
  let from = where.openEnd;
  let pattern = '';
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    pattern += scope.source.slice(from, edit.start) + edit.replacement;
    from = edit.end;
  }
  pattern += scope.source.slice(from, where.close);
  return { pattern, blankVariables };
}
