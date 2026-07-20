import { rdfError } from './errors.js';
import {
  canonicalizeAbsoluteIriV1,
  canonicalizeNQuadsV1,
  parseRdfTermV1,
} from './nquads.js';
import type { CanonicalRdfDatasetV1, RdfQuadV1 } from './types.js';

const UTF8_ENCODER = new TextEncoder();
const DEFAULT_MAXIMUM_SOURCE_BYTES = 1_048_576;
const DEFAULT_MAXIMUM_SOLUTIONS = 100_000;
const FORBIDDEN_OPERATIONS = new Set([
  'SERVICE', 'LOAD', 'CLEAR', 'DROP', 'COPY', 'MOVE', 'ADD', 'CREATE', 'WITH', 'USING',
]);
const NONDETERMINISTIC_FUNCTIONS = new Set([
  'NOW', 'RAND', 'UUID', 'STRUUID', 'BNODE',
]);

type Token =
  | { readonly kind: 'word'; readonly value: string }
  | { readonly kind: 'punctuation'; readonly value: string }
  | { readonly kind: 'variable'; readonly value: string }
  | { readonly kind: 'term'; readonly value: string; readonly termKind: 'iri' | 'literal'; readonly iri?: string };

type PatternTerm =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'term'; readonly canonical: string; readonly termKind: 'iri' | 'literal' };

interface QuadPattern {
  readonly graph: string;
  readonly subject: PatternTerm;
  readonly predicate: PatternTerm;
  readonly object: PatternTerm;
}

interface ParsedSparqlUpdate {
  readonly deletePatterns: readonly QuadPattern[];
  readonly insertPatterns: readonly QuadPattern[];
  readonly wherePatterns: readonly QuadPattern[] | null;
}

export interface CompiledSparqlPatchV1 {
  readonly deleteDataset: CanonicalRdfDatasetV1;
  readonly insertDataset: CanonicalRdfDatasetV1;
  readonly resultDataset: CanonicalRdfDatasetV1;
}

function safeInteger(value: number | undefined, fallback: number, label: string): number {
  const exact = value ?? fallback;
  if (!Number.isSafeInteger(exact) || exact <= 0) {
    rdfError('WAL_RDF_LIMIT_EXCEEDED', label + ' must be a positive safe integer');
  }
  return exact;
}

function tokenize(source: string): readonly Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const character = source[cursor]!;
    if (/\s/.test(character)) {
      cursor += 1;
      continue;
    }
    if (character === '#') {
      while (cursor < source.length && source[cursor] !== '\n') cursor += 1;
      continue;
    }
    if (character === '<' || character === '"') {
      const term = parseRdfTermV1(source, cursor, {
        allowLiteral: true,
        label: 'SPARQL term',
      });
      tokens.push({
        kind: 'term',
        value: term.canonical,
        termKind: term.kind,
        ...(term.iri === undefined ? {} : { iri: term.iri }),
      });
      cursor = term.end;
      continue;
    }
    if (character === '?' || character === '$') {
      const match = /^[?$]([A-Za-z_][A-Za-z0-9_-]*)/.exec(source.slice(cursor));
      if (!match) rdfError('WAL_RDF_SPARQL_UNSUPPORTED', 'SPARQL contains an invalid variable');
      tokens.push({ kind: 'variable', value: match[1]! });
      cursor += match[0].length;
      continue;
    }
    if ('{}().;,'.includes(character)) {
      tokens.push({ kind: 'punctuation', value: character });
      cursor += 1;
      continue;
    }
    if (source.startsWith('_:', cursor)) {
      rdfError('WAL_RDF_BLANK_NODE', 'SPARQL contains a blank node; a DKG skolem IRI is required');
    }
    const word = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(source.slice(cursor));
    if (word) {
      tokens.push({ kind: 'word', value: word[0]!.toUpperCase() });
      cursor += word[0]!.length;
      continue;
    }
    rdfError('WAL_RDF_SPARQL_UNSUPPORTED', 'SPARQL contains unsupported syntax at byte offset ' + UTF8_ENCODER.encode(source.slice(0, cursor)).length);
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind !== 'word') continue;
    if (FORBIDDEN_OPERATIONS.has(token.value)) {
      rdfError('WAL_RDF_SPARQL_UNSAFE', 'SPARQL operation ' + token.value + ' is forbidden');
    }
    if (
      tokens[index + 1]?.kind === 'punctuation'
      && tokens[index + 1]!.value === '('
    ) {
      const code = NONDETERMINISTIC_FUNCTIONS.has(token.value)
        ? 'WAL_RDF_SPARQL_UNSAFE'
        : 'WAL_RDF_SPARQL_UNSUPPORTED';
      rdfError(code, 'SPARQL function ' + token.value + ' is not in the version-1 deterministic subset');
    }
  }
  return tokens;
}

