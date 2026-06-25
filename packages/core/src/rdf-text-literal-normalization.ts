import { createHash } from 'node:crypto';
import {
  DKG_RDF_LITERAL_SAFE_MUTF8_BYTES,
  JAVA_WRITE_UTF_MAX_BYTES,
  OversizedRdfLiteralError,
  assertQuadLiteralsMutf8Safe,
  javaModifiedUtf8ByteLength,
  rdfLiteralTermMutf8ByteLength,
  type QuadLiteralLike,
} from './rdf-literal-size.js';
import { isSafeIri } from './sparql-safe.js';

export const RDF_TYPE_IRI = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
export const XSD_INTEGER_IRI = 'http://www.w3.org/2001/XMLSchema#integer';
export const XSD_STRING_IRI = 'http://www.w3.org/2001/XMLSchema#string';
export const SCHEMA_TEXT_PREDICATES = [
  'http://schema.org/text',
  'https://schema.org/text',
] as const;

export const DKG_TEXT_BODY_CLASS = 'http://dkg.io/ontology/TextBody';
export const DKG_TEXT_CHUNK_CLASS = 'http://dkg.io/ontology/TextChunk';
export const DKG_HAS_TEXT_BODY = 'http://dkg.io/ontology/hasTextBody';
export const DKG_HAS_TEXT_CHUNK = 'http://dkg.io/ontology/hasTextChunk';
export const DKG_TEXT_SOURCE_PREDICATE = 'http://dkg.io/ontology/textSourcePredicate';
export const DKG_TEXT_CONTENT_SHA256 = 'http://dkg.io/ontology/textContentSha256';
export const DKG_TEXT_LITERAL_TERM_SHA256 = 'http://dkg.io/ontology/textLiteralTermSha256';
export const DKG_TEXT_LITERAL_MUTF8_BYTES = 'http://dkg.io/ontology/textLiteralMutf8Bytes';
export const DKG_TEXT_UTF8_BYTES = 'http://dkg.io/ontology/textUtf8Bytes';
export const DKG_TEXT_CHUNK_COUNT = 'http://dkg.io/ontology/textChunkCount';
export const DKG_TEXT_CHUNK_LIMIT = 'http://dkg.io/ontology/textChunkMutf8Limit';
export const DKG_TEXT_LANGUAGE = 'http://dkg.io/ontology/textLanguage';
export const DKG_TEXT_DATATYPE = 'http://dkg.io/ontology/textDatatype';
export const DKG_CHUNK_INDEX = 'http://dkg.io/ontology/chunkIndex';
export const DKG_CHUNK_VALUE = 'http://dkg.io/ontology/chunkValue';

export interface ParsedRdfLiteralTerm {
  readonly lexical: string;
  readonly suffix: string;
  readonly language?: string;
  readonly datatype?: string;
}

export interface RdfTextLiteralRewrite {
  readonly subject: string;
  readonly predicate: string;
  readonly graph?: string;
  readonly bodySubject: string;
  readonly originalMutf8Bytes: number;
  readonly originalUtf8Bytes: number;
  readonly chunkCount: number;
  readonly lexicalSha256: string;
  readonly literalTermSha256: string;
}

export interface RdfLiteralNormalizationResult {
  readonly quads: QuadLiteralLike[];
  readonly rewrites: RdfTextLiteralRewrite[];
}

export interface RdfLiteralNormalizationOptions {
  readonly maxBytes?: number;
  readonly chunkMaxBytes?: number;
  readonly textPredicates?: Iterable<string>;
  readonly label?: string;
}

export function parseRdfLiteralTerm(term: string): ParsedRdfLiteralTerm | null {
  if (!term.startsWith('"')) return null;
  let escaped = false;
  for (let i = 1; i < term.length; i++) {
    const ch = term[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch !== '"') continue;

    try {
      const body = term.slice(1, i);
      const suffix = term.slice(i + 1);
      const metadata = parseLiteralSuffix(suffix);
      return {
        lexical: decodeRdfLiteralBody(body),
        suffix,
        ...metadata,
      };
    } catch {
      return null;
    }
  }
  return null;
}

