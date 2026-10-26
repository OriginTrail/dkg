import {
  decodeNTriplesIriEscapesStrict,
  formatCanonicalRdfLiteralTerm,
  isRdfBlankNodeLabel,
  isSparqlVariableNameRaw,
  parseSparqlTsvLiteralTerm,
  type RdfLiteralTerm,
} from '@origintrail-official/dkg-rdf-utils';
import { consumeStoreResponseBodyChunks } from './http-response-limit.js';
import {
  createSparqlResultIriValidator,
  isSafeSparqlResultIri,
  MAX_CACHED_SPARQL_IRI_VARIABLES,
} from './sparql-result-iri.js';
import { SparqlResultsShapeError } from './sparql-results-shape-error.js';
import type { SelectResult } from './triple-store.js';

const XSD_NAMESPACE = 'http://www.w3.org/2001/XMLSchema#';
const TSV_INTEGER = /^[+-]?[0-9]+$/;
const TSV_DECIMAL = /^[+-]?(?:[0-9]*\.[0-9]+)$/;
const TSV_DOUBLE = /^[+-]?(?:(?:[0-9]+\.[0-9]*|\.[0-9]+)[eE][+-]?[0-9]+|[0-9]+[eE][+-]?[0-9]+)$/;
// eslint-disable-next-line no-control-regex -- Raw controls require canonical escaping and cannot use this fast path.
const CANONICAL_PLAIN_LITERAL = /^"[^"\\\u0000-\u001F\u007F]*"$/;
export class SparqlTsvResultsShapeError extends SparqlResultsShapeError {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'SparqlTsvResultsShapeError';
  }
}

export interface SparqlTsvResponseOptions {
  maxResponseBytes?: number;
}

/**
 * Decode a SPARQL TSV SELECT body directly from the response stream. Only the
 * current UTF-8 fragment and current row are retained; the public bindings are
 * built once, without first materializing a response-sized string or JSON tree.
 */
export async function decodeSparqlTsvSelectResponse(
  response: Response,
  options: SparqlTsvResponseOptions = {},
  inspectLine?: (line: string) => void,
): Promise<SelectResult> {
  const parser = new SparqlTsvSelectParser();
  const lines = new SparqlTsvLineFramer((line) => {
    inspectLine?.(line);
    parser.consumeLine(line);
  });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  await consumeStoreResponseBodyChunks(response, options.maxResponseBytes, chunk => {
    lines.feed(decodeTsvUtf8(decoder, chunk));
  });
  lines.feed(decodeTsvUtf8(decoder));
  lines.finish();
  return parser.finish();
}

/** Decode an already-buffered TSV result; primarily useful for fixtures and benchmarks. */
export function decodeSparqlTsvSelectResult(text: string): SelectResult {
  const parser = new SparqlTsvSelectParser();
  const lines = new SparqlTsvLineFramer(line => parser.consumeLine(line));
  lines.feed(text);
  lines.finish();
  return parser.finish();
}

class SparqlTsvLineFramer {
  private pending: string[] = [];
  private skipLeadingLf = false;

  constructor(private readonly consumeLine: (line: string) => void) {}

  feed(text: string): void {
    if (text.length === 0) return;
    if (this.skipLeadingLf) {
      this.skipLeadingLf = false;
      if (text.startsWith('\n')) text = text.slice(1);
      if (text.length === 0) return;
    }
    // Scan only the new fragment. Rescanning the accumulated unfinished row
    // makes large literals quadratic when HTTP delivers many small chunks.
    // Preserve native split's fast LF path, joining fragments once per row.
    this.skipLeadingLf = text.endsWith('\r');
    const lines = text.includes('\r') ? text.split(/\r\n|\n|\r/) : text.split('\n');
    if (lines.length > 1) {
      if (this.pending.length > 0) {
        this.pending.push(lines[0]!);
        this.consumeLine(this.pending.join(''));
        this.pending = [];
      } else {
        this.consumeLine(lines[0]!);
      }
      for (let index = 1; index < lines.length - 1; index += 1) {
        this.consumeLine(lines[index]!);
      }
    }
    const remainder = lines[lines.length - 1]!;
    if (remainder.length > 0) this.pending.push(remainder);
  }

  finish(): void {
    // Terminators were already consumed, including a trailing CR. Only an
    // unterminated non-empty row remains; do not invent an extra empty row.
    if (this.pending.length > 0) this.consumeLine(this.pending.join(''));
    this.pending = [];
    this.skipLeadingLf = false;
  }
}

class SparqlTsvSelectParser {
  private variables: string[] | undefined;
  private readonly bindings: Array<Record<string, string>> = [];
  private normalizer: TsvResultNormalizer | undefined;

  finish(): SelectResult {
    if (this.variables === undefined) {
      malformed('SPARQL TSV response is missing its header');
    }
    return Object.freeze({
      type: 'bindings',
      bindings: this.bindings,
      variables: this.variables,
    }) satisfies SelectResult;
  }

