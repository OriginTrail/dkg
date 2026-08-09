import {
  type Quad,
  type QueryOptions,
  type QueryResult,
  type StructuredMutation,
  type TripleStore,
} from '../src/index.js';

export function q(graph: string, subject = 'urn:s'): Quad {
  return {
    subject,
    predicate: 'urn:p',
    object: '"v"',
    graph,
  };
}

export class CountingStore implements TripleStore {
  listGraphsCalls = 0;
  hasGraphOptions: Array<QueryOptions | undefined> = [];
  listGraphsOptions: Array<QueryOptions | undefined> = [];
  listGraphsGate: Promise<void> | null = null;
  failListGraphs = false;

  constructor(protected readonly inner: TripleStore) {}

  insert(quads: Quad[], options?: QueryOptions): Promise<void> { return this.inner.insert(quads, options); }
  delete(quads: Quad[], options?: QueryOptions): Promise<void> { return this.inner.delete(quads, options); }
  deleteByPattern(pattern: Partial<Quad>, options?: QueryOptions): Promise<number> {
    return this.inner.deleteByPattern(pattern, options);
  }
  query(sparql: string, options?: QueryOptions): Promise<QueryResult> { return this.inner.query(sparql, options); }
  async update(sparql: string, options?: QueryOptions): Promise<void> {
    if (typeof this.inner.update !== 'function') throw new Error('inner store does not support update()');
    await this.inner.update(sparql, options);
  }
  hasGraph(graphUri: string, options?: QueryOptions): Promise<boolean> {
    this.hasGraphOptions.push(options);
    return this.inner.hasGraph(graphUri, options);
  }
  createGraph(graphUri: string): Promise<void> { return this.inner.createGraph(graphUri); }
  dropGraph(graphUri: string, options?: QueryOptions): Promise<void> { return this.inner.dropGraph(graphUri, options); }
  deleteBySubjectPrefix(graphUri: string, prefix: string, options?: QueryOptions): Promise<number> {
    return this.inner.deleteBySubjectPrefix(graphUri, prefix, options);
  }
  structuredMutation(mutation: StructuredMutation, options?: QueryOptions): Promise<void> {
    return this.inner.structuredMutation!(mutation, options);
  }
  countQuads(graphUri?: string, options?: QueryOptions): Promise<number> { return this.inner.countQuads(graphUri, options); }
  flush(options?: QueryOptions): Promise<void> { return this.inner.flush?.(options) ?? Promise.resolve(); }
  close(): Promise<void> { return this.inner.close(); }

  async listGraphs(options?: QueryOptions): Promise<string[]> {
    this.listGraphsCalls++;
    this.listGraphsOptions.push(options);
    if (this.listGraphsGate) await this.listGraphsGate;
    if (this.failListGraphs) throw new Error('listGraphs failed');
    return this.inner.listGraphs(options);
  }
}

/** Controls hasGraph completion so concurrency tests describe races explicitly. */
export class ControlledProbeStore extends CountingStore {
  private gateProbes = false;
  private readonly pendingProbeReleases: Array<() => void> = [];
  private readonly probeArrivalWaiters: Array<() => void> = [];

  enableProbeGates(): void {
    this.gateProbes = true;
  }

  disableProbeGates(): void {
    this.gateProbes = false;
  }

  async waitForProbe(): Promise<void> {
    if (this.pendingProbeReleases.length > 0) return;
    await new Promise<void>((resolve) => { this.probeArrivalWaiters.push(resolve); });
  }

  releaseProbe(): void {
    const release = this.pendingProbeReleases.shift();
    if (!release) throw new Error('No controlled hasGraph probe is pending');
    release();
  }

  async hasGraph(graphUri: string, options?: QueryOptions): Promise<boolean> {
    const present = await super.hasGraph(graphUri, options);
    if (this.gateProbes) {
      await new Promise<void>((resolve) => {
        this.pendingProbeReleases.push(resolve);
        for (const notify of this.probeArrivalWaiters.splice(0)) notify();
      });
    }
    return present;
  }
}

export function emptyBindings(): QueryResult {
  return { type: 'bindings', bindings: [] };
}

export type MutationHookInput = {
  sparql: string;
  seq: number;
  inner: TripleStore;
  options?: QueryOptions;
};

export class MutationHookStore extends CountingStore {
  private querySeq = 0;
  private updateSeq = 0;

  constructor(
    inner: TripleStore,
    private readonly hooks: {
      onQuery?: (input: MutationHookInput) => Promise<QueryResult | undefined> | QueryResult | undefined;
      onUpdate?: (input: MutationHookInput) => Promise<void> | void;
    },
  ) {
    super(inner);
  }

  async query(sparql: string, options?: QueryOptions): Promise<QueryResult> {
    if (this.hooks.onQuery) {
      const seq = this.querySeq++;
      const result = await this.hooks.onQuery({ sparql, seq, inner: this.inner, options });
      if (result !== undefined) return result;
    }
    return super.query(sparql, options);
  }

  async update(sparql: string, options?: QueryOptions): Promise<void> {
    if (this.hooks.onUpdate) {
      const seq = this.updateSeq++;
      await this.hooks.onUpdate({ sparql, seq, inner: this.inner, options });
      return;
    }
    await super.update(sparql, options);
  }
}