class Parser {
  private cursor = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly allowedGraphs: ReadonlySet<string>,
  ) {}

  private peek(): Token | undefined {
    return this.tokens[this.cursor];
  }

  private consume(): Token {
    const token = this.tokens[this.cursor];
    if (!token) rdfError('WAL_RDF_SPARQL_UNSUPPORTED', 'SPARQL ended before the update was complete');
    this.cursor += 1;
    return token;
  }

  private word(expected: string): void {
    const token = this.consume();
    if (token.kind !== 'word' || token.value !== expected) {
      rdfError('WAL_RDF_SPARQL_UNSUPPORTED', 'SPARQL expected ' + expected);
    }
  }

  private punctuation(expected: string): void {
    const token = this.consume();
    if (token.kind !== 'punctuation' || token.value !== expected) {
      rdfError('WAL_RDF_SPARQL_UNSUPPORTED', 'SPARQL expected ' + expected);
    }
  }

  private graphIri(): string {
    const token = this.consume();
    if (token.kind === 'variable') {
      rdfError('WAL_RDF_SCOPE_ESCAPE', 'graph variables are forbidden in the scoped update subset');
    }
    if (token.kind !== 'term' || token.termKind !== 'iri' || token.iri === undefined) {
      rdfError('WAL_RDF_SPARQL_UNSUPPORTED', 'GRAPH must name one exact absolute IRI');
    }
    if (!this.allowedGraphs.has(token.iri)) {
      rdfError('WAL_RDF_SCOPE_ESCAPE', 'SPARQL reads or writes a graph outside the declared logical key');
    }
    return token.iri;
  }

  private patternTerm(position: 'subject' | 'predicate' | 'object', allowVariables: boolean): PatternTerm {
    const token = this.consume();
    if (token.kind === 'variable') {
      if (!allowVariables) rdfError('WAL_RDF_SPARQL_UNSUPPORTED', 'DATA blocks cannot contain variables');
      return { kind: 'variable', name: token.value };
    }
    if (token.kind !== 'term') {
      rdfError('WAL_RDF_SPARQL_UNSUPPORTED', 'SPARQL triple contains an unsupported term');
    }
    if (position !== 'object' && token.termKind !== 'iri') {
      rdfError('WAL_RDF_SPARQL_UNSUPPORTED', 'SPARQL ' + position + ' must be an IRI or variable');
    }
    return { kind: 'term', canonical: token.value, termKind: token.termKind };
  }

  private graphBlock(allowVariables: boolean): readonly QuadPattern[] {
    this.word('GRAPH');
    const graph = this.graphIri();
    this.punctuation('{');
    const patterns: QuadPattern[] = [];
    while (!(this.peek()?.kind === 'punctuation' && this.peek()!.value === '}')) {
      const subject = this.patternTerm('subject', allowVariables);
      const predicate = this.patternTerm('predicate', allowVariables);
      const object = this.patternTerm('object', allowVariables);
      this.punctuation('.');
      patterns.push({ graph, subject, predicate, object });
    }
    this.punctuation('}');
    return patterns;
  }

  private block(allowVariables: boolean): readonly QuadPattern[] {
    this.punctuation('{');
    const patterns: QuadPattern[] = [];
    while (!(this.peek()?.kind === 'punctuation' && this.peek()!.value === '}')) {
      patterns.push(...this.graphBlock(allowVariables));
    }
    this.punctuation('}');
    return patterns;
  }

  parse(): ParsedSparqlUpdate {
    const first = this.consume();
    if (first.kind !== 'word' || (first.value !== 'INSERT' && first.value !== 'DELETE')) {
      rdfError('WAL_RDF_SPARQL_UNSUPPORTED', 'only INSERT DATA, DELETE DATA, and DELETE/INSERT WHERE are supported');
    }
    if (this.peek()?.kind === 'word' && this.peek()!.value === 'DATA') {
      this.consume();
      const patterns = this.block(false);
      if (this.cursor !== this.tokens.length) {
        rdfError('WAL_RDF_SPARQL_UNSUPPORTED', 'multiple SPARQL operations are forbidden');
      }
      return first.value === 'INSERT'
        ? { deletePatterns: [], insertPatterns: patterns, wherePatterns: null }
        : { deletePatterns: patterns, insertPatterns: [], wherePatterns: null };
    }
    let deletePatterns: readonly QuadPattern[] = [];
    let insertPatterns: readonly QuadPattern[] = [];
    if (first.value === 'DELETE') {
      deletePatterns = this.block(true);
      if (this.peek()?.kind === 'word' && this.peek()!.value === 'INSERT') {
        this.consume();
        insertPatterns = this.block(true);
      }
    } else {
      insertPatterns = this.block(true);
    }
    this.word('WHERE');
    const wherePatterns = this.block(true);
    if (wherePatterns.length === 0) {
      rdfError('WAL_RDF_SPARQL_UNSUPPORTED', 'DELETE/INSERT WHERE requires a non-empty bounded graph pattern');
    }
    if (this.cursor !== this.tokens.length) {
      rdfError('WAL_RDF_SPARQL_UNSUPPORTED', 'SPARQL contains trailing or multiple operations');
    }
    const bound = new Set<string>();
    for (const pattern of wherePatterns) {
      for (const term of [pattern.subject, pattern.predicate, pattern.object]) {
        if (term.kind === 'variable') bound.add(term.name);
      }
    }
    for (const pattern of [...deletePatterns, ...insertPatterns]) {
      for (const term of [pattern.subject, pattern.predicate, pattern.object]) {
        if (term.kind === 'variable' && !bound.has(term.name)) {
          rdfError('WAL_RDF_UNBOUND_VARIABLE', 'template variable ?' + term.name + ' is not bound by WHERE');
        }
      }
    }
    return { deletePatterns, insertPatterns, wherePatterns };
  }
}

