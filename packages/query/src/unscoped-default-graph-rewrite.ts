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

/** A predicate that is one IRI, inverted any number of times: one statement pattern. */
const isLink = (path: SparqlPath): boolean => path.kind === 'link' || (path.kind === 'inverse' && isLink(path.path));
const isStatementPattern = (triple: SparqlTriplePattern): boolean => triple.verb.kind === 'variable' || isLink(triple.verb);

/** What the walk of one query's WHERE group met outside GRAPH, MINUS, EXISTS and sub-selects. */
interface CountSurvey {
  triples: number;
  simple: boolean;
  /** MINUS, VALUES, a BIND of a constant, UNION, an empty group or a sub-select. */
  besideDropped: boolean;
}

/**
 * Edits that make every pattern outside GRAPH read only graphs that `excluded`
 * lets through, and keep the answer of the store without the excluded graphs:
 * - each triple pattern keeps matching the merged default graph and gets a
 *   `FILTER EXISTS` that the same triple is held by an allowed graph;
 * - a property path is expanded into those patterns (sequence, alternative,
 *   inverse and negated sets); a path with `*`, `+` or `?` is refused;
 * - a query of the store's fast counting form (`COUNT(*)` over one triple
 *   pattern, alone or grouped by one of its variables) keeps counting stored
 *   quads: its pattern reads the allowed graphs directly. Such a count over one
 *   pattern beside MINUS, VALUES, a BIND of a constant, UNION, an empty group or
 *   a sub-select is refused;
 * - a pattern whose predicate variable is also its subject or object is refused.
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
  private survey: CountSurvey = { triples: 0, simple: true, besideDropped: false };
  /** The decoded name of each variable spelling in the query, such as `?\u0073` for `s`. */
  private readonly variableNames: Map<string, string>;
  /** Depth of MINUS and EXISTS groups, whose contents the survey leaves out. */
  private contained = 0;

  constructor(private readonly scope: PreparedSparqlQuery, private readonly excluded: (variable: string) => string) {
    this.tokens = scope.prepared.tokens;
    this.fresh = createVariableAllocator(scope);
    this.variableNames = new Map(this.tokens.flatMap(token => (token.kind === 'variable' ? [[token.raw, token.logicalValue.slice(1)] as const] : [])));
  }

  /** The decoded name of a term that is a variable, as the parser spells it. */
  private variableName(term: string): string | undefined {
    return this.variableNames.get(term) ?? (/^[?$]/.test(term) ? term.slice(1) : undefined);
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
        this.walkContained(index + 1, closing);
        index = closing;
      }
    }
  }

  private walkContained(opening: number, closing: number): void {
    this.contained += 1;
    this.walkGroup(opening, closing);
    this.contained -= 1;
  }

  private noteBesideDropped(): void {
    if (this.contained === 0) this.survey.besideDropped = true;
  }

  /** The WHERE group of a query or sub-select: its fast counting form, or its patterns one by one. */
  private walkPattern(select: boolean, selectIndex: number, end: number, opening: number, closing: number): void {
    const count = select ? this.countForm(selectIndex, end, opening, closing) : undefined;
    const triple = count ? this.bareTriple(opening, closing, count) : undefined;
    if (triple) {
      const holder = this.fresh('_holder');
      const text = this.scope.source.slice(this.tokens[triple.from]!.start, this.tokens[triple.to - 1]!.end);
      this.edits.push({ start: this.tokens[triple.from]!.start, end: this.tokens[triple.to - 1]!.end,
        text: `GRAPH ${holder} { ${text} } ${this.excluded(holder)}` });
      return;
    }
    const [outer, contained] = [this.survey, this.contained];
    const survey: CountSurvey = { triples: 0, simple: true, besideDropped: false };
    [this.survey, this.contained] = [survey, 0];
    this.walkGroup(opening, closing);
    [this.survey, this.contained] = [outer, contained];
    // Which count the store gives for one pattern beside such elements is not pinned here.
    if (count && survey.triples === 1 && survey.simple && survey.besideDropped) {
      throw new UnrewrittenPatternError('A COUNT over one pattern outside GRAPH beside MINUS, VALUES, BIND, UNION, an empty group or a sub-select');
    }
  }

  private walkGroup(opening: number, closing: number): void {
    if (this.keyword(opening + 1, 'SELECT')) {
      this.noteBesideDropped();
      this.walkSubSelect(opening, closing);
      return;
    }
    if (closing === opening + 1) this.noteBesideDropped();
    const depth = this.scope.structure.braces.depthBefore[opening]! + 1;
    let index = opening + 1;
    while (index < closing) {
      if (this.symbolAt(index, '.')) { index += 1; continue; }
      if (this.keyword(index, 'UNION')) { this.noteBesideDropped(); index += 1; continue; }
      if (this.symbolAt(index, '{')) {
        const end = this.braceMatch(index);
        this.walkGroup(index, end);
        index = end + 1;
        continue;
      }
      if (this.keyword(index, 'OPTIONAL')) {
        const end = this.braceMatch(index + 1);
        this.walkGroup(index + 1, end);
        index = end + 1;
        continue;
      }
      if (this.keyword(index, 'MINUS')) {
        this.noteBesideDropped();
        const end = this.braceMatch(index + 1);
        this.walkContained(index + 1, end);
        index = end + 1;
        continue;
      }
      if (this.keyword(index, 'GRAPH')) {
        const end = this.braceMatch(index + 2);
        if (end === index + 3) this.noteBesideDropped();
        index = end + 1;
        continue;
      }
      if (this.keyword(index, 'FILTER')) { index = this.walkFilter(index); continue; }
      if (this.keyword(index, 'BIND')) {
        const end = this.parenthesisMatch(index + 1);
        if (!this.tokens.slice(index + 2, end - 2).some(token => token.kind === 'variable')) this.noteBesideDropped();
        this.walkExistsOutside(index + 1, end, -1, -1);
        index = end + 1;
        continue;
      }
      if (this.keyword(index, 'VALUES')) { this.noteBesideDropped(); index = this.skipValues(index); continue; }
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
      this.walkContained(at + 1, end);
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
    if (this.contained === 0) {
      this.survey.triples += triples.length;
      if (!triples.every(isStatementPattern)) this.survey.simple = false;
    }
    const items: Item[] = [];
    for (const triple of triples) {
      this.refuseRepeatedVerb(triple);
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
   * The projection of the store's fast counting form: `SELECT [DISTINCT] (COUNT(*) AS ?n)`
   * with no GROUP BY, or `?k` with `(COUNT(*) AS ?n)` or `(COUNT(?v) AS ?n)`, in
   * either order, `GROUP BY ?k` or `GROUP BY (?k)`. ORDER BY, LIMIT, OFFSET and a
   * final VALUES may follow; HAVING or anything else rules the form out.
   */
  private countForm(
    selectIndex: number, end: number, opening: number, closing: number,
  ): { readonly key?: string; readonly counted: string } | undefined {
    const items = this.projectionItems(selectIndex, opening);
    const counts = items?.filter(item => item.kind === 'count') ?? [];
    const keys = items?.filter(item => item.kind === 'variable') ?? [];
    const groupKey = this.groupKey(closing + 1, end);
    if (!items || counts.length !== 1 || groupKey === null) return undefined;
    const counted = (counts[0] as { counted: string }).counted;
    if (keys.length === 0 && groupKey === undefined) return counted === '*' ? { counted } : undefined;
    const key = (keys[0] as { name: string } | undefined)?.name;
    return keys.length === 1 && key !== undefined && key === groupKey ? { key, counted } : undefined;
  }

  /**
   * The token range of a WHERE group that is one triple pattern of the counting
   * form, nested braces aside: any term, and a predicate that is a variable or one
   * IRI, inverted or in parentheses. A grouped count needs `?k` and `?v` in it.
   */
  private bareTriple(opening: number, closing: number, count: { readonly key?: string; readonly counted: string }): { from: number; to: number } | undefined {
    let from = opening + 1;
    let to = closing;
    while (this.symbolAt(from, '{') && this.scope.structure.braces.matchingTokenIndexes[from] === to - 1) { from += 1; to -= 1; }
    for (let index = from; index < to; index++) {
      if (this.symbolAt(index, '{') || this.keyword(index, 'UNION') || this.keyword(index, 'SELECT')
        || [...BLOCK_END].some(word => this.keyword(index, word))) return undefined;
    }
    let triples: SparqlTriplePattern[];
    let blank = 0;
    try {
      // Throwaway names: '-' cannot occur in a query variable.
      triples = from < to ? parseTriplesBlock(this.scope, from, to, { fresh: () => `?-${blank++}`, labels: new Map() }) : [];
    } catch (error) {
      if (error instanceof UnreadTriplesBlockError) return undefined;
      throw error;
    }
    const triple = triples.length === 1 ? triples[0]! : undefined;
    if (!triple || !isStatementPattern(triple)) return undefined;
    this.refuseRepeatedVerb(triple);
    const terms = [triple.subject, triple.object, ...(triple.verb.kind === 'variable' ? [triple.verb.text] : [])];
    const variables = new Set(terms.map(term => this.variableName(term)).filter(name => name !== undefined));
    if (count.key !== undefined && !(variables.has(count.key) && (count.counted === '*' || variables.has(count.counted)))) return undefined;
    return { from, to };
  }

  /** A pattern whose predicate variable is also its subject or object is refused. */
  private refuseRepeatedVerb(triple: SparqlTriplePattern): void {
    const verb = triple.verb.kind === 'variable' ? this.variableName(triple.verb.text) : undefined;
    if (verb !== undefined && [triple.subject, triple.object].some(term => this.variableName(term) === verb)) {
      throw new UnrewrittenPatternError('A pattern outside GRAPH whose predicate variable is also its subject or object');
    }
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
   * After a WHERE group: the variable of a `GROUP BY ?k` or `GROUP BY (?k)`, undefined
   * without GROUP BY, or null when anything but ORDER BY, LIMIT, OFFSET and a final
   * VALUES follows.
   */
  private groupKey(from: number, end: number): string | undefined | null {
    let key: string | undefined;
    let index = from;
    if (this.keyword(index, 'GROUP') && this.keyword(index + 1, 'BY')) {
      const wrapped = this.symbolAt(index + 2, '(') && this.symbolAt(index + 4, ')');
      const keyToken = this.tokens[index + (wrapped ? 3 : 2)];
      if (keyToken?.kind !== 'variable') return null;
      key = keyToken.logicalValue.slice(1);
      index += wrapped ? 5 : 3;
    }
    if (this.keyword(index, 'ORDER') && this.keyword(index + 1, 'BY')) {
      index += 2;
      while (index < end && !this.keyword(index, 'LIMIT') && !this.keyword(index, 'OFFSET') && !this.keyword(index, 'VALUES')) {
        if (this.keyword(index, 'HAVING') || this.keyword(index, 'GROUP')) return null;
        index += 1;
      }
    }
    while (index < end) {
      if ((this.keyword(index, 'LIMIT') || this.keyword(index, 'OFFSET')) && this.tokens[index + 1]?.kind === 'number') index += 2;
      else return this.keyword(index, 'VALUES') ? key : null;
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
