import { createHash } from 'node:crypto';
import { DKGUserError } from './errors.js';
import { isSafeIri } from './sparql-safe.js';

export const JAVA_WRITE_UTF_MAX_BYTES = 65_535;
export const DKG_RDF_LITERAL_SAFE_MUTF8_BYTES = 60_000;
export const OVERSIZED_RDF_LITERAL_ERROR_CODE = 'OVERSIZED_RDF_LITERAL';

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

export interface RdfLiteralSizeContext {
  readonly label?: string;
  readonly subject?: string;
  readonly predicate?: string;
  readonly graph?: string;
  readonly maxBytes?: number;
}

export interface QuadLiteralLike {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly graph?: string;
}

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

export interface ReconstructedChunkedTextBody {
  readonly subject: string;
  readonly bodySubject: string;
  readonly sourcePredicate: string;
  readonly lexical: string;
  readonly literalTerm: string;
  readonly chunkCount: number;
  readonly lexicalSha256: string;
  readonly literalTermSha256: string;
  readonly language?: string;
  readonly datatype?: string;
}

export class OversizedRdfLiteralError extends DKGUserError {
  readonly code = OVERSIZED_RDF_LITERAL_ERROR_CODE;
  readonly actualBytes: number;
  readonly maxBytes: number;
  readonly subject?: string;
  readonly predicate?: string;
  readonly graph?: string;
  readonly label?: string;

  constructor(args: {
    actualBytes: number;
    maxBytes: number;
    label?: string;
    subject?: string;
    predicate?: string;
    graph?: string;
  }) {
    const location = describeLiteralLocation(args);
    super(
      `RDF literal${location} is ${args.actualBytes} Java MUTF-8 bytes, ` +
      `which exceeds the Blazegraph-compatible safe limit of ${args.maxBytes} bytes. ` +
      `Split large text into ordered chunks below the limit, or store the body externally ` +
      `and publish only its URI, hash, summary, and metadata.`,
    );
    this.name = 'OversizedRdfLiteralError';
    this.actualBytes = args.actualBytes;
    this.maxBytes = args.maxBytes;
    this.label = args.label;
    this.subject = args.subject;
    this.predicate = args.predicate;
    this.graph = args.graph;
  }
}

