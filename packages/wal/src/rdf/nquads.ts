import { hashWalV1Domain } from '../protocol/hashes.js';
import { rdfError } from './errors.js';
import type {
  CanonicalRdfDatasetV1,
  RdfCanonicalizationLimits,
  RdfQuadV1,
} from './types.js';

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const DEFAULT_MAXIMUM_BYTES = 1_073_741_824;
const DEFAULT_MAXIMUM_QUADS = 1_000_000;
const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const LANGUAGE_TAG = /^[A-Za-z]+(?:-[A-Za-z0-9]+)*$/;
const IRI_FORBIDDEN = /[\u0000-\u0020<>"{}|^\x60\\]/u;

export interface ParsedRdfTermV1 {
  readonly kind: 'iri' | 'literal';
  readonly canonical: string;
  readonly iri?: string;
  readonly end: number;
}

function bounded(value: number | undefined, fallback: number, name: string): number {
  const exact = value ?? fallback;
  if (!Number.isSafeInteger(exact) || exact < 0) {
    rdfError('WAL_RDF_LIMIT_EXCEEDED', name + ' must be a non-negative safe integer');
  }
  return exact;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function assertUnicodeScalarText(value: string, label: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        rdfError('WAL_RDF_INVALID_NQUADS', label + ' contains an unpaired UTF-16 surrogate');
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      rdfError('WAL_RDF_INVALID_NQUADS', label + ' contains an unpaired UTF-16 surrogate');
    }
  }
  return value.normalize('NFC');
}

function decodeUnicodeEscape(source: string, offset: number, label: string): { value: string; end: number } {
  const marker = source[offset + 1];
  const width = marker === 'u' ? 4 : marker === 'U' ? 8 : 0;
  if (width === 0) rdfError('WAL_RDF_INVALID_NQUADS', label + ' contains an invalid escape');
  const digits = source.slice(offset + 2, offset + 2 + width);
  if (digits.length !== width || !/^[0-9A-Fa-f]+$/.test(digits)) {
    rdfError('WAL_RDF_INVALID_NQUADS', label + ' contains a malformed Unicode escape');
  }
  const codePoint = Number.parseInt(digits, 16);
  if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    rdfError('WAL_RDF_INVALID_NQUADS', label + ' contains a non-scalar Unicode escape');
  }
  return { value: String.fromCodePoint(codePoint), end: offset + 2 + width };
}

function renderIri(value: string): string {
  return '<' + value + '>';
}

export function canonicalizeAbsoluteIriV1(value: string, label = 'IRI'): string {
  if (typeof value !== 'string' || value.length === 0) {
    rdfError('WAL_RDF_IRI_INVALID', label + ' must be a non-empty absolute IRI');
  }
  const normalized = assertUnicodeScalarText(value, label);
  if (!ABSOLUTE_IRI.test(normalized) || IRI_FORBIDDEN.test(normalized)) {
    rdfError('WAL_RDF_IRI_INVALID', label + ' must be an absolute RDF 1.1 IRI without forbidden characters');
  }
  return normalized;
}

function readIri(source: string, offset: number, label: string): ParsedRdfTermV1 {
  if (source[offset] !== '<') rdfError('WAL_RDF_INVALID_NQUADS', label + ' must be an IRI');
  let cursor = offset + 1;
  let value = '';
  while (cursor < source.length && source[cursor] !== '>') {
    const character = source[cursor]!;
    if (character === '\\') {
      const decoded = decodeUnicodeEscape(source, cursor, label);
      value += decoded.value;
      cursor = decoded.end;
      continue;
    }
    value += character;
    cursor += 1;
  }
  if (source[cursor] !== '>') rdfError('WAL_RDF_INVALID_NQUADS', label + ' has no closing >');
  const iri = canonicalizeAbsoluteIriV1(value, label);
  return { kind: 'iri', canonical: renderIri(iri), iri, end: cursor + 1 };
}

function renderLiteral(value: string): string {
  let output = '"';
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (character === '"') output += '\\"';
    else if (character === '\\') output += '\\\\';
    else if (character === '\t') output += '\\t';
    else if (character === '\b') output += '\\b';
    else if (character === '\n') output += '\\n';
    else if (character === '\r') output += '\\r';
    else if (character === '\f') output += '\\f';
    else if (codePoint < 0x20 || codePoint === 0x7f) {
      output += '\\u' + codePoint.toString(16).padStart(4, '0').toUpperCase();
    } else output += character;
  }
  return output + '"';
}

