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
      this.walkPattern(this.scope.operation === 'SELECT', operation, this.tokens.length, where.openingTokenIndex, where.closingTokenIndex);
    }
    this.walkExistsOutside(0, this.tokens.length, where?.openingTokenIndex ?? -1, where?.closingTokenIndex ?? -1);
    if (this.introducedVariables && (this.projectsEverything() || this.countsDistinctSolutions())) {
      throw new UnrewrittenPatternError('SELECT * or COUNT(DISTINCT *) with a blank node or a property path outside GRAPH');
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
        this.walkGroup(index + 1, closing);
        index = closing;
      }
    }
  }

  /** The WHERE group of a query or sub-select: its fast counting form, or its patterns one by one. */
  private walkPattern(select: boolean, selectIndex: number, end: number, opening: number, closing: number): void {
    const triple = select ? this.fastCountTriple(selectIndex, end, opening, closing) : undefined;
    if (!triple) {
      this.walkGroup(opening, closing);
      return;
    }
    const holder = this.fresh('_holder');
    const text = this.scope.source.slice(this.tokens[triple.from]!.start, this.tokens[triple.to - 1]!.end);
    this.edits.push({ start: this.tokens[triple.from]!.start, end: this.tokens[triple.to - 1]!.end,
      text: `GRAPH ${holder} { ${text} } ${this.excluded(holder)}` });
  }

  private walkGroup(opening: number, closing: number): void {
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
        this.walkGroup(index, end);
        index = end + 1;
        continue;
      }
      if (this.keyword(index, 'OPTIONAL') || this.keyword(index, 'MINUS')) {
        const end = this.braceMatch(index + 1);
        this.walkGroup(index + 1, end);
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
      this.rewriteBlock(index, end);
      index = end;
    }
  }

  private walkSubSelect(opening: number, closing: number): void {
    const { where } = readSparqlQueryBoundaries(this.scope.prepared, this.scope.structure,
      { operationTokenIndex: opening + 1, endTokenIndex: closing });
    if (!where) throw new UnrewrittenPatternError('a sub-select without a WHERE group');
    this.walkPattern(true, opening + 1, closing, where.openingTokenIndex, where.closingTokenIndex);
    this.walkExistsOutside(opening + 1, closing, where.openingTokenIndex, where.closingTokenIndex);
  }

  private walkFilter(index: number): number {
    let at = index + 1;
    if (this.keyword(at, 'NOT')) at += 1;
    if (this.keyword(at, 'EXISTS')) {
      const end = this.braceMatch(at + 1);
      this.walkGroup(at + 1, end);
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

  private rewriteBlock(from: number, to: number): void {
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
    this.edits.push({ start: this.tokens[from]!.start, end: this.tokens[to - 1]!.end, text: this.render(items) });
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

  /**
   * The one triple pattern of the store's fast counting form, by token range:
   * `SELECT [DISTINCT] (COUNT(*) AS ?n)` over one triple pattern with no GROUP BY,
   * or `?k` with `(COUNT(*) AS ?n)` or `(COUNT(?v) AS ?n)`, in either order, over
   * one triple pattern `GROUP BY ?k`, where `?k` and `?v` are its variables. ORDER
   * BY, LIMIT and OFFSET may follow; HAVING or anything else rules the form out.
   */
  private fastCountTriple(selectIndex: number, end: number, opening: number, closing: number): { from: number; to: number } | undefined {
    let from = opening + 1;
    let to = closing;
    while (this.symbolAt(from, '{') && this.scope.structure.braces.matchingTokenIndexes[from] === to - 1) { from += 1; to -= 1; }
    if (this.symbolAt(to - 1, '.')) to -= 1;
    const terms = this.tokens.slice(from, to);
    if (terms.length !== 3 || !terms.every(token => token.kind === 'variable' || token.kind === 'iri' || token.kind === 'prefixed-name'
      || token.kind === 'number' || token.kind === 'string' || (token.kind === 'word' && token.logicalValue === 'a'))) return undefined;
    const variables = new Set(terms.filter(token => token.kind === 'variable').map(token => token.logicalValue.slice(1)));
    const items = this.projectionItems(selectIndex, opening);
    const counts = items?.filter(item => item.kind === 'count') ?? [];
    const keys = items?.filter(item => item.kind === 'variable') ?? [];
    const groupKey = this.groupKey(closing + 1, end);
    if (!items || counts.length !== 1 || groupKey === null) return undefined;
    const counted = (counts[0] as { counted: string }).counted;
    if (keys.length === 0 && groupKey === undefined && counted === '*') return { from, to };
    const key = (keys[0] as { name: string } | undefined)?.name;
    return keys.length === 1 && key !== undefined && key === groupKey && variables.has(key) && (counted === '*' || variables.has(counted))
      ? { from, to } : undefined;
  }

  /** Projected variables and `(COUNT(*|?v) AS ?n)` items; undefined for any other projection. */
  private projectionItems(selectIndex: number, whereOpening: number): Array<{ kind: 'variable'; name: string } | { kind: 'count'; counted: string }> | undefined {
    const items: Array<{ kind: 'variable'; name: string } | { kind: 'count'; counted: string }> = [];
    let index = selectIndex + 1;
    if (this.keyword(index, 'DISTINCT') || this.keyword(index, 'REDUCED')) index += 1;
    while (index < whereOpening && !this.keyword(index, 'WHERE')) {
      const token = this.tokens[index]!;
      if (token.kind === 'variable') {
        items.push({ kind: 'variable', name: token.logicalValue.slice(1) });
        index += 1;
        continue;
      }
      const argument = this.tokens[index + 3];
      if (!this.symbolAt(index, '(') || !this.keyword(index + 1, 'COUNT') || !this.symbolAt(index + 2, '(')
        || !(this.symbolAt(index + 3, '*') || argument?.kind === 'variable') || !this.symbolAt(index + 4, ')')
        || !this.keyword(index + 5, 'AS') || this.tokens[index + 6]?.kind !== 'variable' || !this.symbolAt(index + 7, ')')) return undefined;
      items.push({ kind: 'count', counted: argument?.kind === 'variable' ? argument.logicalValue.slice(1) : '*' });
      index += 8;
    }
    return items;
  }

  /**
   * After a WHERE group: the variable of a `GROUP BY ?k`, undefined without GROUP BY,
   * or null when anything but ORDER BY, LIMIT and OFFSET follows.
   */
  private groupKey(from: number, end: number): string | undefined | null {
    let key: string | undefined;
    let index = from;
    const keyToken = this.tokens[index + 2];
    if (this.keyword(index, 'GROUP') && this.keyword(index + 1, 'BY') && keyToken?.kind === 'variable') {
      key = keyToken.logicalValue.slice(1);
      index += 3;
    }
    if (this.keyword(index, 'ORDER') && this.keyword(index + 1, 'BY')) {
      index += 2;
      while (index < end && !this.keyword(index, 'LIMIT') && !this.keyword(index, 'OFFSET')) {
        if (this.keyword(index, 'HAVING') || this.keyword(index, 'VALUES') || this.keyword(index, 'GROUP')) return null;
        index += 1;
      }
    }
    while (index < end) {
      if ((this.keyword(index, 'LIMIT') || this.keyword(index, 'OFFSET')) && this.tokens[index + 1]?.kind === 'number') index += 2;
      else return null;
    }
    return key;
  }

  /** `COUNT(DISTINCT *)` tells solutions apart by every variable, the introduced ones included. */
  private countsDistinctSolutions(): boolean {
    return this.tokens.some((_token, index) => this.keyword(index, 'COUNT') && this.symbolAt(index + 1, '(')
      && this.keyword(index + 2, 'DISTINCT') && this.symbolAt(index + 3, '*'));
  }

  private projectsEverything(): boolean {
    return this.tokens.some((token, index) => token.kind === 'symbol' && token.logicalValue === '*'
      && (this.keyword(index - 1, 'SELECT') || ((this.keyword(index - 1, 'DISTINCT') || this.keyword(index - 1, 'REDUCED')) && this.keyword(index - 2, 'SELECT'))));
  }
}
