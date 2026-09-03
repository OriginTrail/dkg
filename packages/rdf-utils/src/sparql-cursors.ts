import {
  decodeSparqlCodePointEscapes,
  readSparqlVariable,
  skipSparqlIriRef,
  skipSparqlIriRefForStructuralScan,
  skipSparqlSpaceAndLineComments,
  skipSparqlStringLiteral,
} from './sparql-lexical-primitives.js';

/** Decode SPARQL UCHAR escapes before handing a request to a parser. */
export function preprocessSparqlCodePointEscapes(source: string): string | null {
  return decodeSparqlCodePointEscapes(source);
}

export {
  readSparqlVariable,
  skipSparqlIriRef,
  skipSparqlIriRefForStructuralScan,
  skipSparqlSpaceAndLineComments,
  skipSparqlStringLiteral,
};
