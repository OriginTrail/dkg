import { readRawSparqlBlankNodeLabelEnd } from './sparql-lexical-primitives.js';

export type RdfLiteralLexicalTerm =
  | { body: string; suffix: { kind: 'plain' } }
  | { body: string; suffix: { kind: 'language'; language: string } }
  | {
    body: string;
    suffix: { kind: 'datatype'; datatype: string; syntax: 'bracketed' | 'bare' };
  };

const RDF_LANGUAGE_TAG_PATTERN = /^[A-Za-z]+(?:-[A-Za-z0-9]+)*$/;
const RDF_LANGUAGE_TAG_LEXICAL_PATTERN = /^[A-Za-z0-9-]+$/;

/** True for the language-tag grammar accepted by canonical RDF literals. */
export function isRdfLanguageTag(value: string): boolean {
  return RDF_LANGUAGE_TAG_PATTERN.test(value);
}

/** Split the canonical double-quoted RDF literal lexical form. */
export function parseRdfLiteralLexicalTerm(term: string): RdfLiteralLexicalTerm | null {
  return parseRdfLiteralLexicalTermWith(term, false);
}

/** One lexical scanner shared by canonical RDF and SPARQL TSV short strings. */
export function parseRdfLiteralLexicalTermWith(
  term: string,
  allowSingleQuoted: boolean,
): RdfLiteralLexicalTerm | null {
  const delimiter = term[0];
  if (delimiter !== '"' && !(allowSingleQuoted && delimiter === "'")) return null;
  let closing = -1;
  for (let index = 1; index < term.length; index += 1) {
    const character = term[index];
    if (character === '\\') {
      index += 1;
      if (index >= term.length) return null;
      continue;
    }
    if (character === delimiter) {
      closing = index;
      break;
    }
  }
  if (closing < 0) return null;

  const body = term.slice(1, closing);
  const suffix = term.slice(closing + 1);
  if (suffix === '') return { body, suffix: { kind: 'plain' } };
  if (suffix.startsWith('@')) {
    const language = suffix.slice(1);
    return RDF_LANGUAGE_TAG_LEXICAL_PATTERN.test(language)
      ? { body, suffix: { kind: 'language', language } }
      : null;
  }
  if (!suffix.startsWith('^^')) return null;
  const datatype = suffix.slice(2);
  if (datatype.startsWith('<')) {
    if (!datatype.endsWith('>')) return null;
    const bracketed = datatype.slice(1, -1);
    if (bracketed.length === 0 || bracketed.includes('>')) return null;
    return { body, suffix: { kind: 'datatype', datatype: bracketed, syntax: 'bracketed' } };
  }
  if (datatype.length === 0) return null;
  return { body, suffix: { kind: 'datatype', datatype, syntax: 'bare' } };
}

export function isRdfBlankNodeTerm(term: string): boolean {
  if (!term.startsWith('_:')) return false;
  return readRawSparqlBlankNodeLabelEnd(term, 2) === term.length;
}
