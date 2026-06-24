import { createHash } from 'node:crypto';

export interface RdfLiteralQuadLike {
  subject: string;
  predicate: string;
  object: string;
  graph?: string;
}

export interface ParsedRdfLiteralTerm {
  lexical: string;
  suffix: string;
}

export interface RdfLiteralRewrite {
  subject: string;
  predicate: string;
  originalMutf8Bytes: number;
  chunkCount: number;
  bodySubject: string;
  sha256: string;
}

export interface OversizedRdfLiteralViolation {
  index: number;
  subject: string;
  predicate: string;
  mutf8Bytes: number;
  maxBytes: number;
}

export interface RdfLiteralCompatibilityResult {
  quads: RdfLiteralQuadLike[];
  rewrites: RdfLiteralRewrite[];
}

export interface RdfLiteralCompatibilityOptions {
  maxLiteralMutf8Bytes?: number;
  textChunkMutf8Bytes?: number;
  textPredicates?: Iterable<string>;
}

export const BLAZEGRAPH_MUTF8_LIMIT = 65_535;
export const BLAZEGRAPH_SAFE_LITERAL_MUTF8_BYTES = 60_000;

export const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
export const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
export const SCHEMA_TEXT_PREDICATES = [
  'http://schema.org/text',
  'https://schema.org/text',
] as const;

export const DKG_TEXT_BODY = 'http://dkg.io/ontology/TextBody';
export const DKG_TEXT_CHUNK = 'http://dkg.io/ontology/TextChunk';
export const DKG_HAS_TEXT_BODY = 'http://dkg.io/ontology/hasTextBody';
export const DKG_HAS_TEXT_CHUNK = 'http://dkg.io/ontology/hasTextChunk';
export const DKG_TEXT_SOURCE_PREDICATE = 'http://dkg.io/ontology/textSourcePredicate';
export const DKG_TEXT_CONTENT_SHA256 = 'http://dkg.io/ontology/textContentSha256';
export const DKG_TEXT_LITERAL_MUTF8_BYTES = 'http://dkg.io/ontology/textLiteralMutf8Bytes';
export const DKG_TEXT_UTF8_BYTES = 'http://dkg.io/ontology/textUtf8Bytes';
export const DKG_TEXT_CHUNK_COUNT = 'http://dkg.io/ontology/textChunkCount';
export const DKG_TEXT_CHUNK_LIMIT = 'http://dkg.io/ontology/textChunkMutf8Limit';
export const DKG_CHUNK_INDEX = 'http://dkg.io/ontology/chunkIndex';

export class RdfLiteralSizeError extends Error {
  readonly code = 'RDF_LITERAL_TOO_LARGE';
  readonly statusCode = 400;

  constructor(
    message: string,
    readonly violations: OversizedRdfLiteralViolation[],
  ) {
    super(message);
    this.name = 'RdfLiteralSizeError';
  }
}

/**
 * Java Modified UTF-8 byte length of a string. Blazegraph reaches Java's
 * DataOutputStream.writeUTF() path for string keys, which hard-caps this
 * encoded length at 65,535 bytes.
 */
export function javaModifiedUtf8Length(str: string): number {
  let len = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 0) {
      len += 2;
    } else if (code <= 0x7f) {
      len += 1;
    } else if (code <= 0x7ff) {
      len += 2;
    } else {
      len += 3;
    }
  }
  return len;
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
    const body = term.slice(1, i);
    const suffix = term.slice(i + 1);
    validateLiteralSuffix(suffix);
    return {
      lexical: decodeRdfLiteralBody(body),
      suffix,
    };
  }
  return null;
}