function readLiteral(source: string, offset: number, label: string): ParsedRdfTermV1 {
  let cursor = offset + 1;
  let value = '';
  while (cursor < source.length && source[cursor] !== '"') {
    const character = source[cursor]!;
    if (character === '\\') {
      const marker = source[cursor + 1];
      const simple: Readonly<Record<string, string>> = {
        t: '\t', b: '\b', n: '\n', r: '\r', f: '\f', '"': '"', "'": "'", '\\': '\\',
      };
      if (marker !== undefined && Object.hasOwn(simple, marker)) {
        value += simple[marker]!;
        cursor += 2;
        continue;
      }
      const decoded = decodeUnicodeEscape(source, cursor, label);
      value += decoded.value;
      cursor = decoded.end;
      continue;
    }
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      rdfError('WAL_RDF_INVALID_NQUADS', label + ' contains an unescaped control character');
    }
    value += character;
    cursor += 1;
  }
  if (source[cursor] !== '"') rdfError('WAL_RDF_INVALID_NQUADS', label + ' has no closing quote');
  cursor += 1;
  const normalized = assertUnicodeScalarText(value, label);
  let canonical = renderLiteral(normalized);
  if (source[cursor] === '@') {
    const match = /^@([A-Za-z]+(?:-[A-Za-z0-9]+)*)/.exec(source.slice(cursor));
    if (!match || !LANGUAGE_TAG.test(match[1]!)) {
      rdfError('WAL_RDF_INVALID_NQUADS', label + ' has an invalid language tag');
    }
    canonical += '@' + match[1]!.toLowerCase();
    cursor += match[0].length;
  } else if (source.slice(cursor, cursor + 2) === '^^') {
    const datatype = readIri(source, cursor + 2, label + ' datatype');
    canonical += '^^' + datatype.canonical;
    cursor = datatype.end;
  }
  return { kind: 'literal', canonical, end: cursor };
}

export function parseRdfTermV1(
  source: string,
  offset: number,
  options: { readonly allowLiteral: boolean; readonly label?: string },
): ParsedRdfTermV1 {
  const label = options.label ?? 'RDF term';
  if (source.startsWith('_:', offset)) {
    rdfError('WAL_RDF_BLANK_NODE', label + ' is a blank node; a DKG skolem IRI is required');
  }
  if (source[offset] === '<') return readIri(source, offset, label);
  if (options.allowLiteral && source[offset] === '"') return readLiteral(source, offset, label);
  rdfError('WAL_RDF_INVALID_NQUADS', label + ' has an unsupported RDF term');
}

function skipWhitespace(source: string, offset: number): number {
  let cursor = offset;
  while (cursor < source.length && /[\t ]/.test(source[cursor]!)) cursor += 1;
  return cursor;
}

function requireWhitespace(source: string, offset: number, lineNumber: number): number {
  const cursor = skipWhitespace(source, offset);
  if (cursor === offset) {
    rdfError('WAL_RDF_INVALID_NQUADS', 'line ' + lineNumber + ' must separate RDF terms with whitespace');
  }
  return cursor;
}

export function parseNQuadLineV1(source: string, lineNumber = 1): RdfQuadV1 {
  let cursor = skipWhitespace(source, 0);
  const subject = parseRdfTermV1(source, cursor, { allowLiteral: false, label: 'line ' + lineNumber + ' subject' });
  cursor = requireWhitespace(source, subject.end, lineNumber);
  const predicate = parseRdfTermV1(source, cursor, { allowLiteral: false, label: 'line ' + lineNumber + ' predicate' });
  cursor = requireWhitespace(source, predicate.end, lineNumber);
  const object = parseRdfTermV1(source, cursor, { allowLiteral: true, label: 'line ' + lineNumber + ' object' });
  cursor = requireWhitespace(source, object.end, lineNumber);
  const graph = parseRdfTermV1(source, cursor, { allowLiteral: false, label: 'line ' + lineNumber + ' graph' });
  cursor = requireWhitespace(source, graph.end, lineNumber);
  if (source[cursor] !== '.') rdfError('WAL_RDF_INVALID_NQUADS', 'line ' + lineNumber + ' must end with .');
  cursor = skipWhitespace(source, cursor + 1);
  if (cursor < source.length && source[cursor] !== '#') {
    rdfError('WAL_RDF_INVALID_NQUADS', 'line ' + lineNumber + ' contains trailing syntax');
  }
  const canonicalLine = subject.canonical + ' ' + predicate.canonical + ' ' + object.canonical + ' ' + graph.canonical + ' .';
  return {
    subject: subject.iri!,
    predicate: predicate.iri!,
    object: object.canonical,
    graph: graph.iri!,
    canonicalLine,
  };
}

