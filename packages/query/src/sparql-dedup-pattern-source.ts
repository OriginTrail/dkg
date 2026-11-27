import type { PreparedSparqlQuery, SparqlLexicalToken } from '@origintrail-official/dkg-rdf-utils/sparql';
import { namedBlankNodes, type VariableAllocator } from './sparql-rewrite-names.js';

export interface DedupPatternSource {
  readonly pattern: string;
  /**
   * The private variables that stand for the pattern's blank nodes: each label, and with `anonymous` each
   * empty `[]` and each `[ … ]` property list too.
   */
  readonly blankVariables: readonly string[];
}

const isSymbol = (token: SparqlLexicalToken | undefined, value: string) => token?.kind === 'symbol' && token.logicalValue === value;

/**
 * Render the replayed pattern from canonical coordinates, keeping hidden terms private. With `anonymous`,
 * every blank node gets a private variable, so the blank nodes can choose the graph; without it, only
 * labels do, and anonymous blank nodes stay as written.
 */
export function renderDedupPattern(
  scope: PreparedSparqlQuery,
  filters: readonly { readonly start: number; readonly end: number }[],
  allocate: VariableAllocator,
  anonymous = false,
): DedupPatternSource {
  const where = scope.where!;
  const { tokens } = scope.prepared;
  const closing = scope.structure.brackets.matchingTokenIndexes;
  const blankVariables: string[] = [];
  const blankVariable = () => {
    const variable = allocate(`__dkgBlankNode${blankVariables.length}`);
    blankVariables.push(variable);
    return variable;
  };
  const labels = new Map<string, string>();
  const named = new Map(namedBlankNodes(scope, where.openingTokenIndex + 1, where.closingTokenIndex).map(label => [label.start, label]));
  const moved = new Map(filters.map(range => [range.start, range]));
  const movedEnds = new Set(filters.map(range => range.end));
  // The triples of property lists that stand as objects, written after the pattern's own: a basic graph
  // pattern joins its triples in any order.
  const appended: string[] = [];

  /** Tokens [first, last) and the source between them, from offset `from` to `to`. */
  const render = (first: number, last: number, from: number, to: number): string => {
    let text = '';
    let cursor = from;
    for (let index = first; index < last; index++) {
      const token = tokens[index];
      const filter = moved.get(token.start);
      if (filter) {
        text += `${scope.source.slice(cursor, filter.start)}FILTER(true)`;
        cursor = filter.end;
        while (index + 1 < last && tokens[index + 1].start < filter.end) index++;
        continue;
      }
      const label = named.get(token.start);
      if (label) {
        // Named blank nodes cannot be copied across SPARQL basic graph patterns. A private variable preserves
        // each label's joins; unless the blank nodes choose the graph, the candidate does not project it.
        let variable = labels.get(label.name);
        if (!variable) {
          variable = blankVariable();
          labels.set(label.name, variable);
        }
        text += scope.source.slice(cursor, label.start) + variable;
        cursor = label.end;
        index++;
        continue;
      }
      if (!anonymous || !isSymbol(token, '[')) continue;
      const end = closing[index]!;
      const variable = blankVariable();
      text += scope.source.slice(cursor, token.start);
      cursor = tokens[end].end;
      if (end === index + 1) {
        text += variable;
        index = end;
        continue;
      }
      const inner = render(index + 1, end, token.end, tokens[end].start);
      const previous = tokens[index - 1];
      const subject = index - 1 === where.openingTokenIndex || isSymbol(previous, '.') || isSymbol(previous, '}')
        || movedEnds.has(previous.end);
      if (subject) {
        // `[ p o ] q r` is `?b p o ; q r`, and `[ p o ]` alone is `?b p o`.
        const next = tokens[end + 1];
        const alone = end + 1 >= last || isSymbol(next, '.') || (next.kind === 'word' && next.upper === 'FILTER');
        text += alone ? `${variable} ${inner}` : `${variable} ${inner} ;`;
      } else {
        text += variable;
        appended.push(`${variable} ${inner} .`);
      }
      index = end;
    }
    return text + scope.source.slice(cursor, to);
  };

  let pattern = render(where.openingTokenIndex + 1, where.closingTokenIndex, where.openEnd, where.close);
  if (appended.length) {
    pattern += `${isSymbol(tokens[where.closingTokenIndex - 1], '.') ? ' ' : ' . '}${appended.join(' ')}`;
  }
  return { pattern, blankVariables };
}
