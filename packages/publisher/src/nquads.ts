import { DataFactory, Writer } from 'n3';
import type { Quad } from '@origintrail-official/dkg-storage';

const { namedNode, blankNode, literal, quad, defaultGraph } = DataFactory;

export async function serializeQuadsToNQuads(quads: readonly Quad[]): Promise<string> {
  const writer = new Writer({ format: 'N-Quads' });
  writer.addQuads(quads.map(toN3Quad));
  return await new Promise<string>((resolve, reject) => {
    writer.end((error: Error | null | undefined, result: string | undefined) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(result ?? '');
    });
  });
}

function toN3Quad(q: Quad) {
  return quad(
    toNamedOrBlank(q.subject),
    namedNode(q.predicate),
    toObject(q.object),
    q.graph ? toNamedOrBlank(q.graph) : defaultGraph(),
  );
}

function toNamedOrBlank(value: string) {
  return value.startsWith('_:') ? blankNode(value.slice(2)) : namedNode(value);
}

function toObject(value: string) {
  if (!value.startsWith('"')) {
    return toNamedOrBlank(value);
  }

  const lastQuote = value.lastIndexOf('"');
  if (lastQuote <= 0) {
    return literal(value.slice(1));
  }

  const lexical = value.slice(1, lastQuote);
  const suffix = value.slice(lastQuote + 1);
  if (suffix.startsWith('@')) {
    return literal(lexical, suffix.slice(1));
  }
  if (suffix.startsWith('^^<') && suffix.endsWith('>')) {
    return literal(lexical, namedNode(suffix.slice(3, -1)));
  }
  return literal(lexical);
}