  consumeLine(rawLine: string): void {
    const line = this.variables === undefined ? rawLine.replace(/^\uFEFF/, '') : rawLine;
    if (this.variables === undefined) {
      this.consumeHeader(line);
      return;
    }
    const cells = this.variables.length === 0 && line === '' ? [] : line.split('\t');
    const rowIndex = this.bindings.length;
    if (cells.length !== this.variables.length) {
      malformed(
        `SPARQL TSV row ${rowIndex} has ${cells.length} columns; expected ${this.variables.length}`,
      );
    }
    const binding: Record<string, string> = {};
    for (let column = 0; column < this.variables.length; column += 1) {
      const cell = cells[column]!;
      if (cell === '') continue;
      const variable = this.variables[column]!;
      const value = formatTsvTerm(
        cell,
        column,
        `SPARQL TSV binding ${rowIndex}.${variable}`,
        this.normalizer!,
      );
      setBinding(binding, variable, value);
    }
    this.bindings.push(binding);
  }

  private consumeHeader(line: string): void {
    const cells = line === '' ? [] : line.split('\t');
    const variables = cells.map((cell, index) => {
      if (!cell.startsWith('?') || !isSparqlVariableNameRaw(cell.slice(1))) {
        malformed(`SPARQL TSV header column ${index} must be a variable`);
      }
      return cell.slice(1);
    });
    if (new Set(variables).size !== variables.length) {
      malformed('SPARQL TSV header variables must not contain duplicates');
    }
    this.variables = variables;
    this.normalizer = new TsvResultNormalizer(variables.length);
  }
}

function decodeTsvUtf8(decoder: TextDecoder, chunk?: Uint8Array): string {
  try {
    return chunk === undefined
      ? decoder.decode()
      : decoder.decode(chunk, { stream: true });
  } catch (cause) {
    if (!(cause instanceof TypeError)) throw cause;
    throw new SparqlTsvResultsShapeError('SPARQL TSV response is not valid UTF-8', {
      cause,
    });
  }
}

class TsvResultNormalizer {
  private readonly iriValidators: Array<(value: string) => boolean>;
  private readonly datatypeValidators: Array<(value: string) => boolean>;

  constructor(variableCount: number) {
    const cachedColumns = Math.min(variableCount, MAX_CACHED_SPARQL_IRI_VARIABLES);
    this.iriValidators = Array.from({ length: cachedColumns }, createSparqlResultIriValidator);
    this.datatypeValidators = Array.from({ length: cachedColumns }, createSparqlResultIriValidator);
  }

  formatIri(value: string, column: number, label: string): string {
    if (!(this.iriValidators[column] ?? isSafeSparqlResultIri)(value)) {
      malformed(`${label} URI value must be an absolute safe IRI`);
    }
    return value;
  }

  formatLiteral(
    term: RdfLiteralTerm,
    column: number,
    label: string,
  ): string {
    if (term.kind === 'typed') {
      let datatype = term.datatype;
      if (datatype.includes('\\')) {
        const decoded = decodeNTriplesIriEscapesStrict(datatype);
        if (decoded === null) malformed(`${label} datatype must be an absolute safe IRI`);
        datatype = decoded;
      }
      if (!(this.datatypeValidators[column] ?? isSafeSparqlResultIri)(datatype)) {
        malformed(`${label} datatype must be an absolute safe IRI`);
      }
      return formatCanonicalRdfLiteralTerm({ ...term, datatype });
    }
    return formatCanonicalRdfLiteralTerm(term);
  }
}

function formatTsvTerm(
  cell: string,
  column: number,
  label: string,
  normalizer: TsvResultNormalizer,
): string {
  // Canonical plain literals need no normalization or additional allocation.
  if (CANONICAL_PLAIN_LITERAL.test(cell)) return cell;
  if (cell === 'true' || cell === 'false') {
    return normalizer.formatLiteral(
      { kind: 'typed', value: cell, datatype: `${XSD_NAMESPACE}boolean` },
      column,
      label,
    );
  }
  const numericDatatype = TSV_INTEGER.test(cell)
    ? 'integer'
    : TSV_DECIMAL.test(cell)
      ? 'decimal'
      : TSV_DOUBLE.test(cell)
        ? 'double'
        : undefined;
  if (numericDatatype !== undefined) {
    return normalizer.formatLiteral(
      { kind: 'typed', value: cell, datatype: `${XSD_NAMESPACE}${numericDatatype}` },
      column,
      label,
    );
  }
  if (cell.startsWith('<') && cell.endsWith('>')) {
    const encoded = cell.slice(1, -1);
    const value = encoded.includes('\\')
      ? decodeNTriplesIriEscapesStrict(encoded)
      : encoded;
    if (value === null) malformed(`${label} is not a valid RDF term`);
    return normalizer.formatIri(value, column, label);
  }
  if (cell.startsWith('_:')) {
    const labelValue = cell.slice(2);
    if (!isRdfBlankNodeLabel(labelValue)) malformed(`${label} is not a valid RDF term`);
    return `_:${labelValue}`;
  }
  const literal = parseSparqlTsvLiteralTerm(cell, {
    combineSurrogatePairs: true,
  });
  if (literal === null) malformed(`${label} is not a valid RDF term`);
  return normalizer.formatLiteral(literal, column, label);
}

function setBinding(binding: Record<string, string>, variable: string, value: string): void {
  if (variable === '__proto__') {
    Object.defineProperty(binding, '__proto__', {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return;
  }
  binding[variable] = value;
}

function malformed(message: string): never {
  throw new SparqlTsvResultsShapeError(message);
}
