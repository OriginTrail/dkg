import {
  parseSparqlTsvResultTerm,
} from '@origintrail-official/dkg-rdf-utils';
import { SparqlSelectResultNormalizer } from './sparql-select-result-normalizer.js';
import { SparqlResultsShapeError } from './sparql-results-shape-error.js';
import type { SelectResult } from './triple-store.js';

const RAW_LITERAL_CONTROL = new RegExp(
  `[${String.fromCodePoint(0)}-${String.fromCodePoint(31)}${String.fromCodePoint(127)}]`,
);

export class SparqlTsvResultsShapeError extends SparqlResultsShapeError {
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
  const normalizer = new SparqlSelectResultNormalizer(
    variables.length,
    lines.length > 2,
    malformed,
  );

  const bindings: Array<Record<string, string>> = [];
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
        column,
        normalizer,
      );
      normalizer.set(binding, variable, value);
    }
    bindings.push(binding);
  }
  return { type: 'bindings', bindings, variables };
}

function formatTsvTerm(
  cell: string,
  rowIndex: number,
  variable: string,
  column: number,
  normalizer: SparqlSelectResultNormalizer,
): string {
  const label = `SPARQL TSV binding ${rowIndex}.${variable}`;
  // These two forms dominate managed SELECT traffic. Keep the transport parser
  // allocation-free while still routing IRI policy through the shared result
  // normalizer. Escaped/suffixed/single-quoted terms use the complete grammar.
  if (
    cell.charCodeAt(0) === 60
    && cell.charCodeAt(cell.length - 1) === 62
    && !cell.includes('\\')
  ) {
    return normalizer.formatIri(cell.slice(1, -1), column, label);
  }
  if (
    cell.charCodeAt(0) === 34
    && cell.charCodeAt(cell.length - 1) === 34
    && !cell.includes('\\')
    && !RAW_LITERAL_CONTROL.test(cell)
    && cell.indexOf('"', 1) === cell.length - 1
  ) return cell;

  const term = parseSparqlTsvResultTerm(cell);
  if (term === null) {
    malformed(`${label} is not a valid RDF term`);
  }
  return normalizer.format(term, column, label);
}

function malformed(message: string): never {
  throw new SparqlTsvResultsShapeError(message);
}
