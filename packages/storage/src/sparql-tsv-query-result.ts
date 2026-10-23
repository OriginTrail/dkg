import {
  decodeNTriplesIriEscapesStrict,
  formatCanonicalRdfLiteralTerm,
  isRdfBlankNodeLabel,
  parseRdfLiteralTerm,
  type RdfLiteralTerm,
} from '@origintrail-official/dkg-rdf-utils';
import { isSafeIri } from '@origintrail-official/dkg-core';
import { StoreResponseTooLargeError } from './http-response-limit.js';
import {
  assertManagedOxigraphSparqlResponseComplete,
} from './adapters/sparql-response-policy.js';
import type { StoreOperation } from './store-operation-outcome.js';
import type { SelectResult } from './triple-store.js';

const XSD_NAMESPACE = 'http://www.w3.org/2001/XMLSchema#';
const TSV_INTEGER = /^[+-]?[0-9]+$/;
const TSV_DECIMAL = /^[+-]?(?:[0-9]*\.[0-9]+)$/;
const TSV_DOUBLE = /^[+-]?(?:(?:[0-9]+\.[0-9]*|\.[0-9]+)[eE][+-]?[0-9]+|[0-9]+[eE][+-]?[0-9]+)$/;
const TSV_FAST_PLAIN_LITERAL = /^"[^"\\\u0000-\u001F\u007F]*"$/;
const SCHEME_ONLY_IRI = /^[a-zA-Z][a-zA-Z0-9+.-]*:$/;

// SPARQL 1.1 VARNAME. A TSV header always uses the `?name` spelling.
const PN_CHARS_BASE =
  'A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF'
  + '\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF'
  + '\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const PN_CHARS_U = `${PN_CHARS_BASE}_`;
const TSV_HEADER_VARIABLE = new RegExp(
  `^\\?([${PN_CHARS_U}0-9][${PN_CHARS_U}0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*)$`,
  'u',
);

const MAX_CACHED_IRI_VARIABLES = 128;
const MAX_CACHED_IRI_LENGTH = 1024;
const MAX_CONSECUTIVE_IRI_MISSES = 16;
const PAUSED_IRI_COMPARISON_ROWS = 128;

export class SparqlTsvResultsShapeError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'SparqlTsvResultsShapeError';
  }
}

export interface SparqlTsvResponseOptions {
  maxResponseBytes?: number;
  managedOxigraph?: boolean;
  operation: StoreOperation;
}

/**
 * Decode a SPARQL TSV SELECT body directly from the response stream. Only the
 * current UTF-8 fragment and current row are retained; the public bindings are
 * built once, without first materializing a response-sized string or JSON tree.
 */
export async function decodeSparqlTsvSelectResponse(
  response: Response,
  options: SparqlTsvResponseOptions,
): Promise<SelectResult> {
  const maxBytes = validateMaxBytes(options.maxResponseBytes);
  rejectOversizedContentLength(response, maxBytes);
  const parser = new SparqlTsvSelectParser(options);
  const body = response.body;
  if (body === null) return parser.finish();

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (maxBytes !== undefined && bytesRead > maxBytes) {
        throw new StoreResponseTooLargeError(maxBytes, bytesRead);
      }
      parser.feed(decoder.decode(value, { stream: true }));
    }
    parser.feed(decoder.decode());
    return parser.finish();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    if (error instanceof TypeError && /encoded data|utf-8/i.test(error.message)) {
      throw new SparqlTsvResultsShapeError('SPARQL TSV response is not valid UTF-8', {
        cause: error,
      });
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Decode an already-buffered TSV result; primarily useful for fixtures and benchmarks. */
export function decodeSparqlTsvSelectResult(text: string): SelectResult {
  const parser = new SparqlTsvSelectParser({ operation: 'query' });
  parser.feed(text);
  return parser.finish();
}

class SparqlTsvSelectParser {
  private pending = '';
  private variables: string[] | undefined;
  private readonly bindings: Array<Record<string, string>> = [];
  private normalizer: TsvResultNormalizer | undefined;

  constructor(private readonly options: SparqlTsvResponseOptions) {}

  feed(text: string): void {
    if (text.length === 0) return;
    this.pending += text;
    // Oxigraph's normal framing is LF-only. Native split is materially faster
    // than walking every UTF-16 code unit in JavaScript, especially when a
    // fetch chunk contains hundreds of rows. Keep the uncommon CR/CRLF path
    // complete without penalizing that hot path.
    if (!this.pending.includes('\r')) {
      const lines = this.pending.split('\n');
      this.pending = lines.pop()!;
      for (const line of lines) this.consumeLine(line);
      return;
    }

    const trailingCr = this.pending.endsWith('\r');
    const complete = trailingCr ? this.pending.slice(0, -1) : this.pending;
    const lines = complete.split(/\r\n|\n|\r/);
    this.pending = `${lines.pop()!}${trailingCr ? '\r' : ''}`;
    for (const line of lines) this.consumeLine(line);
  }

  finish(): SelectResult {
    // At EOF, a pending CR is a line terminator; a non-empty remainder is the
    // final unterminated line. A final terminator never invents an empty row.
    if (this.pending.endsWith('\r')) {
      this.consumeLine(this.pending.slice(0, -1));
      this.pending = '';
    } else if (this.pending.length > 0) {
      this.consumeLine(this.pending);
      this.pending = '';
    }
    if (this.variables === undefined) {
      malformed('SPARQL TSV response is missing its header');
    }
    return Object.freeze({
      type: 'bindings',
      bindings: this.bindings,
      variables: this.variables,
    }) satisfies SelectResult;
  }

  private consumeLine(rawLine: string): void {
    const line = this.variables === undefined ? rawLine.replace(/^\uFEFF/, '') : rawLine;
    if (this.options.managedOxigraph === true) {
      assertManagedOxigraphSparqlResponseComplete(line, this.options.operation);
    }
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
      const match = TSV_HEADER_VARIABLE.exec(cell);
      if (match === null) malformed(`SPARQL TSV header column ${index} must be a variable`);
      return match[1]!;
    });
    if (new Set(variables).size !== variables.length) {
      malformed('SPARQL TSV header variables must not contain duplicates');
    }
    this.variables = variables;
    this.normalizer = new TsvResultNormalizer(variables.length);
  }
}

