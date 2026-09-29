import {
  decodeNTriplesIriEscapesStrict,
  formatCanonicalRdfLiteralTerm,
  parseWritableRdfTerm,
} from '@origintrail-official/dkg-rdf-utils';
import { isSafeIri } from '@origintrail-official/dkg-core';
import type { SelectResult } from './triple-store.js';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const INTEGER = /^[+-]?[0-9]+$/;
const DECIMAL = /^[+-]?(?:[0-9]*\.[0-9]+)$/;
const DOUBLE = /^[+-]?(?:(?:[0-9]+\.[0-9]*|\.[0-9]+)[eE][+-]?[0-9]+|[0-9]+[eE][+-]?[0-9]+)$/;
const SCHEME_ONLY_IRI = /^[a-zA-Z][a-zA-Z0-9+.-]*:$/;
const RAW_LITERAL_CONTROL = /[\u0000-\u001F\u007F]/;

type IriValidator = (value: string) => boolean;

function createIriValidator(): IriValidator {
  let lastValid: string | undefined;
  return value => {
    if (value === lastValid) return true;
    const valid = isSafeIri(value) || SCHEME_ONLY_IRI.test(value);
    if (valid && value.length <= 1024) lastValid = value;
    return valid;
  };
}

export class SparqlTsvResultsShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SparqlTsvResultsShapeError';
  }
}

/** Decode a complete SPARQL 1.1 TSV SELECT result into the public store shape. */
export function decodeSparqlTsvSelectResult(text: string): SelectResult {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  // One final line terminator is framing, not an extra zero-column solution.
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) malformed('SPARQL TSV response is missing its header');

  const header = lines[0]!;
  const cells = header === '' ? [] : header.split('\t');
  const variables = cells.map((cell, index) => {
    if ((cell[0] !== '?' && cell[0] !== '$') || cell.length === 1) {
      malformed(`SPARQL TSV header column ${index} must be a variable`);
    }
    return cell.slice(1);
  });
  if (new Set(variables).size !== variables.length) {
    malformed('SPARQL TSV header variables must not contain duplicates');
  }
  const iriValidators = variables.map(createIriValidator);
  const datatypeValidators = variables.map(createIriValidator);

  const bindings = new Array<Record<string, string>>(Math.max(0, lines.length - 1));
  for (let rowIndex = 1; rowIndex < lines.length; rowIndex += 1) {
    const line = lines[rowIndex]!;
    const rowCells = variables.length === 0 && line === '' ? [] : line.split('\t');
    if (rowCells.length !== variables.length) {
      malformed(
        `SPARQL TSV row ${rowIndex - 1} has ${rowCells.length} columns; expected ${variables.length}`,
      );
    }
    const binding: Record<string, string> = {};
    for (let column = 0; column < variables.length; column += 1) {
      const cell = rowCells[column]!;
      if (cell === '') continue;
      const variable = variables[column]!;
      const value = formatTsvTerm(
        cell,
        rowIndex - 1,
        variable,
        iriValidators[column]!,
        datatypeValidators[column]!,
      );
      if (variable === '__proto__') {
        Object.defineProperty(binding, '__proto__', {
          value, writable: true, enumerable: true, configurable: true,
        });
      } else {
        binding[variable] = value;
      }
    }
    bindings[rowIndex - 1] = binding;
  }
  return { type: 'bindings', bindings, variables };
}

function formatTsvTerm(
  cell: string,
  rowIndex: number,
  variable: string,
  validateIri: IriValidator,
  validateDatatype: IriValidator,
): string {
  // SPARQL TSV uses Turtle numeric/boolean shorthand instead of the explicit
  // datatype form returned by SPARQL Results JSON. Expand it so both transports
  // preserve the existing DKG result contract.
  if (cell === 'true' || cell === 'false') {
    return formatCanonicalRdfLiteralTerm({
      kind: 'typed', value: cell, datatype: `${XSD}boolean`,
    });
  }
  let numericDatatype: string | undefined;
  if (INTEGER.test(cell)) numericDatatype = `${XSD}integer`;
  else if (DECIMAL.test(cell)) numericDatatype = `${XSD}decimal`;
  else if (DOUBLE.test(cell)) numericDatatype = `${XSD}double`;
  if (numericDatatype) {
    return formatCanonicalRdfLiteralTerm({
      kind: 'typed', value: cell, datatype: numericDatatype,
    });
  }

  if (cell.charCodeAt(0) === 60 && cell.charCodeAt(cell.length - 1) === 62) {
    const encoded = cell.slice(1, -1);
    const iri = encoded.includes('\\')
      ? decodeNTriplesIriEscapesStrict(encoded)
      : encoded;
    if (iri === null || !validateIri(iri)) {
      malformed(`SPARQL TSV binding ${rowIndex}.${variable} is not a valid RDF term`);
    }
    return iri;
  }
  // The common plain-literal form can be returned verbatim. A backslash means
  // the endpoint escaped content that must be decoded and canonicalized first.
  if (
    cell.charCodeAt(0) === 34
    && cell.charCodeAt(cell.length - 1) === 34
    && !cell.includes('\\')
    && !RAW_LITERAL_CONTROL.test(cell)
    && cell.indexOf('"', 1) === cell.length - 1
  ) return cell;

  const term = parseWritableRdfTerm(cell);
  if (term === null) {
    malformed(`SPARQL TSV binding ${rowIndex}.${variable} is not a valid RDF term`);
  }
  // TSV requires bracketed IRIREF syntax; a bare IRI is not a result term.
  if (term.kind === 'iri') {
    malformed(`SPARQL TSV binding ${rowIndex}.${variable} is not a valid RDF term`);
  }
  if (term.kind === 'blank-node') return `_:${term.value}`;
  if (term.value.kind === 'typed' && !validateDatatype(term.value.datatype)) {
    malformed(`SPARQL TSV binding ${rowIndex}.${variable} datatype must be an absolute safe IRI`);
  }
  return formatCanonicalRdfLiteralTerm(term.value);
}

function malformed(message: string): never {
  throw new SparqlTsvResultsShapeError(message);
}
