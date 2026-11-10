// SPDX-License-Identifier: Apache-2.0
import {
  isSparqlKeyword, readSparqlQueryBoundaries, type PreparedSparqlQuery, type SparqlLexicalToken,
} from '@origintrail-official/dkg-rdf-utils/sparql';
import { createVariableAllocator, type VariableAllocator } from './sparql-rewrite-names.js';
import {
  parseTriplesBlock, UnreadTriplesBlockError, type SparqlPath, type SparqlTriplePattern,
} from './sparql-triples-block.js';

/** A replacement of one source span. */
export interface SourceEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** A query whose patterns outside GRAPH this rewrite cannot keep apart from the hidden graphs. */
export class UnrewrittenPatternError extends Error {
  constructor(readonly what: string) {
    super(what);
    this.name = 'UnrewrittenPatternError';
  }
}

type Item =
  | { readonly kind: 'triple'; readonly subject: string; readonly verb: string; readonly object: string; readonly filter?: string }
  | { readonly kind: 'union'; readonly branches: readonly (readonly Item[])[] };

const BLOCK_END = new Set(['OPTIONAL', 'MINUS', 'GRAPH', 'SERVICE', 'FILTER', 'BIND', 'VALUES']);

/**
 * Edits that make every pattern outside GRAPH read only graphs that `excluded`
 * lets through, and keep the answer of the store without the excluded graphs:
 * - each triple pattern keeps matching the merged default graph and gets a
 *   `FILTER EXISTS` that the same triple is held by an allowed graph;
 * - a property path is expanded into those patterns (sequence, alternative,
 *   inverse and negated sets); a path with `*`, `+` or `?` is refused;
 * - a query of the store's fast counting form (`COUNT(*)` over one triple
 *   pattern, alone or grouped by one of its variables) keeps counting stored
 *   quads: its pattern reads the allowed graphs directly.
 * Patterns inside GRAPH are left alone.
 */
export function defaultGraphEdits(scope: PreparedSparqlQuery, excluded: (variable: string) => string): SourceEdit[] {
  return new DefaultGraphRewriter(scope, excluded).run();
}

class DefaultGraphRewriter {
  private readonly tokens: readonly SparqlLexicalToken[];
  private readonly edits: SourceEdit[] = [];
  private readonly fresh: VariableAllocator;
  private readonly labels = new Map<string, string>();
  private introducedVariables = false;

  constructor(private readonly scope: PreparedSparqlQuery, private readonly excluded: (variable: string) => string) {
    this.tokens = scope.prepared.tokens;
    this.fresh = createVariableAllocator(scope);
  }

  run(): SourceEdit[] {
    const where = this.scope.where;
    if (where) {
      const operation = this.scope.prepared.prologue.endTokenIndex;
      this.walkGroup(where.openingTokenIndex, where.closingTokenIndex,
        this.scope.operation === 'SELECT' && this.isFastCount(operation, this.tokens.length, where.openingTokenIndex, where.closingTokenIndex));
    }
    this.walkExistsOutside(0, this.tokens.length, where?.openingTokenIndex ?? -1, where?.closingTokenIndex ?? -1);
    if (this.introducedVariables && this.projectsEverything()) {
      throw new UnrewrittenPatternError('SELECT * with a blank node or a property path outside GRAPH');
    }
    return this.edits;
  }

  private keyword(index: number, word: string): boolean {
    return isSparqlKeyword(this.tokens, index, word);
  }

  private symbolAt(index: number, value: string): boolean {
    const token = this.tokens[index];
    return token?.kind === 'symbol' && token.logicalValue === value;
  }

  private braceMatch(index: number): number {
    const match = this.scope.structure.braces.matchingTokenIndexes[index] ?? -1;
    if (!this.symbolAt(index, '{') || match < 0) throw new UnrewrittenPatternError('a group without its closing brace');
    return match;
  }

  private parenthesisMatch(index: number): number {
    const match = this.scope.structure.parentheses.matchingTokenIndexes[index] ?? -1;
    if (!this.symbolAt(index, '(') || match < 0) throw new UnrewrittenPatternError('an expression without its closing parenthesis');
    return match;
  }

  /** The default-graph groups of EXISTS expressions between two token indexes, skipping one range. */
  private walkExistsOutside(from: number, to: number, skipFrom: number, skipTo: number): void {
    for (let index = from; index < to; index++) {
      if (index === skipFrom) { index = skipTo; continue; }
      if (this.keyword(index, 'EXISTS') && this.symbolAt(index + 1, '{')) {
        const closing = this.braceMatch(index + 1);
        this.walkGroup(index + 1, closing, false);
        index = closing;
      }
    }
  }