class TsvResultNormalizer {
  private readonly iriValidators: Array<(value: string) => boolean>;
  private readonly datatypeValidators: Array<(value: string) => boolean>;

  constructor(variableCount: number) {
    const cachedColumns = Math.min(variableCount, MAX_CACHED_IRI_VARIABLES);
    this.iriValidators = Array.from({ length: cachedColumns }, createIriValidator);
    this.datatypeValidators = Array.from({ length: cachedColumns }, createIriValidator);
  }

  formatIri(value: string, column: number, label: string): string {
    if (!(this.iriValidators[column] ?? isSafeResultIri)(value)) {
      malformed(`${label} URI value must be an absolute safe IRI`);
    }
    return value;
  }

  formatLiteral(term: RdfLiteralTerm, column: number, label: string): string {
    if (term.kind === 'typed') {
      let datatype = term.datatype;
      if (datatype.includes('\\')) {
        const decoded = decodeNTriplesIriEscapesStrict(datatype);
        if (decoded === null) malformed(`${label} datatype must be an absolute safe IRI`);
        datatype = decoded;
      }
      if (!(this.datatypeValidators[column] ?? isSafeResultIri)(datatype)) {
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
  if (TSV_FAST_PLAIN_LITERAL.test(cell)) {
    return `"${cell.slice(1, -1)}"`;
  }
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
  const literal = parseRdfLiteralTerm(cell, { combineSurrogatePairs: true });
  if (literal === null) malformed(`${label} is not a valid RDF term`);
  return normalizer.formatLiteral(literal, column, label);
}

function isSafeResultIri(value: string): boolean {
  // Match the established SPARQL JSON response contract exactly so changing
  // the transport can never make a previously accepted result fail.
  return isSafeIri(value) || SCHEME_ONLY_IRI.test(value);
}

function createIriValidator(): (value: string) => boolean {
  let lastValidIri: string | undefined;
  let consecutiveMisses = 0;
  let pausedRows = 0;
  return value => {
    if (pausedRows > 0) {
      pausedRows -= 1;
      return isSafeResultIri(value);
    }
    if (value === lastValidIri) {
      consecutiveMisses = 0;
      return true;
    }
    const valid = isSafeResultIri(value);
    if (valid && value.length <= MAX_CACHED_IRI_LENGTH) lastValidIri = value;
    consecutiveMisses += 1;
    if (consecutiveMisses >= MAX_CONSECUTIVE_IRI_MISSES) {
      pausedRows = PAUSED_IRI_COMPARISON_ROWS;
      consecutiveMisses = 0;
      lastValidIri = undefined;
    }
    return valid;
  };
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

function validateMaxBytes(value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError('maxResponseBytes must be a non-negative safe integer');
  }
  return value;
}

function rejectOversizedContentLength(response: Response, maxBytes: number | undefined): void {
  if (maxBytes === undefined) return;
  const raw = response.headers.get('content-length');
  if (raw === null || !/^[0-9]+$/.test(raw)) return;
  const actual = BigInt(raw);
  if (actual > BigInt(maxBytes)) throw new StoreResponseTooLargeError(maxBytes, actual);
}

function malformed(message: string): never {
  throw new SparqlTsvResultsShapeError(message);
}
