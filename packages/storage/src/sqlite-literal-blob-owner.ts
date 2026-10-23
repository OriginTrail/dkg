import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { DurableDirectoryPreparation } from './durable-content-addressed-file.js';
import { raceStoreWorkAgainstAbort } from './abortable-store-work-lifecycle.js';
import { StoreResponseTooLargeError } from './http-response-limit.js';
import { StoreWorkDrain } from './store-work-drain.js';
import { BoundedWork } from './bounded-work.js';
import { deserializeWorkerErrorV1 } from './worker-error-protocol.js';
import { assertSqliteBlobRuntime, SQLITE_BLOB_FILENAME, type BlobRequest, type BlobResponse } from './sqlite-literal-blob-protocol.js';

type Command = BlobRequest extends infer R ? R extends BlobRequest ? Omit<R, 'id'> : never : never;
interface Pending { resolve: (value: string | undefined) => void; reject: (error: unknown) => void; }
interface Session {
  worker: Worker;
  pending: Map<number, Pending>;
  ready: Promise<Session>;
  dead: boolean;
}
type Role = 'reader' | 'writer';
/** Private physical owner. Its native worker owns transactions and all WAL durability. */
export class SqliteLiteralBlobOwner {
  private readonly directory: DurableDirectoryPreparation;
  private readonly path: string;
  private readonly sessions = new Map<Role, Session>();
  private readonly children = new Set<Worker>();
  private readonly work = new StoreWorkDrain('Literal blob owner is closing');
  private readonly capacity = {
    reader: new BoundedWork(4),
    writer: new BoundedWork(8),
  };
  private nextId = 0;

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
    return this.work.close(async () => {
      try {
        await Promise.all([...this.sessions.values()].map(async session => {
          await session.ready;
          if (!session.dead) await this.request(session, { operation: 'close' });
        }));
      } finally {
        await Promise.all([...this.children].map(worker => worker.terminate()));
      }
    });
  }
  private admit<T>(role: Role, work: () => Promise<T>): Promise<T> {
    return this.work.run(() => Promise.resolve().then(() => this.capacity[role].run(work)));
  }

  private ensureSession(role: Role): Promise<Session> {
    return (this.sessions.get(role) ?? this.startSession(role)).ready;
  }
  private startSession(role: Role): Session {
    const sibling = new URL('./sqlite-literal-blob-worker.js', import.meta.url);
    const compiled = new URL('../dist/sqlite-literal-blob-worker.js', import.meta.url);
    const url = existsSync(sibling) ? sibling : compiled;
    if (!existsSync(url)) throw new Error('Build dkg-storage before starting the literal blob worker');
    const worker = new Worker(url, { workerData: { path: this.path, readOnly: role === 'reader' } });
    this.children.add(worker);
    let resolve!: (session: Session) => void, reject!: (error: unknown) => void;
    const ready = new Promise<Session>((yes, no) => { resolve = yes; reject = no; });
    const session: Session = { worker, pending: new Map(), ready, dead: false };
    this.sessions.set(role, session);
    const lost = (error: unknown) => {
      session.dead = true; reject(error);
      for (const request of session.pending.values()) request.reject(error);
      session.pending.clear();
      if (this.sessions.get(role) === session) this.sessions.delete(role);
    };
    worker.on('message', (response: BlobResponse) => {
      if ('ready' in response) { resolve(session); return; }
      const pending = session.pending.get(response.id);
      if (!pending) return;
      session.pending.delete(response.id);
      if (response.error) {
        const e = response.error;
        pending.reject(e.code === 'STORE_RESPONSE_TOO_LARGE' && e.maxBytes !== undefined && e.actualBytes !== undefined
          ? new StoreResponseTooLargeError(e.maxBytes, e.actualBytes)
          : deserializeWorkerErrorV1(e));
      } else pending.resolve(response.value);
    });
    worker.on('error', lost);
    worker.on('exit', code => { this.children.delete(worker); lost(new Error(`Literal blob worker exited (${code}); retry the original preparation`)); });
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