function actualTerms(quad: RdfQuadV1): readonly [string, string, string] {
  return ['<' + quad.subject + '>', '<' + quad.predicate + '>', quad.object];
}

type Binding = ReadonlyMap<string, string>;

function matchTerm(pattern: PatternTerm, actual: string, input: Binding): Map<string, string> | null {
  if (pattern.kind === 'term') return pattern.canonical === actual ? new Map(input) : null;
  const previous = input.get(pattern.name);
  if (previous !== undefined && previous !== actual) return null;
  const output = new Map(input);
  output.set(pattern.name, actual);
  return output;
}

function evaluateWhere(
  patterns: readonly QuadPattern[],
  base: CanonicalRdfDatasetV1,
  maximumSolutions: number,
): readonly Binding[] {
  let bindings: readonly Binding[] = [new Map()];
  for (const pattern of patterns) {
    const next: Binding[] = [];
    for (const binding of bindings) {
      for (const quad of base.quads) {
        if (quad.graph !== pattern.graph) continue;
        const actual = actualTerms(quad);
        let candidate = matchTerm(pattern.subject, actual[0], binding);
        if (candidate === null) continue;
        candidate = matchTerm(pattern.predicate, actual[1], candidate);
        if (candidate === null) continue;
        candidate = matchTerm(pattern.object, actual[2], candidate);
        if (candidate === null) continue;
        next.push(candidate);
        if (next.length > maximumSolutions) {
          rdfError('WAL_RDF_LIMIT_EXCEEDED', 'SPARQL WHERE exceeds the configured solution bound');
        }
      }
    }
    bindings = next;
  }
  return bindings;
}

function instantiateTerm(pattern: PatternTerm, binding: Binding): string {
  if (pattern.kind === 'term') return pattern.canonical;
  // Parser validation proves every template variable is present in WHERE, and
  // every emitted solution binds every variable in every WHERE pattern.
  return binding.get(pattern.name)!;
}

