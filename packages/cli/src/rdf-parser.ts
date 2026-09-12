import { formatCanonicalRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import { Parser, type Quad as N3Quad } from 'n3';
import type { JsonLdDocument, Options as JsonLdOptions } from 'jsonld';

export interface SimpleQuad {
  subject: string;
  predicate: string;
  object: string;
  graph: string;
}

/** Neutral syntax provenance; consumers own policies for the resulting dataset. */
export interface ParsedRdf {
  sourceKind: 'jsonld' | 'legacy-quads' | 'rdf';
  quads: SimpleQuad[];
}

export type RdfFormat = 'nquads' | 'ntriples' | 'turtle' | 'trig' | 'json' | 'jsonld';

const EXTENSION_MAP: Record<string, RdfFormat> = {
  '.nq': 'nquads',
  '.nt': 'ntriples',
  '.ttl': 'turtle',
  '.trig': 'trig',
  '.json': 'json',
  '.jsonld': 'jsonld',
};

const N3_FORMAT_MAP: Record<string, string> = {
  nquads: 'N-Quads',
  ntriples: 'N-Triples',
  turtle: 'Turtle',
  trig: 'TriG',
};

export function detectFormat(filePath: string): RdfFormat {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return EXTENSION_MAP[ext] ?? 'json';
}

export function supportedExtensions(): string[] {
  return Object.keys(EXTENSION_MAP);
}

/**
 * Parse RDF content in any supported W3C format into simple quads.
 * For formats without named graph support (N-Triples, Turtle),
 * the defaultGraph is used.
 */
export async function parseRdfInput(
  content: string,
  format: RdfFormat,
  defaultGraph: string,
  baseIRI?: string,
): Promise<ParsedRdf> {
  if (format === 'json' || format === 'jsonld') {
    const parsed: unknown = JSON.parse(content);
    const legacy = decodeLegacyQuads(
      format === 'json' && isRecord(parsed) ? parsed.quads : parsed,
      defaultGraph,
    );
    if (legacy) return { sourceKind: 'legacy-quads', quads: legacy };
    if (format === 'json') throw new Error('JSON input must contain an array of subject/predicate/object quads');
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error('JSON-LD input must be an object or array');
    }
    const { default: jsonld } = await import('jsonld');
    const remoteContextError = new Error('Remote JSON-LD contexts are disabled; embed an inline @context before ingesting the file');
    let remoteLoadAttempted = false;
    // jsonld.js 8 supports safe mode; the older upstream declaration omits it.
    const options: JsonLdOptions.ToRdf & { safe: true } = {
      format: 'application/n-quads',
      base: baseIRI,
      safe: true,
      documentLoader: async () => {
        remoteLoadAttempted = true;
        throw remoteContextError;
      },
    };
    let nquads: object | string;
    try {
      // jsonld.js validates the JSON-LD grammar and rejects lossy expansion.
      nquads = await jsonld.toRDF(parsed as JsonLdDocument, options);
    } catch (error) {
      // The loader owns this policy error, regardless of how jsonld.js wraps it.
      if (remoteLoadAttempted) throw remoteContextError;
      throw error;
    }
    if (typeof nquads !== 'string') throw new Error('JSON-LD conversion did not return N-Quads');
    return { sourceKind: 'jsonld', quads: await parseN3Quads(nquads, 'nquads', defaultGraph) };
  }

  return { sourceKind: 'rdf', quads: await parseN3Quads(content, format, defaultGraph) };
}

function parseN3Quads(
  content: string,
  format: Exclude<RdfFormat, 'json' | 'jsonld'>,
  defaultGraph: string,
): Promise<SimpleQuad[]> {
  // N3 parser handles N-Triples, N-Quads, Turtle, TriG
  const n3Format = N3_FORMAT_MAP[format];
  if (!n3Format) throw new Error(`Unsupported format: ${format}`);

  return new Promise((resolve, reject) => {
    const quads: SimpleQuad[] = [];
    const parser = new Parser({ format: n3Format });

    parser.parse(content, (error: Error | null, quad: N3Quad | null) => {
      if (error) { reject(error); return; }
      if (!quad) { resolve(quads); return; }

      quads.push({
        subject: termToString(quad.subject),
        predicate: termToString(quad.predicate),
        object: termToString(quad.object),
        graph: quad.graph.value ? termToString(quad.graph) : defaultGraph,
      });
    });
  });
}

/** Array-only compatibility facade for callers that do not need source provenance. */
export async function parseRdf(
  content: string,
  format: RdfFormat,
  defaultGraph: string,
  baseIRI?: string,
): Promise<SimpleQuad[]> {
  return (await parseRdfInput(content, format, defaultGraph, baseIRI)).quads;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

type LegacyQuad = Omit<SimpleQuad, 'graph'> & { graph?: string | null };

function isLegacyQuad(value: unknown): value is LegacyQuad {
  return isRecord(value)
    && typeof value.subject === 'string'
    && typeof value.predicate === 'string'
    && typeof value.object === 'string'
    && (value.graph == null || typeof value.graph === 'string')
    && !Object.keys(value).some((key) => key.startsWith('@'));
}

function decodeLegacyQuads(value: unknown, defaultGraph: string): SimpleQuad[] | undefined {
  if (!Array.isArray(value) || !value.every(isLegacyQuad)) return undefined;
  return value.map(({ subject, predicate, object, graph }) => ({
    subject, predicate, object, graph: graph || defaultGraph,
  }));
}

function termToString(term: { termType: string; value: string; language?: string; datatype?: { value: string } }): string {
  if (term.termType === 'Literal') {
    return formatCanonicalRdfLiteralTerm(term.language
      ? { kind: 'language', value: term.value, language: term.language }
      : term.datatype
        ? { kind: 'typed', value: term.value, datatype: term.datatype.value }
        : { kind: 'plain', value: term.value });
  }
  if (term.termType === 'BlankNode') return `_:${term.value}`;
  return term.value;
}