function datasetFromQuads(quads: readonly RdfQuadV1[], maximumCanonicalBytes: number): CanonicalRdfDatasetV1 {
  const byLine = new Map<string, RdfQuadV1>();
  for (const quad of quads) byLine.set(quad.canonicalLine, quad);
  const ordered = [...byLine.values()].sort((left, right) => Buffer.compare(
    UTF8_ENCODER.encode(left.canonicalLine),
    UTF8_ENCODER.encode(right.canonicalLine),
  ));
  const text = ordered.length === 0 ? '' : ordered.map(quad => quad.canonicalLine).join('\n') + '\n';
  const bytes = UTF8_ENCODER.encode(text);
  if (bytes.length > maximumCanonicalBytes) {
    rdfError('WAL_RDF_LIMIT_EXCEEDED', 'canonical N-Quads exceeds ' + maximumCanonicalBytes + ' bytes');
  }
  return {
    bytes,
    text,
    quads: ordered,
    quadCount: ordered.length,
    stateDigest: hashWalV1Domain('rdfState', bytes),
  };
}

function sourceText(input: string | Uint8Array): { text: string; sourceBytes: Uint8Array } {
  if (input instanceof Uint8Array) {
    try {
      return { text: UTF8_DECODER.decode(input), sourceBytes: new Uint8Array(input) };
    } catch (error) {
      return rdfError('WAL_RDF_INVALID_NQUADS', 'N-Quads must be valid UTF-8', error);
    }
  }
  if (typeof input !== 'string') rdfError('WAL_RDF_INVALID_NQUADS', 'N-Quads input must be text or bytes');
  assertUnicodeScalarText(input, 'N-Quads input');
  return { text: input, sourceBytes: UTF8_ENCODER.encode(input) };
}

export function canonicalizeNQuadsV1(
  input: string | Uint8Array,
  limits: RdfCanonicalizationLimits = {},
): CanonicalRdfDatasetV1 {
  const maximumSourceBytes = bounded(limits.maximumSourceBytes, DEFAULT_MAXIMUM_BYTES, 'maximumSourceBytes');
  const maximumCanonicalBytes = bounded(limits.maximumCanonicalBytes, DEFAULT_MAXIMUM_BYTES, 'maximumCanonicalBytes');
  const maximumQuads = bounded(limits.maximumQuads, DEFAULT_MAXIMUM_QUADS, 'maximumQuads');
  const source = sourceText(input);
  if (source.sourceBytes.length > maximumSourceBytes) {
    rdfError('WAL_RDF_LIMIT_EXCEEDED', 'N-Quads source exceeds ' + maximumSourceBytes + ' bytes');
  }
  const normalizedLines = source.text.replace(/\r\n?/g, '\n').split('\n');
  const quads: RdfQuadV1[] = [];
  for (let index = 0; index < normalizedLines.length; index += 1) {
    const line = normalizedLines[index]!;
    const trimmed = line.trimStart();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    quads.push(parseNQuadLineV1(line, index + 1));
    if (quads.length > maximumQuads) {
      rdfError('WAL_RDF_LIMIT_EXCEEDED', 'N-Quads exceeds ' + maximumQuads + ' quads');
    }
  }
  return datasetFromQuads(quads, maximumCanonicalBytes);
}

export function requireCanonicalNQuadsV1(
  input: Uint8Array,
  limits: RdfCanonicalizationLimits = {},
): CanonicalRdfDatasetV1 {
  if (!(input instanceof Uint8Array)) rdfError('WAL_RDF_NON_CANONICAL', 'canonical N-Quads must be bytes');
  const canonical = canonicalizeNQuadsV1(input, limits);
  if (!equalBytes(input, canonical.bytes)) {
    rdfError('WAL_RDF_NON_CANONICAL', 'N-Quads bytes are not in canonical version-1 form');
  }
  return canonical;
}

export function rdfStateDigestV1(input: string | Uint8Array): Uint8Array {
  return canonicalizeNQuadsV1(input).stateDigest;
}