export function normalizeLargeRdfLiteralsForBlazegraph(
  quads: readonly RdfLiteralQuadLike[],
  options: RdfLiteralCompatibilityOptions = {},
): RdfLiteralCompatibilityResult {
  const maxBytes = options.maxLiteralMutf8Bytes ?? BLAZEGRAPH_SAFE_LITERAL_MUTF8_BYTES;
  const chunkMaxBytes = options.textChunkMutf8Bytes ?? maxBytes;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > BLAZEGRAPH_MUTF8_LIMIT) {
    throw new Error(`Invalid maxLiteralMutf8Bytes: ${maxBytes}`);
  }
  if (!Number.isInteger(chunkMaxBytes) || chunkMaxBytes <= 0 || chunkMaxBytes > maxBytes) {
    throw new Error(`Invalid textChunkMutf8Bytes: ${chunkMaxBytes}`);
  }

  const textPredicates = new Set(options.textPredicates ?? SCHEMA_TEXT_PREDICATES);
  const out: RdfLiteralQuadLike[] = [];
  const rewrites: RdfLiteralRewrite[] = [];
  const violations: OversizedRdfLiteralViolation[] = [];

  quads.forEach((quad, index) => {
    if (!quad.object.startsWith('"')) {
      out.push({ ...quad });
      return;
    }

    const mutf8Bytes = javaModifiedUtf8Length(quad.object);
    if (mutf8Bytes <= maxBytes) {
      out.push({ ...quad });
      return;
    }

    if (!textPredicates.has(quad.predicate)) {
      violations.push(violationFor(index, quad, mutf8Bytes, maxBytes));
      return;
    }

    let parsed: ParsedRdfLiteralTerm | null;
    try {
      parsed = parseRdfLiteralTerm(quad.object);
    } catch {
      parsed = null;
    }
    if (!parsed) {
      violations.push(violationFor(index, quad, mutf8Bytes, maxBytes));
      return;
    }

    let chunks: string[];
    try {
      chunks = splitLiteralLexicalIntoSafeChunks(parsed.lexical, parsed.suffix, chunkMaxBytes);
    } catch {
      violations.push(violationFor(index, quad, mutf8Bytes, maxBytes));
      return;
    }
    const chunkTerms = chunks.map((chunk) => rdfLiteralTerm(chunk, parsed.suffix));
    const unsafeChunk = chunkTerms.find((term) => javaModifiedUtf8Length(term) > maxBytes);
    if (unsafeChunk) {
      violations.push({
        ...violationFor(index, quad, javaModifiedUtf8Length(unsafeChunk), maxBytes),
        predicate: `${quad.predicate} chunk`,
      });
      return;
    }

    const sha256 = createHash('sha256').update(parsed.lexical, 'utf8').digest('hex');
    const bodySubject = `${quad.subject}/.well-known/genid/text-${sha256.slice(0, 16)}`;
    const graph = quad.graph ?? '';
    out.push(
      { subject: quad.subject, predicate: DKG_HAS_TEXT_BODY, object: bodySubject, graph },
      { subject: bodySubject, predicate: RDF_TYPE, object: DKG_TEXT_BODY, graph },
      { subject: bodySubject, predicate: DKG_TEXT_SOURCE_PREDICATE, object: quad.predicate, graph },
      { subject: bodySubject, predicate: DKG_TEXT_CONTENT_SHA256, object: rdfLiteralTerm(sha256), graph },
      { subject: bodySubject, predicate: DKG_TEXT_LITERAL_MUTF8_BYTES, object: xsdInteger(mutf8Bytes), graph },
      {
        subject: bodySubject,
        predicate: DKG_TEXT_UTF8_BYTES,
        object: xsdInteger(new TextEncoder().encode(parsed.lexical).length),
        graph,
      },
      { subject: bodySubject, predicate: DKG_TEXT_CHUNK_COUNT, object: xsdInteger(chunks.length), graph },
      { subject: bodySubject, predicate: DKG_TEXT_CHUNK_LIMIT, object: xsdInteger(chunkMaxBytes), graph },
    );

    chunkTerms.forEach((term, chunkIndex) => {
      const chunkSubject = `${bodySubject}/chunk/${chunkIndex}`;
      out.push(
        { subject: bodySubject, predicate: DKG_HAS_TEXT_CHUNK, object: chunkSubject, graph },
        { subject: chunkSubject, predicate: RDF_TYPE, object: DKG_TEXT_CHUNK, graph },
        { subject: chunkSubject, predicate: DKG_CHUNK_INDEX, object: xsdInteger(chunkIndex), graph },
        { subject: chunkSubject, predicate: quad.predicate, object: term, graph },
      );
    });

    rewrites.push({
      subject: quad.subject,
      predicate: quad.predicate,
      originalMutf8Bytes: mutf8Bytes,
      chunkCount: chunks.length,
      bodySubject,
      sha256,
    });
  });

  const remainingViolations = out
    .map((quad, index) => ({ quad, index, bytes: quad.object.startsWith('"') ? javaModifiedUtf8Length(quad.object) : 0 }))
    .filter(({ bytes }) => bytes > maxBytes)
    .map(({ quad, index, bytes }) => violationFor(index, quad, bytes, maxBytes));
  violations.push(...remainingViolations);

  if (violations.length > 0) {
    throw new RdfLiteralSizeError(formatOversizedLiteralMessage(violations), violations);
  }

  return { quads: out, rewrites };
}