function instantiate(
  patterns: readonly QuadPattern[],
  bindings: readonly Binding[],
  maximumQuads: number,
): CanonicalRdfDatasetV1 {
  const lines = new Set<string>();
  for (const binding of bindings) {
    for (const pattern of patterns) {
      lines.add(
        instantiateTerm(pattern.subject, binding)
        + ' ' + instantiateTerm(pattern.predicate, binding)
        + ' ' + instantiateTerm(pattern.object, binding)
        + ' <' + pattern.graph + '> .',
      );
      if (lines.size > maximumQuads) {
        rdfError('WAL_RDF_LIMIT_EXCEEDED', 'SPARQL template expansion exceeds the configured quad bound');
      }
    }
  }
  return canonicalizeNQuadsV1([...lines].join('\n'), { maximumQuads });
}

function applyPatch(
  base: CanonicalRdfDatasetV1,
  deletes: CanonicalRdfDatasetV1,
  inserts: CanonicalRdfDatasetV1,
): CanonicalRdfDatasetV1 {
  const lines = new Map(base.quads.map(quad => [quad.canonicalLine, quad.canonicalLine] as const));
  for (const quad of deletes.quads) lines.delete(quad.canonicalLine);
  for (const quad of inserts.quads) lines.set(quad.canonicalLine, quad.canonicalLine);
  return canonicalizeNQuadsV1([...lines.values()].join('\n'));
}

export function compileLocalSparqlPatchV1(input: {
  readonly sparql: string;
  readonly base: CanonicalRdfDatasetV1;
  readonly allowedGraphIris: readonly string[];
  readonly maximumSolutions?: number;
  readonly maximumQuads?: number;
  readonly maximumSourceBytes?: number;
}): CompiledSparqlPatchV1 {
  if (typeof input.sparql !== 'string' || input.sparql !== input.sparql.normalize('NFC')) {
    rdfError('WAL_RDF_SPARQL_UNSUPPORTED', 'SPARQL source must be NFC text');
  }
  const maximumSourceBytes = safeInteger(input.maximumSourceBytes, DEFAULT_MAXIMUM_SOURCE_BYTES, 'maximumSourceBytes');
  if (UTF8_ENCODER.encode(input.sparql).length > maximumSourceBytes) {
    rdfError('WAL_RDF_LIMIT_EXCEEDED', 'SPARQL source exceeds the configured byte bound');
  }
  const allowedGraphs = new Set(input.allowedGraphIris.map((graph, index) =>
    canonicalizeAbsoluteIriV1(graph, 'allowedGraphIris[' + index + ']')));
  if (allowedGraphs.size === 0 || allowedGraphs.size !== input.allowedGraphIris.length) {
    rdfError('WAL_RDF_SCOPE_ESCAPE', 'allowedGraphIris must be a non-empty unique exact set');
  }
  const parsed = new Parser(tokenize(input.sparql), allowedGraphs).parse();
  const maximumSolutions = safeInteger(input.maximumSolutions, DEFAULT_MAXIMUM_SOLUTIONS, 'maximumSolutions');
  const maximumQuads = safeInteger(input.maximumQuads, 1_000_000, 'maximumQuads');
  const bindings = parsed.wherePatterns === null
    ? [new Map<string, string>()]
    : evaluateWhere(parsed.wherePatterns, input.base, maximumSolutions);
  const deleteDataset = instantiate(parsed.deletePatterns, bindings, maximumQuads);
  const insertDataset = instantiate(parsed.insertPatterns, bindings, maximumQuads);
  if (
    deleteDataset.quadCount + insertDataset.quadCount > maximumQuads
    || input.base.quadCount > maximumQuads
  ) rdfError('WAL_RDF_LIMIT_EXCEEDED', 'SPARQL explicit mutation exceeds the configured quad bound');
  const resultDataset = applyPatch(input.base, deleteDataset, insertDataset);
  if (resultDataset.quadCount > maximumQuads) {
    rdfError('WAL_RDF_LIMIT_EXCEEDED', 'SPARQL result exceeds the configured quad bound');
  }
  return { deleteDataset, insertDataset, resultDataset };
}

export function canonicalSparqlAuditBytesV1(source: string): Uint8Array {
  if (typeof source !== 'string' || source !== source.normalize('NFC')) {
    rdfError('WAL_RDF_SPARQL_UNSUPPORTED', 'SPARQL audit source must be NFC text');
  }
  const normalized = source.replace(/\r\n?/g, '\n').trim();
  return UTF8_ENCODER.encode(normalized.length === 0 ? '' : normalized + '\n');
}
