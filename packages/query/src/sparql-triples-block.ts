// SPDX-License-Identifier: Apache-2.0
import type { PreparedSparqlQuery, SparqlLexicalToken } from '@origintrail-official/dkg-rdf-utils/sparql';

const RDF_TYPE = '<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>';

/** A property path as written in a triple pattern, before it is expanded. */
export type SparqlPath =
  | { readonly kind: 'link'; readonly iri: string }
  | { readonly kind: 'inverse'; readonly path: SparqlPath }
  | { readonly kind: 'sequence'; readonly steps: readonly SparqlPath[] }
  | { readonly kind: 'alternative'; readonly options: readonly SparqlPath[] }
  | { readonly kind: 'negated'; readonly forward: readonly string[]; readonly inverse: readonly string[] }
  | { readonly kind: 'repeated'; readonly path: SparqlPath; readonly modifier: string };

/** One triple pattern of a triples block. Terms are source text; blank nodes are fresh variables. */
export interface SparqlTriplePattern {
  readonly subject: string;
  readonly verb: { readonly kind: 'variable'; readonly text: string } | SparqlPath;
  readonly object: string;
}

/** Thrown for a triples block that this parser does not read, such as one with an RDF collection. */
export class UnreadTriplesBlockError extends Error {
  constructor(readonly what: string) {
    super(`unread triples block: ${what}`);
    this.name = 'UnreadTriplesBlockError';
  }
}

export interface TriplesBlockNames {
  /** A fresh variable, `?name`, that the query does not use. */
  readonly fresh: (preferred: string) => string;
  /** The variable that stands for each blank-node label of the group. */
  readonly labels: Map<string, string>;
}

/**
 * Read the triples block between two token indexes (`to` excluded): triple
 * patterns with property and object lists, blank-node property lists, and
 * property paths. Blank nodes become fresh variables, one per label.
 */
export function parseTriplesBlock(
  scope: PreparedSparqlQuery, from: number, to: number, names: TriplesBlockNames,
): SparqlTriplePattern[] {
  return new TriplesBlockParser(scope, from, to, names).block();
}

class TriplesBlockParser {
  private index: number;
  private readonly tokens: readonly SparqlLexicalToken[];
  private readonly triples: SparqlTriplePattern[] = [];

  constructor(
    private readonly scope: PreparedSparqlQuery,
    from: number,
    private readonly end: number,
    private readonly names: TriplesBlockNames,
  ) {
    this.index = from;
    this.tokens = scope.prepared.tokens;
  }

  block(): SparqlTriplePattern[] {
    while (this.index < this.end) {
      this.triplesSameSubject();
      if (this.index >= this.end) break;
      if (!this.symbol('.')) throw new UnreadTriplesBlockError('a triple pattern without a following "."');
      this.index += 1;
    }
    return this.triples;
  }

  private peek(offset = 0): SparqlLexicalToken | undefined {
    const at = this.index + offset;
    return at < this.end ? this.tokens[at] : undefined;
  }

  private symbol(value: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token?.kind === 'symbol' && token.logicalValue === value;
  }

  private text(from: number, last: number): string {
    return this.scope.source.slice(this.tokens[from]!.start, this.tokens[last]!.end);
  }

  private triplesSameSubject(): void {
    if (this.symbol('[') && !this.symbol(']', 1)) {
      const subject = this.blankNodePropertyList();
      if (this.startsVerb()) this.propertyList(subject);
      return;
    }
    this.propertyList(this.term());
  }

  private startsVerb(): boolean {
    return this.peek() !== undefined && !this.symbol('.') && !this.symbol(']');
  }

  private propertyList(subject: string): void {
    for (;;) {
      const verb = this.verb();
      for (;;) {
        this.triples.push({ subject, verb, object: this.graphNode() });
        if (!this.symbol(',')) break;
        this.index += 1;
      }
      if (!this.symbol(';')) return;
      while (this.symbol(';')) this.index += 1;
      if (!this.startsVerb()) return;
    }
  }

  private verb(): SparqlTriplePattern['verb'] {
    const token = this.peek();
    if (token?.kind === 'variable') {
      this.index += 1;
      return { kind: 'variable', text: token.raw };
    }
    return this.alternative();
  }

  private graphNode(): string {
    if (this.symbol('[') && !this.symbol(']', 1)) return this.blankNodePropertyList();
    return this.term();
  }

  private blankNodePropertyList(): string {
    this.index += 1;
    const node = this.names.fresh('_blank');
    this.propertyList(node);
    if (!this.symbol(']')) throw new UnreadTriplesBlockError('an unclosed blank-node property list');
    this.index += 1;
    return node;
  }

