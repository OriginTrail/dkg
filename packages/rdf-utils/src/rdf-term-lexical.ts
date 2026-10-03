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

/**
 * Split the canonical double-quoted RDF literal lexical form.
 *
 * This accepts exactly the terms of the pattern it replaced, and splits them
 * the same way:
 *
 *   /^"((?:[^"\\]|\\.)*)"(?:@([A-Za-z0-9-]+)|\^\^(?:<([^>]+)>|([^<].*)))?$/
 *
 * Hash canonicalization keeps a term rejected here verbatim and re-serializes
 * an accepted one, so moving this boundary in either direction changes the
 * hash of the terms that cross it.
 */
export function parseRdfLiteralLexicalTerm(term: string): RdfLiteralLexicalTerm | null {
  return parseRdfLiteralLexicalTermWith(term, false);
}

/** The characters `.` does not match in a pattern without the `s` flag. */
function isLineTerminator(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;
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
      // `\\.` in the replaced pattern: a backslash needs a character after
      // it, and that character is not a line terminator.
      if (index >= term.length || isLineTerminator(term.charCodeAt(index))) return null;
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
  // `[^<].*` in the replaced pattern: any first character, then none that is
  // a line terminator.
  for (let index = 1; index < datatype.length; index += 1) {
    if (isLineTerminator(datatype.charCodeAt(index))) return null;
  }
  return { body, suffix: { kind: 'datatype', datatype, syntax: 'bare' } };
}

export function isRdfBlankNodeTerm(term: string): boolean {
  if (!term.startsWith('_:')) return false;
  return readRawSparqlBlankNodeLabelEnd(term, 2) === term.length;
}
