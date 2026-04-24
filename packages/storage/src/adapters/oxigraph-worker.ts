import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TripleStore, Quad, QueryResult } from '../triple-store.js';
import { registerTripleStoreAdapter } from '../triple-store.js';

export class OxigraphWorkerStore implements TripleStore {
  private worker: Worker;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor(persistPath?: string) {
    // Resolve the worker impl with a small search path so this keeps
    // working in all three deployment shapes we actually run in:
    //
    //   1. Production / npm install / built monorepo — this module is
    //      loaded from `dist/adapters/oxigraph-worker.js`, so the
    //      sibling `./oxigraph-worker-impl.js` resolves correctly.
    //   2. vitest against raw source — this module is loaded from
    //      `src/adapters/oxigraph-worker.ts`, so the sibling
    //      `./oxigraph-worker-impl.js` does NOT exist, but its compiled
    //      twin in `dist/adapters/` does as long as the caller ran
    //      `pnpm --filter ...dkg-storage build` first. Redirect to
    //      that path so the adapter is runnable in dev loops.
    //   3. Neither file exists — genuinely unbuilt tree. Throw a loud,
    //      actionable error explaining the fix (`pnpm build`), matching
    //      the expectation in `test/storage.test.ts`.
    const siblingJsUrl = new URL('./oxigraph-worker-impl.js', import.meta.url);
    const siblingJsPath = fileURLToPath(siblingJsUrl);
    let workerPath: string | null = existsSync(siblingJsPath) ? siblingJsPath : null;
    if (!workerPath) {
      const srcAdapters = `${sep}src${sep}adapters${sep}`;
      const distAdapters = `${sep}dist${sep}adapters${sep}`;
      if (siblingJsPath.includes(srcAdapters)) {
        const candidate = siblingJsPath.replace(srcAdapters, distAdapters);
        if (existsSync(candidate)) workerPath = candidate;
      }
    }
    if (!workerPath) {
      throw new Error(
        `oxigraph-worker adapter: compiled worker artefact ` +
          `\`oxigraph-worker-impl.js\` was not found next to ` +
          `${siblingJsPath} or in the sibling \`dist/adapters/\` ` +
          `directory. Run \`pnpm --filter @origintrail-official/dkg-storage build\` ` +
          `before using this adapter.`,
      );
    }
    this.worker = new Worker(workerPath, {
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
