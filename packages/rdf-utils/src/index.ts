export { isAbsoluteRfc3987IriV1 } from './absolute-rfc3987-iri.js';
export { isRdfBlankNodeLabel } from './blank-node-label.js';
export { escapeRdfLiteral } from './rdf-literal-escape.js';

export {
  canonicalizeRdfObjectTerm,
  isRdfTerm,
  normalizeRdfObject,
  parseRdfLiteralTerm,
  parseWritableRdfTerm,
} from './rdf-object-term.js';
export type {
  ParseRdfLiteralTermOptions,
  WritableRdfTerm,
} from './rdf-object-term.js';

// The configurable lexical scanner stays package-internal. Only the legacy
// canonical-RDF splitter remains part of the supported package façade.
export { parseRdfLiteralLexicalTerm } from './rdf-term-lexical.js';
export type { RdfLiteralLexicalTerm } from './rdf-term-lexical.js';

export {
  decodeNTriplesIriEscapesPreservingLegacy,
  decodeNTriplesIriEscapesStrict,
  decodeNTriplesUcharEscapes,
  decodeRdfLiteralBody,
  formatCanonicalRdfLiteralTerm,
  formatCanonicalRdfTerm,
  XSD_STRING_DATATYPE,
} from './rdf-term.js';
export type {
  DecodeNTriplesUcharEscapesOptions,
  DecodeRdfLiteralBodyOptions,
  RdfJsTermLike,
  RdfLiteralTerm,
  RdfTerm,
} from './rdf-term.js';

export {
  parseSparqlTsvHeaderVariable,
  parseSparqlTsvResultTerm,
} from './sparql-tsv-result-term.js';
export type {
  SparqlTsvResultTerm,
} from './sparql-tsv-result-term.js';
