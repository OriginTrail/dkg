import { createHash } from 'node:crypto';
import {
  DKG_CHUNK_INDEX,
  DKG_CHUNK_VALUE,
  DKG_HAS_TEXT_BODY,
  DKG_HAS_TEXT_CHUNK,
  DKG_TEXT_CHUNK_COUNT,
  DKG_TEXT_CONTENT_SHA256,
  DKG_TEXT_DATATYPE,
  DKG_TEXT_LANGUAGE,
  DKG_TEXT_LITERAL_TERM_SHA256,
  DKG_TEXT_SOURCE_PREDICATE,
  parseRdfLiteralTerm,
  rdfLiteralTerm,
} from '../../src/rdf-text-literal-normalization.js';

export interface ChunkedTextQuad {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly graph?: string;
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

export function reconstructChunkedText(
  quads: readonly ChunkedTextQuad[],
  subject: string,
): string {
  const reconstructed = reconstructChunkedTextBodies(quads, { subject });
  if (reconstructed.length === 0) throw new Error(`Missing chunked text body for ${subject}`);
  return reconstructed[0]!.lexical;
}

export function reconstructChunkedTextBodies(
  quads: readonly ChunkedTextQuad[],
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
    const currentBodySubject = link.object;
    const bodyQuads = bySubject.get(currentBodySubject) ?? [];
    const sourcePredicate = iriObject(bodyQuads, DKG_TEXT_SOURCE_PREDICATE);
    if (!sourcePredicate) throw new Error(`Chunked text body ${currentBodySubject} is missing source predicate`);
    if (options.sourcePredicate && sourcePredicate !== options.sourcePredicate) continue;

    const count = integerObject(bodyQuads, DKG_TEXT_CHUNK_COUNT);
    if (count === undefined) throw new Error(`Chunked text body ${currentBodySubject} is missing chunk count`);
    const lexicalSha256 = literalObject(bodyQuads, DKG_TEXT_CONTENT_SHA256);
    if (!lexicalSha256) throw new Error(`Chunked text body ${currentBodySubject} is missing content hash`);
    const literalTermSha256 = literalObject(bodyQuads, DKG_TEXT_LITERAL_TERM_SHA256);
    if (!literalTermSha256) throw new Error(`Chunked text body ${currentBodySubject} is missing literal term hash`);
    const language = literalObject(bodyQuads, DKG_TEXT_LANGUAGE);
    const datatype = iriObject(bodyQuads, DKG_TEXT_DATATYPE);
    const chunkSubjects = bodyQuads.filter((q) => q.predicate === DKG_HAS_TEXT_CHUNK).map((q) => q.object);
    if (chunkSubjects.length !== count) {
      throw new Error(`Chunked text body ${currentBodySubject} expected ${count} chunks but found ${chunkSubjects.length}`);
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
        throw new Error(`Chunked text body ${currentBodySubject} has non-contiguous chunk index ${chunks[i]!.index}`);
      }
    }

    const lexical = chunks.map((chunk) => chunk.lexical).join('');
    const suffix = suffixFromMetadata(language, datatype);
    const literalTerm = rdfLiteralTerm(lexical, suffix);
    if (sha256Hex(lexical) !== lexicalSha256) {
      throw new Error(`Chunked text body ${currentBodySubject} content hash mismatch`);
    }
    if (sha256Hex(literalTerm) !== literalTermSha256) {
      throw new Error(`Chunked text body ${currentBodySubject} literal term hash mismatch`);
    }

    reconstructed.push({
      subject: link.subject,
      bodySubject: currentBodySubject,
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

function indexQuadsBySubject(quads: readonly ChunkedTextQuad[]): Map<string, ChunkedTextQuad[]> {
  const map = new Map<string, ChunkedTextQuad[]>();
  for (const quad of quads) {
    const list = map.get(quad.subject);
    if (list) list.push(quad);
    else map.set(quad.subject, [quad]);
  }
  return map;
}

function findOwnerSubject(quads: readonly ChunkedTextQuad[], bodySubject: string): string {
  return quads.find((q) => q.predicate === DKG_HAS_TEXT_BODY && q.object === bodySubject)?.subject ?? '';
}

function literalTermObject(quads: readonly ChunkedTextQuad[], predicate: string): string | undefined {
  const object = quads.find((q) => q.predicate === predicate)?.object;
  return object?.startsWith('"') ? object : undefined;
}

function literalObject(quads: readonly ChunkedTextQuad[], predicate: string): string | undefined {
  const term = literalTermObject(quads, predicate);
  if (!term) return undefined;
  const parsed = parseRdfLiteralTerm(term);
  return parsed?.lexical;
}

function iriObject(quads: readonly ChunkedTextQuad[], predicate: string): string | undefined {
  const object = quads.find((q) => q.predicate === predicate)?.object;
  return object && !object.startsWith('"') ? object : undefined;
}

function integerObject(quads: readonly ChunkedTextQuad[], predicate: string): number | undefined {
  const value = literalObject(quads, predicate);
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}

function suffixFromMetadata(language?: string, datatype?: string): string {
  if (language) return `@${language}`;
  if (datatype) return `^^<${datatype}>`;
  return '';
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
