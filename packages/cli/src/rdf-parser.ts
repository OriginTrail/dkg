import { Parser, type Quad as N3Quad } from 'n3';
import { formatCanonicalRdfTerm } from '@origintrail-official/dkg-rdf-utils';

export interface SimpleQuad {
  subject: string;
  predicate: string;
  object: string;
  graph: string;
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
export async function parseRdf(
  content: string,
  format: RdfFormat,
  defaultGraph: string,
): Promise<SimpleQuad[]> {
  if (format === 'json') {
    const parsed = JSON.parse(content);
    const arr = Array.isArray(parsed) ? parsed : parsed.quads;
    return arr.map((q: any) => ({
      subject: q.subject,
      predicate: q.predicate,
      object: q.object,
      graph: q.graph || defaultGraph,
    }));
  }

  if (format === 'jsonld') {
    // JSON-LD → N-Quads conversion would require the jsonld library.
    // For now, treat as our JSON quad format if it has subject/predicate/object,
    // otherwise report unsupported.
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed) && parsed[0]?.subject) {
      return parsed.map((q: any) => ({
        subject: q.subject,
        predicate: q.predicate,
        object: q.object,
        graph: q.graph || defaultGraph,
      }));
    }
    throw new Error('JSON-LD with @context requires the jsonld library. Use .nq, .nt, .ttl, or .trig instead.');
  }

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
        subject: formatCanonicalRdfTerm(quad.subject),
        predicate: formatCanonicalRdfTerm(quad.predicate),
        object: formatCanonicalRdfTerm(quad.object),
        graph: quad.graph.value ? formatCanonicalRdfTerm(quad.graph) : defaultGraph,
      });
    });
  });
}