  private term(): string {
    const token = this.peek();
    const start = this.index;
    if (!token) throw new UnreadTriplesBlockError('a missing term');
    if (token.kind === 'variable' || token.kind === 'iri' || token.kind === 'prefixed-name' || token.kind === 'number') {
      this.index += 1;
      return this.text(start, start);
    }
    if (token.kind === 'word' && (token.upper === 'TRUE' || token.upper === 'FALSE')) {
      this.index += 1;
      return this.text(start, start);
    }
    if (token.kind === 'string') {
      this.index += 1;
      if (this.symbol('@') && this.peek(1)?.kind === 'word') {
        this.index += 2;
        // A tag with subtags, `en-US`: adjacent `-` and parts.
        while (this.symbol('-') && this.peek()!.start === this.tokens[this.index - 1]!.end
          && (this.peek(1)?.kind === 'word' || this.peek(1)?.kind === 'number')) this.index += 2;
      } else if (this.symbol('^') && this.symbol('^', 1)
        && (this.peek(2)?.kind === 'iri' || this.peek(2)?.kind === 'prefixed-name')) {
        this.index += 3;
      }
      return this.text(start, this.index - 1);
    }
    if (this.symbol('[') && this.symbol(']', 1)) {
      this.index += 2;
      return this.names.fresh('_blank');
    }
    const label = this.peek(1);
    if (this.symbol('_') && label?.kind === 'prefixed-name' && label.logicalValue.startsWith(':')
      && label.start === token.end) {
      this.index += 2;
      const name = label.logicalValue.slice(1);
      let variable = this.names.labels.get(name);
      if (!variable) {
        variable = this.names.fresh('_blank');
        this.names.labels.set(name, variable);
      }
      return variable;
    }
    if (this.symbol('(')) throw new UnreadTriplesBlockError('an RDF collection');
    throw new UnreadTriplesBlockError(`an unexpected ${token.kind} "${token.raw}"`);
  }

  private alternative(): SparqlPath {
    const options = [this.sequence()];
    while (this.symbol('|')) {
      this.index += 1;
      options.push(this.sequence());
    }
    return options.length === 1 ? options[0]! : { kind: 'alternative', options };
  }

  private sequence(): SparqlPath {
    const steps = [this.eltOrInverse()];
    while (this.symbol('/')) {
      this.index += 1;
      steps.push(this.eltOrInverse());
    }
    return steps.length === 1 ? steps[0]! : { kind: 'sequence', steps };
  }

  private eltOrInverse(): SparqlPath {
    if (!this.symbol('^')) return this.elt();
    this.index += 1;
    return { kind: 'inverse', path: this.elt() };
  }

  private elt(): SparqlPath {
    const primary = this.primary();
    const modifier = this.peek();
    if (modifier?.kind === 'symbol' && ['*', '+', '?'].includes(modifier.logicalValue)) {
      this.index += 1;
      return { kind: 'repeated', path: primary, modifier: modifier.logicalValue };
    }
    return primary;
  }

  private primary(): SparqlPath {
    const token = this.peek();
    if (token?.kind === 'iri' || token?.kind === 'prefixed-name') {
      this.index += 1;
      return { kind: 'link', iri: token.raw };
    }
    if (token?.kind === 'word' && token.logicalValue === 'a') {
      this.index += 1;
      return { kind: 'link', iri: RDF_TYPE };
    }
    if (this.symbol('!')) {
      this.index += 1;
      return this.negated();
    }
    if (this.symbol('(')) {
      this.index += 1;
      const path = this.alternative();
      if (!this.symbol(')')) throw new UnreadTriplesBlockError('an unclosed path group');
      this.index += 1;
      return path;
    }
    throw new UnreadTriplesBlockError(`an unexpected ${token?.kind ?? 'end'} where a path was expected`);
  }

  private negated(): SparqlPath {
    const forward: string[] = [];
    const inverse: string[] = [];
    const one = () => {
      const inverted = this.symbol('^');
      if (inverted) this.index += 1;
      const token = this.peek();
      let iri: string;
      if (token?.kind === 'iri' || token?.kind === 'prefixed-name') iri = token.raw;
      else if (token?.kind === 'word' && token.logicalValue === 'a') iri = RDF_TYPE;
      else throw new UnreadTriplesBlockError('an unexpected member of a negated property set');
      this.index += 1;
      (inverted ? inverse : forward).push(iri);
    };
    if (this.symbol('(')) {
      this.index += 1;
      if (!this.symbol(')')) {
        one();
        while (this.symbol('|')) {
          this.index += 1;
          one();
        }
      }
      if (!this.symbol(')')) throw new UnreadTriplesBlockError('an unclosed negated property set');
      this.index += 1;
    } else {
      one();
    }
    if (forward.length === 0 && inverse.length === 0) throw new UnreadTriplesBlockError('an empty negated property set');
    return { kind: 'negated', forward, inverse };
  }
}
