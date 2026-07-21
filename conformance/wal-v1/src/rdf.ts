import { compareBytes, hash, utf8 } from './bytes.js';
import { encodeCanonical } from './cbor.js';
import { DOMAINS } from './schema.js';

const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const FORBIDDEN_IRI = /[\u0000-\u0020<>"{}|^\x60\\]/u;

type Term = { readonly canonical: string; readonly iri?: string; readonly end: number };

function unicodeEscape(source: string, offset: number): { readonly value: string; readonly end: number } {
  const marker = source[offset + 1];
  const width = marker === 'u' ? 4 : marker === 'U' ? 8 : 0;
  if (width === 0) throw new Error('invalid RDF escape');
  const digits = source.slice(offset + 2, offset + 2 + width);
  if (digits.length !== width || !/^[0-9A-Fa-f]+$/.test(digits)) throw new Error('malformed RDF escape');
  const point = Number.parseInt(digits, 16);
  if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) throw new Error('non-scalar RDF escape');
  return { value: String.fromCodePoint(point), end: offset + 2 + width };
}

function iri(value: string): string {
  const normalized = value.normalize('NFC');
  if (!ABSOLUTE_IRI.test(normalized) || FORBIDDEN_IRI.test(normalized)) throw new Error('invalid absolute IRI');
  return normalized;
}

function readIri(source: string, offset: number): Term {
  if (source[offset] !== '<') throw new Error('expected IRI');
  let cursor = offset + 1;
  let value = '';
  while (cursor < source.length && source[cursor] !== '>') {
    if (source[cursor] === '\\') {
      const decoded = unicodeEscape(source, cursor);
      value += decoded.value;
      cursor = decoded.end;
    } else {
      value += source[cursor];
      cursor += 1;
    }
  }
  if (source[cursor] !== '>') throw new Error('unterminated IRI');
  const normalized = iri(value);
  return { canonical: `<${normalized}>`, iri: normalized, end: cursor + 1 };
}

function renderLiteral(value: string): string {
  let output = '"';
  for (const character of value.normalize('NFC')) {
    if (character === '"') output += '\\"';
    else if (character === '\\') output += '\\\\';
    else if (character === '\t') output += '\\t';
    else if (character === '\b') output += '\\b';
    else if (character === '\n') output += '\\n';
    else if (character === '\r') output += '\\r';
    else if (character === '\f') output += '\\f';
    else output += character;
  }
  return output + '"';
}

function readLiteral(source: string, offset: number): Term {
  let cursor = offset + 1;
  let value = '';
  const simple: Readonly<Record<string, string>> = {
    t: '\t', b: '\b', n: '\n', r: '\r', f: '\f', '"': '"', "'": "'", '\\': '\\',
  };
  while (cursor < source.length && source[cursor] !== '"') {
    if (source[cursor] === '\\') {
      const marker = source[cursor + 1];
      if (marker !== undefined && Object.hasOwn(simple, marker)) {
        value += simple[marker];
        cursor += 2;
      } else {
        const decoded = unicodeEscape(source, cursor);
        value += decoded.value;
        cursor = decoded.end;
      }
    } else {
      value += source[cursor];
      cursor += 1;
    }
  }
  if (source[cursor] !== '"') throw new Error('unterminated literal');
  cursor += 1;
  let canonical = renderLiteral(value);
  if (source[cursor] === '@') {
    const language = /^@([A-Za-z]+(?:-[A-Za-z0-9]+)*)/.exec(source.slice(cursor));
    if (!language) throw new Error('invalid language');
    canonical += `@${language[1].toLowerCase()}`;
    cursor += language[0].length;
  } else if (source.slice(cursor, cursor + 2) === '^^') {
    const datatype = readIri(source, cursor + 2);
    canonical += `^^${datatype.canonical}`;
    cursor = datatype.end;
  }
  return { canonical, end: cursor };
}

function whitespace(source: string, offset: number): number {
  let cursor = offset;
  while (cursor < source.length && /[\t ]/.test(source[cursor])) cursor += 1;
  if (cursor === offset) throw new Error('missing RDF whitespace');
  return cursor;
}

function line(source: string): string {
  let cursor = source.length - source.trimStart().length;
  if (source.startsWith('_:', cursor)) throw new Error('blank node');
  const subject = readIri(source, cursor);
  cursor = whitespace(source, subject.end);
  const predicate = readIri(source, cursor);
  cursor = whitespace(source, predicate.end);
  if (source.startsWith('_:', cursor)) throw new Error('blank node');
  const object = source[cursor] === '<' ? readIri(source, cursor) : readLiteral(source, cursor);
  cursor = whitespace(source, object.end);
  const graph = readIri(source, cursor);
  cursor = whitespace(source, graph.end);
  if (source[cursor] !== '.') throw new Error('missing RDF dot');
  cursor += 1;
  while (cursor < source.length && /[\t ]/.test(source[cursor])) cursor += 1;
  if (cursor < source.length && source[cursor] !== '#') throw new Error('trailing RDF syntax');
  return `${subject.canonical} ${predicate.canonical} ${object.canonical} ${graph.canonical} .`;
}

export function independentCanonicalNQuads(source: string): Uint8Array {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
    .filter((value) => value.trim().length !== 0 && !value.trimStart().startsWith('#'))
    .map(line);
  const unique = [...new Set(lines)].map((value) => ({ value, bytes: utf8(value) }));
  unique.sort((left, right) => compareBytes(left.bytes, right.bytes));
  return utf8(unique.length === 0 ? '' : `${unique.map((value) => value.value).join('\n')}\n`);
}

export function independentRdfStateDigest(canonicalNQuads: Uint8Array): Uint8Array {
  return hash(DOMAINS.rdfState, canonicalNQuads);
}

export function independentRdfLogicalKey(input: {
  readonly contextGraphId: string;
  readonly subGraphName: string | null;
  readonly authorAddress: Uint8Array;
  readonly entity: string;
}): Uint8Array {
  return hash(DOMAINS.logicalKey, encodeCanonical([
    input.contextGraphId,
    input.subGraphName,
    input.authorAddress,
    iri(input.entity),
  ]));
}

export function independentRdfTouchedKey(graph: string, subject: string, predicate: string): Uint8Array {
  return hash(DOMAINS.touchedKey, encodeCanonical([iri(graph), iri(subject), iri(predicate)]));
}
