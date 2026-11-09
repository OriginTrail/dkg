import type { RdfTriple } from '../core/types.js';
import type {
  GraphDataSource,
  SparqlSelectResult,
  SparqlConstructResult,
  SparqlBinding,
} from './types.js';

/**
 * In-browser knowledge graph powered by Oxigraph WASM.
 *
 * Provides a full SPARQL 1.1 store that runs entirely in the browser —
 * perfect for development, demos, and offline usage.
 *
 * @example
 * ```typescript
 * const source = new OxigraphSource();
 * await source.init();
 * await source.loadNTriples(ntriplesString);
 *
 * const result = await source.construct(`
 *   CONSTRUCT { ?s ?p ?o }
 *   WHERE { ?s a <https://schema.org/SocialMediaPosting> ; ?p ?o }
 *   LIMIT 1000
 * `);
 *
 * viz.loadTriples(result.triples);
 * ```
 */
export class OxigraphSource implements GraphDataSource {
  readonly name = 'Oxigraph (in-browser)';
  private _store: any = null;
  private _oxigraph: any = null;

  /**
   * Initialize the Oxigraph WASM module.
   * Must be called before any other method.
   *
   * @param wasmUrl - Optional URL to the `web_bg.wasm` file.
   *   In Vite/browser environments, pass this explicitly to avoid
   *   bundler issues with WASM file resolution:
   *   ```
   *   await source.init('/data/oxigraph.wasm');
   *   ```
   *   In Node.js, this can be omitted.
   */
  async init(wasmUrl?: string): Promise<void> {
    if (this._store) return;

    // Dynamic import — uses the web entry point for browser
    const oxigraph = await import('oxigraph/web');

    // Initialize WASM — pass explicit URL if provided (needed for Vite/bundlers)
    if (wasmUrl) {
      await oxigraph.default(wasmUrl);
    } else if (typeof oxigraph.default === 'function') {
      await oxigraph.default();
    }

    this._oxigraph = oxigraph;
    this._store = new oxigraph.Store();
  }

  private ensureReady(): void {
    if (!this._store) {
      throw new Error('OxigraphSource not initialized. Call init() first.');
    }
  }

  async loadNTriples(data: string): Promise<void> {
    this.ensureReady();
    this._store.load(data, { format: 'application/n-triples' });
  }

  async loadTurtle(data: string): Promise<void> {
    this.ensureReady();
    this._store.load(data, { format: 'text/turtle' });
  }

  async select(sparql: string): Promise<SparqlSelectResult> {
    this.ensureReady();

    const results = this._store.query(sparql);

    // Oxigraph returns an array of Map<string, Term> for SELECT
    const bindings: SparqlBinding[] = [];
    const variableSet = new Set<string>();

    for (const row of results) {
      const binding: SparqlBinding = {};
      for (const [variable, term] of row) {
        const varName = variable;
        variableSet.add(varName);
        binding[varName] = this.termToString(term);
      }
      bindings.push(binding);
    }

    return {
      variables: [...variableSet],
      bindings,
    };
  }

  async construct(sparql: string): Promise<SparqlConstructResult> {
    this.ensureReady();

    const quads = this._store.query(sparql);
    const triples: RdfTriple[] = [];

    for (const quad of quads) {
      triples.push({
        subject: this.termToString(quad.subject),
        predicate: this.termToString(quad.predicate),
        object: this.termToString(quad.object),
        datatype: quad.object.datatype?.value,
        language: quad.object.language || undefined,
      });
    }

    return { triples };
  }

  async tripleCount(): Promise<number> {
    this.ensureReady();
    return this._store.size;
  }

  async isReady(): Promise<boolean> {
    return this._store !== null;
  }

  /** Get the raw Oxigraph store for advanced usage */
  get store(): any {
    return this._store;
  }

  /** Convert an Oxigraph RDF term to a string */
  private termToString(term: any): string {
    if (!term) return '';

    switch (term.termType) {
      case 'NamedNode':
        return term.value;
      case 'BlankNode':
        return `_:${term.value}`;
      case 'Literal': {
        // Return just the value string — datatype/language handled separately
        return term.value;
      }
      default:
        return term.value ?? String(term);
    }
  }
}