export function normalizeLargeRdfLiteralsForBlazegraph(
  quads: readonly QuadLiteralLike[],
  options: RdfLiteralNormalizationOptions = {},
): RdfLiteralNormalizationResult {
  const maxBytes = options.maxBytes ?? DKG_RDF_LITERAL_SAFE_MUTF8_BYTES;
  const chunkMaxBytes = options.chunkMaxBytes ?? maxBytes;
  validateNormalizationLimits(maxBytes, chunkMaxBytes);

  const textPredicates = new Set(options.textPredicates ?? SCHEMA_TEXT_PREDICATES);
  const normalized: QuadLiteralLike[] = [];
  const rewrites: RdfTextLiteralRewrite[] = [];

  for (let i = 0; i < quads.length; i++) {
    const quad = quads[i]!;
    const literalBytes = rdfLiteralTermMutf8ByteLength(quad.object);
    if (literalBytes === undefined || literalBytes <= maxBytes) {
      normalized.push({ ...quad });
      continue;
    }

    if (!textPredicates.has(quad.predicate)) {
      throwOversizedForQuad(quad, literalBytes, maxBytes, labelFor(options.label, i));
    }

    const parsed = parseRdfLiteralTerm(quad.object);
    if (!parsed || !isChunkableTextLiteral(parsed)) {
      throwOversizedForQuad(quad, literalBytes, maxBytes, labelFor(options.label, i));
    }
    if (!isSafeIri(quad.subject)) {
      throwOversizedForQuad(quad, literalBytes, maxBytes, labelFor(options.label, i));
    }

    const canonicalLiteralTerm = rdfLiteralTerm(parsed.lexical, parsed.suffix);
    const literalTermSha256 = sha256Hex(canonicalLiteralTerm);
    const lexicalSha256 = sha256Hex(parsed.lexical);
    const bodyIdentitySha256 = sha256Hex(`${quad.predicate}\u0000${canonicalLiteralTerm}`);
    const bodySubject = `${quad.subject}/.well-known/genid/dkg-text-body-${bodyIdentitySha256}`;
    if (!isSafeIri(bodySubject)) {
      throwOversizedForQuad(quad, literalBytes, maxBytes, labelFor(options.label, i));
    }

    const chunks = splitLexicalIntoSafeChunks(parsed.lexical, chunkMaxBytes);
    const graph = quad.graph ?? '';
    const bodyQuads = buildTextBodyQuads({
      source: quad,
      graph,
      bodySubject,
      parsed,
      chunks,
      maxBytes,
      chunkMaxBytes,
      originalMutf8Bytes: literalBytes,
      lexicalSha256,
      literalTermSha256,
    });
    normalized.push(...bodyQuads);
    rewrites.push({
      subject: quad.subject,
      predicate: quad.predicate,
      graph: quad.graph,
      bodySubject,
      originalMutf8Bytes: literalBytes,
      originalUtf8Bytes: utf8ByteLength(parsed.lexical),
      chunkCount: chunks.length,
      lexicalSha256,
      literalTermSha256,
    });
  }

  assertQuadLiteralsMutf8Safe(normalized, {
    label: options.label ? `${options.label}.normalized` : 'normalizedQuads',
    maxBytes,
  });
  return { quads: normalized, rewrites };
}

function validateNormalizationLimits(maxBytes: number, chunkMaxBytes: number): void {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > JAVA_WRITE_UTF_MAX_BYTES) {
    throw new Error(`Invalid maxBytes: ${maxBytes}`);
  }
  if (!Number.isInteger(chunkMaxBytes) || chunkMaxBytes <= 0 || chunkMaxBytes > maxBytes) {
    throw new Error(`Invalid chunkMaxBytes: ${chunkMaxBytes}`);
  }
}

function labelFor(label: string | undefined, index: number): string {
  return label ? `${label}[${index}].object` : `quads[${index}].object`;
}

function throwOversizedForQuad(
  quad: QuadLiteralLike,
  actualBytes: number,
  maxBytes: number,
  label: string,
): never {
  throw new OversizedRdfLiteralError({
    actualBytes,
    maxBytes,
    label,
    subject: quad.subject,
    predicate: quad.predicate,
    graph: quad.graph,
  });
}

