import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { TripleStore, Quad, QueryResult } from '../triple-store.js';
import { registerTripleStoreAdapter } from '../triple-store.js';

export class OxigraphWorkerStore implements TripleStore {
  private worker: Worker;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor(persistPath?: string) {
    const workerUrl = new URL('./oxigraph-worker-impl.js', import.meta.url);
    this.worker = new Worker(fileURLToPath(workerUrl), {
      workerData: { persistPath },
    });
    this.worker.on('message', (msg: { id: number; result?: unknown; error?: string }) => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    });
    this.worker.on('error', (err) => {
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    });
  }

  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, args });
    });
  }

  async insert(quads: Quad[]): Promise<void> { return this.call('insert', quads); }
  async delete(quads: Quad[]): Promise<void> { return this.call('delete', quads); }
  async deleteByPattern(pattern: Partial<Quad>): Promise<number> { return this.call('deleteByPattern', pattern); }
  async query(sparql: string): Promise<QueryResult> { return this.call('query', sparql); }
  async hasGraph(graphUri: string): Promise<boolean> { return this.call('hasGraph', graphUri); }
  async createGraph(graphUri: string): Promise<void> { return this.call('createGraph', graphUri); }
  async dropGraph(graphUri: string): Promise<void> { return this.call('dropGraph', graphUri); }
  async listGraphs(): Promise<string[]> { return this.call('listGraphs'); }
  async deleteBySubjectPrefix(graphUri: string, prefix: string): Promise<number> { return this.call('deleteBySubjectPrefix', graphUri, prefix); }
  async countQuads(graphUri?: string): Promise<number> { return this.call('countQuads', graphUri); }

  async close(): Promise<void> {
    await this.call('close');
    await this.worker.terminate();
  }
}

registerTripleStoreAdapter('oxigraph-worker', async (opts) => {
  const filePath = opts?.path as string | undefined;
  return new OxigraphWorkerStore(filePath);
});