function describeLiteralLocation(args: {
  label?: string;
  subject?: string;
  predicate?: string;
  graph?: string;
}): string {
  const parts: string[] = [];
  if (args.label) parts.push(args.label);
  if (args.subject) parts.push(`subject=${truncateForMessage(args.subject)}`);
  if (args.predicate) parts.push(`predicate=${truncateForMessage(args.predicate)}`);
  if (args.graph) parts.push(`graph=${truncateForMessage(args.graph)}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function truncateForMessage(value: string): string {
  return value.length <= 120 ? value : `${value.slice(0, 117)}...`;
}

/**
 * Java Modified UTF-8 byte length using Java's UTF-16 code-unit rules.
 *
 * This intentionally differs from standard UTF-8:
 * - U+0000 is 2 bytes.
 * - U+0001 through U+007F are 1 byte.
 * - U+0080 through U+07FF are 2 bytes.
 * - All other UTF-16 code units, including surrogate halves, are 3 bytes.
 */
export function javaModifiedUtf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0) {
      bytes += 2;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x07ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export function rdfLiteralTermMutf8ByteLength(term: string): number | undefined {
  if (!term.startsWith('"')) return undefined;
  return javaModifiedUtf8ByteLength(term);
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

export function isOversizedRdfLiteralError(err: unknown): err is OversizedRdfLiteralError {
  if (err instanceof OversizedRdfLiteralError) return true;
  if (!err || typeof err !== 'object') return false;
  return (err as { code?: unknown }).code === OVERSIZED_RDF_LITERAL_ERROR_CODE;
}

export function assertRdfLiteralMutf8Safe(
  term: string,
  options: RdfLiteralSizeContext = {},
): void {
  const actualBytes = rdfLiteralTermMutf8ByteLength(term);
  if (actualBytes === undefined) return;
  const maxBytes = options.maxBytes ?? DKG_RDF_LITERAL_SAFE_MUTF8_BYTES;
  if (actualBytes <= maxBytes) return;
  throw new OversizedRdfLiteralError({
    actualBytes,
    maxBytes,
    label: options.label,
    subject: options.subject,
    predicate: options.predicate,
    graph: options.graph,
  });
}

export function assertQuadLiteralsMutf8Safe(
  quads: readonly QuadLiteralLike[],
  options: Pick<RdfLiteralSizeContext, 'label' | 'maxBytes'> = {},
): void {
  for (let i = 0; i < quads.length; i++) {
    const q = quads[i];
    assertRdfLiteralMutf8Safe(q.object, {
      maxBytes: options.maxBytes,
      label: options.label ? `${options.label}[${i}].object` : `quads[${i}].object`,
      subject: q.subject,
      predicate: q.predicate,
      graph: q.graph,
    });
  }
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

export function reconstructChunkedTextBodies(
  quads: readonly QuadLiteralLike[],
  options: { subject?: string; bodySubject?: string; sourcePredicate?: string } = {},
): ReconstructedChunkedTextBody[] {
  const bySubject = indexQuadsBySubject(quads);
  const bodyLinks = quads.filter((q) =>
    q.predicate === DKG_HAS_TEXT_BODY &&
    (!options.subject || q.subject === options.subject) &&
    (!options.bodySubject || q.object === options.bodySubject)
  );
  const explicitBody = options.bodySubject && bodyLinks.length === 0
    ? [{ subject: findOwnerSubject(quads, options.bodySubject), object: options.bodySubject }]
    : [];
  const bodies = [...bodyLinks, ...explicitBody];
  const reconstructed: ReconstructedChunkedTextBody[] = [];

  for (const link of bodies) {
    const bodySubject = link.object;
    const bodyQuads = bySubject.get(bodySubject) ?? [];
    const sourcePredicate = iriObject(bodyQuads, DKG_TEXT_SOURCE_PREDICATE);
    if (!sourcePredicate) throw new Error(`Chunked text body ${bodySubject} is missing source predicate`);
    if (options.sourcePredicate && sourcePredicate !== options.sourcePredicate) {
      continue;
    }

    const count = integerObject(bodyQuads, DKG_TEXT_CHUNK_COUNT);
    if (count === undefined) throw new Error(`Chunked text body ${bodySubject} is missing chunk count`);
    const lexicalSha256 = literalObject(bodyQuads, DKG_TEXT_CONTENT_SHA256);
    if (!lexicalSha256) throw new Error(`Chunked text body ${bodySubject} is missing content hash`);
    const literalTermSha256 = literalObject(bodyQuads, DKG_TEXT_LITERAL_TERM_SHA256);
    if (!literalTermSha256) throw new Error(`Chunked text body ${bodySubject} is missing literal term hash`);
    const language = literalObject(bodyQuads, DKG_TEXT_LANGUAGE);
    const datatype = iriObject(bodyQuads, DKG_TEXT_DATATYPE);
    const chunkSubjects = bodyQuads.filter((q) => q.predicate === DKG_HAS_TEXT_CHUNK).map((q) => q.object);
    if (chunkSubjects.length !== count) {
      throw new Error(`Chunked text body ${bodySubject} expected ${count} chunks but found ${chunkSubjects.length}`);
    }

    const chunks = chunkSubjects.map((chunkSubject) => {
      const chunkQuads = bySubject.get(chunkSubject) ?? [];
      const index = integerObject(chunkQuads, DKG_CHUNK_INDEX);
      if (index === undefined) throw new Error(`Chunk ${chunkSubject} is missing chunkIndex`);
      const valueTerm = literalTermObject(chunkQuads, DKG_CHUNK_VALUE);
      if (!valueTerm) throw new Error(`Chunk ${chunkSubject} is missing chunkValue`);
      const parsed = parseRdfLiteralTerm(valueTerm);
      if (!parsed) throw new Error(`Chunk ${chunkSubject} has invalid chunkValue`);
      return { index, lexical: parsed.lexical };
    }).sort((a, b) => a.index - b.index);

    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i]!.index !== i) {
        throw new Error(`Chunked text body ${bodySubject} has non-contiguous chunk index ${chunks[i]!.index}`);
      }
    }

    const lexical = chunks.map((chunk) => chunk.lexical).join('');
    const suffix = suffixFromMetadata(language, datatype);
    const literalTerm = rdfLiteralTerm(lexical, suffix);
    if (sha256Hex(lexical) !== lexicalSha256) {
      throw new Error(`Chunked text body ${bodySubject} content hash mismatch`);
    }
    if (sha256Hex(literalTerm) !== literalTermSha256) {
      throw new Error(`Chunked text body ${bodySubject} literal term hash mismatch`);
    }

    reconstructed.push({
      subject: link.subject,
      bodySubject,
      sourcePredicate,
      lexical,
      literalTerm,
      chunkCount: chunks.length,
      lexicalSha256,
      literalTermSha256,
      ...(language !== undefined ? { language } : {}),
      ...(datatype !== undefined ? { datatype } : {}),
    });
  }

  return reconstructed;
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

function indexQuadsBySubject(quads: readonly QuadLiteralLike[]): Map<string, QuadLiteralLike[]> {
  const map = new Map<string, QuadLiteralLike[]>();
  for (const quad of quads) {
    const list = map.get(quad.subject);
    if (list) list.push(quad);
    else map.set(quad.subject, [quad]);
  }
  return map;
}

function findOwnerSubject(quads: readonly QuadLiteralLike[], bodySubject: string): string {
  return quads.find((q) => q.predicate === DKG_HAS_TEXT_BODY && q.object === bodySubject)?.subject ?? '';
}

function literalTermObject(quads: readonly QuadLiteralLike[], predicate: string): string | undefined {
  const object = quads.find((q) => q.predicate === predicate)?.object;
  return object?.startsWith('"') ? object : undefined;
}

function literalObject(quads: readonly QuadLiteralLike[], predicate: string): string | undefined {
  const term = literalTermObject(quads, predicate);
  if (!term) return undefined;
  const parsed = parseRdfLiteralTerm(term);
  return parsed?.lexical;
}

function iriObject(quads: readonly QuadLiteralLike[], predicate: string): string | undefined {
  const object = quads.find((q) => q.predicate === predicate)?.object;
  return object && !object.startsWith('"') ? object : undefined;
}

function integerObject(quads: readonly QuadLiteralLike[], predicate: string): number | undefined {
  const value = literalObject(quads, predicate);
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}

function suffixFromMetadata(language?: string, datatype?: string): string {
  if (language) return `@${language}`;
  if (datatype) return `^^<${datatype}>`;
  return '';
}