  private walkGroup(opening: number, closing: number, fastCount: boolean): void {
    if (this.keyword(opening + 1, 'SELECT')) {
      this.walkSubSelect(opening, closing);
      return;
    }
    const depth = this.scope.structure.braces.depthBefore[opening]! + 1;
    let index = opening + 1;
    while (index < closing) {
      if (this.symbolAt(index, '.') || this.keyword(index, 'UNION')) { index += 1; continue; }
      if (this.symbolAt(index, '{')) {
        const end = this.braceMatch(index);
        this.walkGroup(index, end, fastCount);
        index = end + 1;
        continue;
      }
      if (this.keyword(index, 'OPTIONAL') || this.keyword(index, 'MINUS')) {
        const end = this.braceMatch(index + 1);
        this.walkGroup(index + 1, end, false);
        index = end + 1;
        continue;
      }
      if (this.keyword(index, 'GRAPH')) {
        index = this.braceMatch(index + 2) + 1;
        continue;
      }
      if (this.keyword(index, 'FILTER')) { index = this.walkFilter(index); continue; }
      if (this.keyword(index, 'BIND')) {
        const end = this.parenthesisMatch(index + 1);
        this.walkExistsOutside(index + 1, end, -1, -1);
        index = end + 1;
        continue;
      }
      if (this.keyword(index, 'VALUES')) { index = this.skipValues(index); continue; }
      if (this.keyword(index, 'SERVICE')) throw new UnrewrittenPatternError('SERVICE');
      let end = index;
      while (end < closing && !(this.symbolAt(end, '{') && this.scope.structure.braces.depthBefore[end] === depth)
        && ![...BLOCK_END].some(word => this.keyword(end, word))) end += 1;
      this.rewriteBlock(index, end, fastCount);
      index = end;
    }
  }

  private walkSubSelect(opening: number, closing: number): void {
    const { where } = readSparqlQueryBoundaries(this.scope.prepared, this.scope.structure,
      { operationTokenIndex: opening + 1, endTokenIndex: closing });
    if (!where) throw new UnrewrittenPatternError('a sub-select without a WHERE group');
    this.walkGroup(where.openingTokenIndex, where.closingTokenIndex,
      this.isFastCount(opening + 1, closing, where.openingTokenIndex, where.closingTokenIndex));
    this.walkExistsOutside(opening + 1, closing, where.openingTokenIndex, where.closingTokenIndex);
  }

  private walkFilter(index: number): number {
    let at = index + 1;
    if (this.keyword(at, 'NOT')) at += 1;
    if (this.keyword(at, 'EXISTS')) {
      const end = this.braceMatch(at + 1);
      this.walkGroup(at + 1, end, false);
      return end + 1;
    }
    // FILTER(expression) or FILTER function(arguments).
    if (!this.symbolAt(at, '(')) at += 1;
    const end = this.parenthesisMatch(at);
    this.walkExistsOutside(at, end, -1, -1);
    return end + 1;
  }

  private skipValues(index: number): number {
    let at = index + 1;
    while (at < this.tokens.length && !this.symbolAt(at, '{')) at += 1;
    return this.braceMatch(at) + 1;
  }

  private rewriteBlock(from: number, to: number, fastCount: boolean): void {
    let triples: SparqlTriplePattern[];
    try {
      triples = parseTriplesBlock(this.scope, from, to, { fresh: name => { this.introducedVariables = true; return this.fresh(name); }, labels: this.labels });
    } catch (error) {
      if (error instanceof UnreadTriplesBlockError) throw new UnrewrittenPatternError(`A pattern outside GRAPH with ${error.what}`);
      throw error;
    }
    const items: Item[] = [];
    for (const triple of triples) {
      if (triple.verb.kind === 'variable') items.push({ kind: 'triple', subject: triple.subject, verb: triple.verb.text, object: triple.object });
      else this.expand(triple.verb, triple.subject, triple.object, items);
    }
    const simple = items.length === 1 && items[0]!.kind === 'triple' && !items[0]!.filter;
    const text = fastCount && simple ? this.renderFastCount(items[0] as Extract<Item, { kind: 'triple' }>) : this.render(items);
    this.edits.push({ start: this.tokens[from]!.start, end: this.tokens[to - 1]!.end, text });
  }

  private expand(path: SparqlPath, subject: string, object: string, out: Item[]): void {
    switch (path.kind) {
      case 'link':
        out.push({ kind: 'triple', subject, verb: path.iri, object });
        return;
      case 'inverse':
        this.expand(path.path, object, subject, out);
        return;
      case 'sequence': {
        let from = subject;
        path.steps.forEach((step, index) => {
          const to = index === path.steps.length - 1 ? object : this.introduce('_step');
          this.expand(step, from, to, out);
          from = to;
        });
        return;
      }
      case 'alternative':
        out.push({ kind: 'union', branches: path.options.map((option) => {
          const branch: Item[] = [];
          this.expand(option, subject, object, branch);
          return branch;
        }) });
        return;
      case 'negated': {
        const branches: Item[][] = [];
        if (path.forward.length > 0 || path.inverse.length === 0) branches.push([this.negatedLink(path.forward, subject, object)]);
        if (path.inverse.length > 0) branches.push([this.negatedLink(path.inverse, object, subject)]);
        out.push(branches.length === 1 ? branches[0]![0]! : { kind: 'union', branches });
        return;
      }
      case 'repeated':
        throw new UnrewrittenPatternError('A property path with *, + or ? outside GRAPH');
    }
  }

