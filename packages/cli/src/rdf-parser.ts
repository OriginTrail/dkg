import { formatCanonicalRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import { Parser, type Quad as N3Quad } from 'n3';

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
    // Keep the historical quad-array input while supporting ordinary JSON-LD.
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((q) => q
      && typeof q.subject === 'string' && typeof q.predicate === 'string' && typeof q.object === 'string'
      && !Object.keys(q).some((key) => key.startsWith('@')))) {
      return parsed.map((q: any) => ({
        subject: q.subject,
        predicate: q.predicate,
        object: q.object,
        graph: q.graph || defaultGraph,
      }));
    }
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error('JSON-LD input must be an object or array');
    }
    const { default: jsonld } = await import('jsonld');
    const nquads = await jsonld.toRDF(parsed, { format: 'application/n-quads' });
    if (typeof nquads !== 'string') throw new Error('JSON-LD conversion did not return N-Quads');
    return parseRdf(nquads, 'nquads', defaultGraph);
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
        subject: termToString(quad.subject),
        predicate: termToString(quad.predicate),
        object: termToString(quad.object),
        graph: quad.graph.value ? termToString(quad.graph) : defaultGraph,
      });
    });
  });
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
