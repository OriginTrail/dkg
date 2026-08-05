declare module 'rdf-canonize' {
  interface RdfTerm {
    termType: 'NamedNode' | 'BlankNode' | 'Literal' | 'DefaultGraph';
    value: string;
    datatype?: RdfTerm;
    language?: string;
  }

  interface RdfQuad {
    subject: RdfTerm;
    predicate: RdfTerm;
    object: RdfTerm;
    graph: RdfTerm;
  }

  interface CanonizeOptions {
    algorithm: 'RDFC-1.0' | 'URDNA2015';
    inputFormat?: 'application/n-quads';
    format?: 'application/n-quads';
    messageDigestAlgorithm?: string;
    signal?: AbortSignal;
    maxWorkFactor?: number;
    /** Receives the input blank-node label -> canonical label mapping. */
    canonicalIdMap?: Map<string, string>;
  }

  interface RdfCanonize {
    canonize(input: string, options: CanonizeOptions): Promise<string>;
    NQuads: {
      parse(nquads: string): RdfQuad[];
      serialize(dataset: readonly RdfQuad[]): string;
    };
  }

  const canonize: RdfCanonize;
  export default canonize;
}