function buildTextBodyQuads(args: {
  source: QuadLiteralLike;
  graph: string;
  bodySubject: string;
  parsed: ParsedRdfLiteralTerm;
  chunks: readonly string[];
  maxBytes: number;
  chunkMaxBytes: number;
  originalMutf8Bytes: number;
  lexicalSha256: string;
  literalTermSha256: string;
}): QuadLiteralLike[] {
  const quads: QuadLiteralLike[] = [
    { subject: args.source.subject, predicate: DKG_HAS_TEXT_BODY, object: args.bodySubject, graph: args.graph },
    { subject: args.bodySubject, predicate: RDF_TYPE_IRI, object: DKG_TEXT_BODY_CLASS, graph: args.graph },
    { subject: args.bodySubject, predicate: DKG_TEXT_SOURCE_PREDICATE, object: args.source.predicate, graph: args.graph },
    { subject: args.bodySubject, predicate: DKG_TEXT_CONTENT_SHA256, object: rdfLiteralTerm(args.lexicalSha256), graph: args.graph },
    { subject: args.bodySubject, predicate: DKG_TEXT_LITERAL_TERM_SHA256, object: rdfLiteralTerm(args.literalTermSha256), graph: args.graph },
    { subject: args.bodySubject, predicate: DKG_TEXT_LITERAL_MUTF8_BYTES, object: xsdInteger(args.originalMutf8Bytes), graph: args.graph },
    { subject: args.bodySubject, predicate: DKG_TEXT_UTF8_BYTES, object: xsdInteger(utf8ByteLength(args.parsed.lexical)), graph: args.graph },
    { subject: args.bodySubject, predicate: DKG_TEXT_CHUNK_COUNT, object: xsdInteger(args.chunks.length), graph: args.graph },
    { subject: args.bodySubject, predicate: DKG_TEXT_CHUNK_LIMIT, object: xsdInteger(args.chunkMaxBytes), graph: args.graph },
  ];

  if (args.parsed.language) {
    quads.push({ subject: args.bodySubject, predicate: DKG_TEXT_LANGUAGE, object: rdfLiteralTerm(args.parsed.language), graph: args.graph });
  }
  if (args.parsed.datatype) {
    quads.push({ subject: args.bodySubject, predicate: DKG_TEXT_DATATYPE, object: args.parsed.datatype, graph: args.graph });
  }

  args.chunks.forEach((chunk, index) => {
    const chunkSubject = `${args.bodySubject}/chunk-${index}`;
    if (!isSafeIri(chunkSubject)) {
      throw new OversizedRdfLiteralError({
        actualBytes: args.originalMutf8Bytes,
        maxBytes: args.maxBytes,
        subject: args.source.subject,
        predicate: args.source.predicate,
        graph: args.source.graph,
      });
    }
    quads.push(
      { subject: args.bodySubject, predicate: DKG_HAS_TEXT_CHUNK, object: chunkSubject, graph: args.graph },
      { subject: chunkSubject, predicate: RDF_TYPE_IRI, object: DKG_TEXT_CHUNK_CLASS, graph: args.graph },
      { subject: chunkSubject, predicate: DKG_CHUNK_INDEX, object: xsdInteger(index), graph: args.graph },
      { subject: chunkSubject, predicate: DKG_CHUNK_VALUE, object: rdfLiteralTerm(chunk), graph: args.graph },
    );
  });

  return quads;
}

function isChunkableTextLiteral(parsed: ParsedRdfLiteralTerm): boolean {
  return parsed.suffix === '' ||
    parsed.language !== undefined ||
    parsed.datatype === XSD_STRING_IRI;
}

function splitLexicalIntoSafeChunks(lexical: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = '';
  let currentBytes = javaModifiedUtf8ByteLength('""');

  for (const ch of lexical) {
    const chBytes = serializedLiteralBodyMutf8ByteLength(ch);
    if (current.length > 0 && currentBytes + chBytes > maxBytes) {
      chunks.push(current);
      current = ch;
      currentBytes = javaModifiedUtf8ByteLength('""') + chBytes;
    } else {
      current += ch;
      currentBytes += chBytes;
    }

    if (currentBytes > maxBytes) {
      throw new Error('A single literal character exceeds the MUTF-8 chunk budget');
    }
  }

  if (current.length > 0 || lexical.length === 0) chunks.push(current);
  return chunks;
}

function serializedLiteralBodyMutf8ByteLength(value: string): number {
  const serialized = JSON.stringify(value);
  return javaModifiedUtf8ByteLength(serialized.slice(1, -1));
}

function parseLiteralSuffix(suffix: string): { language?: string; datatype?: string } {
  if (suffix === '') return {};
  const language = /^@([A-Za-z]+(?:-[A-Za-z0-9]+)*)$/.exec(suffix);
  if (language) return { language: language[1] };
  const datatype = /^\^\^<([^<>"{}|\\^`\x00-\x20>]+)>$/.exec(suffix);
  if (datatype) return { datatype: datatype[1] };
  throw new Error(`Invalid RDF literal suffix: ${suffix.slice(0, 80)}`);
}

function decodeRdfLiteralBody(body: string): string {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    i += 1;
    if (i >= body.length) throw new Error('Invalid trailing RDF literal escape');
    const escaped = body[i]!;
    switch (escaped) {
      case 't':
        out += '\t';
        break;
      case 'b':
        out += '\b';
        break;
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case 'f':
        out += '\f';
        break;
      case '"':
      case "'":
      case '\\':
        out += escaped;
        break;
      case 'u': {
        const hex = body.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('Invalid RDF \\u escape');
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
        break;
      }
      case 'U': {
        const hex = body.slice(i + 1, i + 9);
        if (!/^[0-9a-fA-F]{8}$/.test(hex)) throw new Error('Invalid RDF \\U escape');
        out += String.fromCodePoint(parseInt(hex, 16));
        i += 8;
        break;
      }
      default:
        throw new Error(`Invalid RDF literal escape: \\${escaped}`);
    }
  }
  return out;
}

function rdfLiteralTerm(lexical: string, suffix = ''): string {
  return `${JSON.stringify(lexical)}${suffix}`;
}

function xsdInteger(value: number): string {
  return `"${value}"^^<${XSD_INTEGER_IRI}>`;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
