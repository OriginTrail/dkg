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

// SPARQL 1.1 BLANK_NODE_LABEL, shared by N-Triples, N-Quads and TSV results.
const PN_CHARS_BASE =
  'A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF' +
  '\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF' +
  '\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const PN_CHARS_U = `${PN_CHARS_BASE}_`;
const PN_CHARS = `${PN_CHARS_U}\\-0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`;
const BLANK_NODE_LABEL_PATTERN = new RegExp(
  `^_:[${PN_CHARS_U}0-9](?:[${PN_CHARS}.]*[${PN_CHARS}])?$`,
  'u',
);

export function isRdfBlankNodeTerm(term: string): boolean {
  return BLANK_NODE_LABEL_PATTERN.test(term);
}
