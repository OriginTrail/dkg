import { formatTerm } from './row-serialization.js';

interface ExactGraphCursorTerms {
  readonly s: string;
  readonly p: string;
  readonly o: string;
}

/** Datatypes whose SPARQL value comparison is numeric/date-like, not lexical. */
const SPARQL_VALUE_ORDERED_DATATYPES = [
  'http://www.w3.org/2001/XMLSchema#boolean',
  'http://www.w3.org/2001/XMLSchema#date',
  'http://www.w3.org/2001/XMLSchema#dateTime',
  'http://www.w3.org/2001/XMLSchema#dateTimeStamp',
  'http://www.w3.org/2001/XMLSchema#dayTimeDuration',
  'http://www.w3.org/2001/XMLSchema#decimal',
  'http://www.w3.org/2001/XMLSchema#double',
  'http://www.w3.org/2001/XMLSchema#duration',
  'http://www.w3.org/2001/XMLSchema#float',
  'http://www.w3.org/2001/XMLSchema#gDay',
  'http://www.w3.org/2001/XMLSchema#gMonth',
  'http://www.w3.org/2001/XMLSchema#gMonthDay',
  'http://www.w3.org/2001/XMLSchema#gYear',
  'http://www.w3.org/2001/XMLSchema#gYearMonth',
  'http://www.w3.org/2001/XMLSchema#integer',
  'http://www.w3.org/2001/XMLSchema#nonNegativeInteger',
  'http://www.w3.org/2001/XMLSchema#nonPositiveInteger',
  'http://www.w3.org/2001/XMLSchema#negativeInteger',
  'http://www.w3.org/2001/XMLSchema#positiveInteger',
  'http://www.w3.org/2001/XMLSchema#long',
  'http://www.w3.org/2001/XMLSchema#int',
  'http://www.w3.org/2001/XMLSchema#short',
  'http://www.w3.org/2001/XMLSchema#time',
  'http://www.w3.org/2001/XMLSchema#byte',
  'http://www.w3.org/2001/XMLSchema#unsignedLong',
  'http://www.w3.org/2001/XMLSchema#unsignedInt',
  'http://www.w3.org/2001/XMLSchema#unsignedShort',
  'http://www.w3.org/2001/XMLSchema#unsignedByte',
  'http://www.w3.org/2001/XMLSchema#yearMonthDuration',
] as const;

const SPARQL_VALUE_ORDERED_DATATYPE_VALUES = SPARQL_VALUE_ORDERED_DATATYPES
  .map((datatype) => `<${datatype}>`)
  .join(', ');

function hasValueOrderedDatatype(term: string): boolean {
  return SPARQL_VALUE_ORDERED_DATATYPES
    .some((datatype) => term.endsWith(`^^<${datatype}>`));
}

export function hasUnsupportedExactGraphCursorTerm(cursor: ExactGraphCursorTerms): boolean {
  // SPARQL exposes no portable ordering relation for blank-node identifiers.
  // Ordered XSD values also cannot be continued portably with `>`: float and
  // double admit NaN, duration comparison can be partial, and distinct lexical
  // forms can denote the same date/time or numeric value. ORDER BY can still
  // place those terms after the cursor even when `>` is false. Falling back
  // preserves the pre-existing deterministic path for each unsafe boundary.
  return [cursor.s, cursor.p, cursor.o].some((term) => (
    term.startsWith('_:') || hasValueOrderedDatatype(term)
  ));
}

/**
 * Build a SPARQL predicate for one term being strictly after a cursor term in
 * the backend's `ORDER BY` order. IRI rank is explicit, while
 * literal values use value comparison for ordered XSD datatypes and lexical
 * comparison otherwise.  The datatype/language tie-break mirrors Oxigraph's
 * RDF-term ordering and is covered by the mixed-term regression fixture.
 */
function termAfterExactGraphCursor(variable: string, cursorTerm: string): string {
  const formatted = formatTerm(cursorTerm);
  if (!cursorTerm.startsWith('"')) {
    return `(isLiteral(${variable}) || (isIRI(${variable}) && STR(${variable}) > STR(${formatted})))`;
  }
  return `(
    isLiteral(${variable}) && (
      (
        STR(${variable}) > STR(${formatted})
        && !(
          DATATYPE(${variable}) = DATATYPE(${formatted})
          && DATATYPE(${variable}) IN (${SPARQL_VALUE_ORDERED_DATATYPE_VALUES})
        )
      )
      || (
        STR(${variable}) = STR(${formatted}) && (
          STR(DATATYPE(${variable})) > STR(DATATYPE(${formatted}))
          || (
            DATATYPE(${variable}) = DATATYPE(${formatted})
            && LANG(${variable}) > LANG(${formatted})
          )
        )
      )
      || (
        DATATYPE(${variable}) = DATATYPE(${formatted})
        && DATATYPE(${variable}) IN (${SPARQL_VALUE_ORDERED_DATATYPE_VALUES})
        && ${variable} > ${formatted}
      )
    )
  )`;
}

export function exactGraphCursorFilter(cursor: ExactGraphCursorTerms): string {
  const s = formatTerm(cursor.s);
  const p = formatTerm(cursor.p);
  return `(
    ${termAfterExactGraphCursor('?s', cursor.s)}
    || (?s = ${s} && ${termAfterExactGraphCursor('?p', cursor.p)})
    || (
      ?s = ${s}
      && ?p = ${p}
      && ${termAfterExactGraphCursor('?o', cursor.o)}
    )
  )`;
}