  private negatedLink(excludedPredicates: readonly string[], subject: string, object: string): Item {
    const verb = this.introduce('_verb');
    return { kind: 'triple', subject, verb, object, filter: `FILTER(${verb} NOT IN (${excludedPredicates.join(', ')}))` };
  }

  private introduce(name: string): string {
    this.introducedVariables = true;
    return this.fresh(name);
  }

  private render(items: readonly Item[]): string {
    return items.map((item) => {
      if (item.kind === 'union') return item.branches.map(branch => `{ ${this.render(branch)} }`).join(' UNION ');
      const holder = this.fresh('_holder');
      return `${item.subject} ${item.verb} ${item.object} .${item.filter ? ` ${item.filter}` : ''}`
        + ` FILTER EXISTS { GRAPH ${holder} { ${item.subject} ${item.verb} ${item.object} } ${this.excluded(holder)} }`;
    }).join(' ');
  }

  private renderFastCount(item: Extract<Item, { kind: 'triple' }>): string {
    const holder = this.fresh('_holder');
    return `GRAPH ${holder} { ${item.subject} ${item.verb} ${item.object} } ${this.excluded(holder)}`;
  }

  /**
   * The store's fast counting form: SELECT [DISTINCT] (COUNT(*) AS ?n) over one
   * triple pattern with no GROUP BY or HAVING, or SELECT ?k (COUNT(*|?v) AS ?n)
   * over one triple pattern GROUP BY ?k. The pattern check happens when the
   * block is rewritten: one plain triple, alone in its group.
   */
  private isFastCount(selectIndex: number, end: number, whereOpening: number, whereClosing: number): boolean {
    const projection = this.tokens.slice(selectIndex + 1, whereOpening).filter(token => !(token.kind === 'word' && token.upper === 'WHERE'));
    const words = projection.map(token => token.kind === 'symbol' ? token.logicalValue : token.kind === 'word' ? token.upper : token.kind);
    const tail = this.tokens.slice(whereClosing + 1, end).map(token => (token.kind === 'word' ? token.upper : token.kind === 'symbol' ? token.logicalValue : token.kind));
    if (tail.includes('HAVING')) return false;
    const groupBy = tail.indexOf('GROUP');
    const plain = words.join(' ').replace(/^(DISTINCT|REDUCED) /, '');
    if (plain === '( COUNT ( * ) AS variable )') return groupBy < 0 && this.singleTriple(whereOpening, whereClosing);
    const grouped = /^variable \( COUNT \( (\*|variable) \) AS variable \)$/.test(plain);
    if (!grouped || groupBy < 0 || tail[groupBy + 1] !== 'BY' || tail[groupBy + 2] !== 'variable') return false;
    if (tail.slice(groupBy + 3).some(word => !['ORDER', 'BY', 'LIMIT', 'OFFSET', 'number', 'variable', 'ASC', 'DESC', '(', ')'].includes(word))) return false;
    const key = this.tokens[whereClosing + 1 + groupBy + 2]!;
    const first = words[0] === 'DISTINCT' || words[0] === 'REDUCED' ? 1 : 0;
    const counted = projection[first + 4]!;
    return projection[first]!.raw === key.raw && this.singleTriple(whereOpening, whereClosing, [key.raw,
      ...(counted.kind === 'variable' ? [counted.raw] : [])]);
  }

  /** One plain triple pattern, possibly inside nested braces, and nothing else; it binds every variable named. */
  private singleTriple(opening: number, closing: number, variables: readonly string[] = []): boolean {
    let from = opening + 1;
    let to = closing;
    while (this.symbolAt(from, '{') && this.scope.structure.braces.matchingTokenIndexes[from] === to - 1) { from += 1; to -= 1; }
    const body = this.tokens.slice(from, to).filter((token, index, all) => !(index === all.length - 1 && token.kind === 'symbol' && token.logicalValue === '.'));
    return body.length === 3 && body.every(token => token.kind === 'variable' || token.kind === 'iri' || token.kind === 'prefixed-name'
      || token.kind === 'number' || token.kind === 'string' || (token.kind === 'word' && token.logicalValue === 'a'))
      && variables.every(variable => body.some(token => token.kind === 'variable' && token.raw === variable));
  }

  private projectsEverything(): boolean {
    return this.tokens.some((token, index) => token.kind === 'symbol' && token.logicalValue === '*'
      && (this.keyword(index - 1, 'SELECT') || ((this.keyword(index - 1, 'DISTINCT') || this.keyword(index - 1, 'REDUCED')) && this.keyword(index - 2, 'SELECT'))));
  }
}
