import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { DurableDirectoryPreparation } from './durable-content-addressed-file.js';
import { raceStoreWorkAgainstAbort } from './abortable-store-work-lifecycle.js';
import { StoreResponseTooLargeError } from './http-response-limit.js';
import { assertSqliteBlobRuntime, SQLITE_BLOB_FILENAME, type BlobRequest, type BlobResponse } from './sqlite-literal-blob-protocol.js';

type Command = BlobRequest extends infer R ? R extends BlobRequest ? Omit<R, 'id'> : never : never;
interface Pending { resolve: (value: string | undefined) => void; reject: (error: unknown) => void; }
interface Session {
  worker: Worker;
  pending: Map<number, Pending>;
  ready: Promise<void>;
  dead: boolean;
}
type Role = 'reader' | 'writer';
/** Private physical owner. Its native worker owns transactions and all WAL durability. */
export class SqliteLiteralBlobOwner {
  private readonly directory: DurableDirectoryPreparation;
  private readonly path: string;
  private readonly sessions = new Map<Role, Session>();
  private readonly opening = new Map<Role, Promise<Session>>();
  private readonly children = new Set<Worker>();
  private readonly accepted = new Set<Promise<unknown>>();
  private readonly capacity = {
    reader: { physical: 0, limit: 4, waiting: [] as Array<() => void> },
    writer: { physical: 0, limit: 8, waiting: [] as Array<() => void> },
  };
  private nextId = 0;
  private closing = false;
  private stopped?: Promise<void>;

  constructor(directory: string) {
    assertSqliteBlobRuntime();
    const absolute = resolve(directory);
    this.directory = new DurableDirectoryPreparation(absolute);
    this.path = join(absolute, SQLITE_BLOB_FILENAME);
  }
  write(hash: string, term: string): Promise<void> {
    return this.admit('writer', async () => {
      await this.directory.prepare();
      await this.request(await this.ensureSession('writer'), { operation: 'write', hash, term });
    });
  }
  async read(hash: string, maxBytes?: number, signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted();
    const work = this.admit('reader', async () => {
      // The worker opens existing data read-only; a miss creates no database.
      signal?.throwIfAborted();
      const session = await this.ensureSession('reader');
      signal?.throwIfAborted();
      return this.request(session, { operation: 'read', hash, maxBytes });
    });
    return raceStoreWorkAgainstAbort(work, signal);
  }
  close(): Promise<void> {
    if (this.stopped) return this.stopped;
    this.closing = true;
    this.stopped = (async () => {
      await Promise.allSettled(this.accepted);
      try {
        await Promise.all([...this.opening.values()].map(async ready => {
          const session = await ready;
          if (!session.dead) await this.request(session, { operation: 'close' });
        }));
      } finally {
        await Promise.all([...this.children].map(worker => worker.terminate()));
      }
    })();
    return this.stopped;
  }
  private admit<T>(role: Role, work: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Literal blob owner is closing'));
    const capacity = this.capacity[role];
    const task = Promise.resolve().then(async () => {
      if (capacity.physical >= capacity.limit) await new Promise<void>(resolve => capacity.waiting.push(resolve));
      else capacity.physical += 1;
      try { return await work(); }
      finally { const next = capacity.waiting.shift(); if (next) next(); else capacity.physical -= 1; }
    });
    // Registration precedes preparation, worker creation and any synchronous callback.
    this.accepted.add(task);
    void task.then(() => this.accepted.delete(task), () => this.accepted.delete(task));
    return task;
  }
  private ensureSession(role: Role): Promise<Session> {
    const existing = this.opening.get(role);
    if (existing) return existing;
    const opening = this.startSession(role);
    this.opening.set(role, opening);
    void opening.catch(() => { if (this.opening.get(role) === opening) this.opening.delete(role); });
    return opening;
  }
  private async startSession(role: Role): Promise<Session> {
    const sibling = new URL('./sqlite-literal-blob-worker.js', import.meta.url);
    const compiled = new URL('../dist/sqlite-literal-blob-worker.js', import.meta.url);
    const url = existsSync(sibling) ? sibling : compiled;
    if (!existsSync(url)) throw new Error('Build dkg-storage before starting the literal blob worker');
    const worker = new Worker(url, { workerData: { path: this.path, readOnly: role === 'reader' } });
    this.children.add(worker);
    let resolve!: () => void, reject!: (error: unknown) => void;
    const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const session: Session = { worker, pending: new Map(), ready, dead: false };
    this.sessions.set(role, session);
    const lost = (error: unknown) => {
      session.dead = true; reject(error);
      for (const request of session.pending.values()) request.reject(error);
      session.pending.clear();
      if (this.sessions.get(role) === session) { this.sessions.delete(role); this.opening.delete(role); }
    };
    worker.on('message', (response: BlobResponse) => {
      if ('ready' in response) { resolve(); return; }
      const pending = session.pending.get(response.id);
      if (!pending) return;
      session.pending.delete(response.id);
      if (response.error) {
        const e = response.error;
        pending.reject(e.code === 'STORE_RESPONSE_TOO_LARGE' && e.maxBytes !== undefined && e.actualBytes !== undefined
          ? new StoreResponseTooLargeError(e.maxBytes, e.actualBytes)
          : Object.assign(new Error(e.message), { code: e.code }));
      } else pending.resolve(response.value);
    });
    worker.on('error', lost);
    worker.on('exit', code => { this.children.delete(worker); lost(new Error(`Literal blob worker exited (${code}); retry the original preparation`)); });
    await ready;
    return session;
  }
  private request(session: Session, command: Command): Promise<string | undefined> {
    if (session.dead) return Promise.reject(new Error('Literal blob worker changed; retry preparation'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      session.pending.set(id, { resolve, reject });
      try { session.worker.postMessage({ ...command, id }); }
      catch (error) { session.pending.delete(id); reject(error); }
    });
  }
}
