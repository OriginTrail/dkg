/**
 * TripleStore — pure SPARQL 1.1 interface for any RDF repository.
 * No vendor-specific methods. Any SPARQL-capable store (Oxigraph, Blazegraph,
 * Neptune, GraphDB, Jena, etc.) can implement this interface.
 */

export interface Quad {
  subject: string;
  predicate: string;
  object: string;
  graph: string;
}

export interface SelectResult {
  type: 'bindings';
  bindings: Array<Record<string, string>>;
}

export interface ConstructResult {
  type: 'quads';
  quads: Quad[];
}

export interface AskResult {
  type: 'boolean';
  value: boolean;
}

export type QueryResult = SelectResult | ConstructResult | AskResult;

export interface TripleStore {
  insert(quads: Quad[]): Promise<void>;
  delete(quads: Quad[]): Promise<void>;
  deleteByPattern(pattern: Partial<Quad>): Promise<number>;
  query(sparql: string): Promise<QueryResult>;

  hasGraph(graphUri: string): Promise<boolean>;
  createGraph(graphUri: string): Promise<void>;
  dropGraph(graphUri: string): Promise<void>;
  listGraphs(): Promise<string[]>;

  deleteBySubjectPrefix(graphUri: string, prefix: string): Promise<number>;

  countQuads(graphUri?: string): Promise<number>;

  close(): Promise<void>;
}

export type TripleStoreBackend = 'oxigraph' | 'oxigraph-persistent' | 'oxigraph-worker' | 'blazegraph' | 'sparql-http' | string;

export interface TripleStoreConfig {
  backend: TripleStoreBackend;
  options?: Record<string, unknown>;
}

type AdapterFactory = (
  options?: Record<string, unknown>,
) => Promise<TripleStore>;

const adapterRegistry = new Map<string, AdapterFactory>();

export function registerTripleStoreAdapter(
  name: string,
  factory: AdapterFactory,
): void {
  adapterRegistry.set(name, factory);
}

export async function createTripleStore(
  config: TripleStoreConfig,
): Promise<TripleStore> {
  const factory = adapterRegistry.get(config.backend);
  if (!factory) {
    throw new Error(
      `Unknown TripleStore backend: "${config.backend}". ` +
        `Registered: [${[...adapterRegistry.keys()].join(', ')}]`,
    );
  }
  return factory(config.options);
}