function splitLiteralLexicalIntoSafeChunks(lexical: string, suffix: string, maxBytes: number): string[] {
  const baseBytes = javaModifiedUtf8Length(`""${suffix}`);
  if (baseBytes >= maxBytes) {
    throw new Error(`Literal suffix consumes the full MUTF-8 budget (${baseBytes} bytes)`);
  }
  const chunks: string[] = [];
  let current = '';
  let currentBodyBytes = 0;
  for (const ch of lexical) {
    const chBytes = escapedLiteralBodyMutf8Length(ch);
    if (current.length > 0 && baseBytes + currentBodyBytes + chBytes > maxBytes) {
      chunks.push(current);
      current = ch;
      currentBodyBytes = chBytes;
      continue;
    }
    if (current.length === 0 && baseBytes + chBytes > maxBytes) {
      throw new Error(`A single literal character exceeds the MUTF-8 budget (${chBytes} bytes)`);
    }
    current += ch;
    currentBodyBytes += chBytes;
  }
  if (current.length > 0 || lexical.length === 0) chunks.push(current);
  return chunks;
}

function escapedLiteralBodyMutf8Length(ch: string): number {
  const escaped = JSON.stringify(ch).slice(1, -1);
  return javaModifiedUtf8Length(escaped);
}

function rdfLiteralTerm(lexical: string, suffix = ''): string {
  return `${JSON.stringify(lexical)}${suffix}`;
}

function xsdInteger(value: number): string {
  return `"${value}"^^<${XSD_INTEGER}>`;
}

function violationFor(
  index: number,
  quad: RdfLiteralQuadLike,
  mutf8Bytes: number,
  maxBytes: number,
): OversizedRdfLiteralViolation {
  return {
    index,
    subject: quad.subject,
    predicate: quad.predicate,
    mutf8Bytes,
    maxBytes,
  };
}

function formatOversizedLiteralMessage(violations: readonly OversizedRdfLiteralViolation[]): string {
  const details = violations
    .slice(0, 5)
    .map((v) =>
      `index=${v.index} subject=${v.subject.slice(0, 120)} predicate=${v.predicate.slice(0, 120)} ` +
      `(${v.mutf8Bytes} MUTF-8 bytes, max ${v.maxBytes})`,
    )
    .join('; ');
  const suffix = violations.length > 5 ? `; +${violations.length - 5} more` : '';
  return `Invalid RDF literal: ${violations.length} literal object(s) exceed the Blazegraph-safe MUTF-8 limit. ` +
    `Use schema.org/text chunking or external content references before publishing. ${details}${suffix}`;
}

function validateLiteralSuffix(suffix: string): void {
  if (suffix === '') return;
  if (/^@[A-Za-z]+(?:-[A-Za-z0-9]+)*$/.test(suffix)) return;
  if (/^\^\^<[^<>"{}|\\^`\x00-\x20>]+>$/.test(suffix)) return;
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
        out += String.fromCodePoint(parseInt(hex, 16));
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
