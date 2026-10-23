import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Worker } from 'node:worker_threads';
import { SqliteLiteralBlobOwner } from '../src/sqlite-literal-blob-owner.js';
import { SQLITE_BLOB_FILENAME } from '../src/sqlite-literal-blob-protocol.js';
import { asChangelogReader, createTripleStore, registerTripleStoreAdapter, OxigraphWorkerStore, type TripleStore } from '../src/index.js';
const control = vi.hoisted(() => ({ mode: '', signal: undefined as SharedArrayBuffer | undefined,
  instances: [] as Worker[], allocations: [] as number[], handlers: [] as ((error: Error) => void)[], reads: 0, commits: 0,
  policies: [] as Record<string, unknown>[], writes: [] as { hash: string; bytes: number; payloadHash: string }[] }));
vi.mock('node:worker_threads', async original => {
  const native = await original<typeof import('node:worker_threads')>();
  return { ...native, Worker: class extends native.Worker {
    constructor(url: string | URL, options?: import('node:worker_threads').WorkerOptions) {
      const isBlob = String(url).endsWith('/sqlite-literal-blob-worker.js');
      const fault = isBlob ? control.mode : ''; if (isBlob) control.mode = '';
      super(fault ? new URL('./fixtures/sqlite-blob-worker-fault.mjs', import.meta.url) : url, fault ? {
        ...options, workerData: { ...options?.workerData, fault, signal: control.signal },
      } : options);
      control.instances.push(this);
      queueMicrotask(() => { const handler = this.listeners('error')[0]; if (handler) control.handlers.push(handler as (error: Error) => void); });
      this.on('message', message => {
        if (message?.diagnostic === 'allocation') control.allocations.push(message.bytes);
        if (message?.diagnostic === 'commit') control.commits += 1;
        if (message?.diagnostic === 'policy') control.policies.push(message.values);
        if (message?.diagnostic === 'write') control.writes.push(message);
      });
    }
    override postMessage(message: { operation?: string }, transferList?: readonly import('node:worker_threads').Transferable[]) {
      if (message?.operation === 'read') control.reads += 1;
      return super.postMessage(message, transferList);
    }
  } };
});
const roots: string[] = [], owners: SqliteLiteralBlobOwner[] = [], holds: Int32Array[] = [];
const stores: TripleStore[] = [];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const value = JSON.stringify('immutable exact bytes '.repeat(4096));
function owner(directory: string) { const o = new SqliteLiteralBlobOwner(directory); owners.push(o); return o; }
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'dkg-sqlite-blob-fault-')); roots.push(root); return { root, directory: join(root, 'blobs') }; }
function workerAllocationProbe(root: string) {
  const backends: TripleStore[] = [];
  const config = { backend: 'blob-options-allocation-probe', options: { path: join(root, 'store.nq') } };
  registerTripleStoreAdapter(config.backend, async () => {
    const backend = new OxigraphWorkerStore(config.options); backends.push(backend); return backend;
  });
  return { config, backends };
}
afterEach(async () => {
  for (const held of holds.splice(0)) { Atomics.store(held, 1, 0x7fffffff); Atomics.notify(held, 1); }
  for (const store of stores.splice(0)) await store.close().catch(() => {});
  for (const o of owners.splice(0)) await o.close().catch(() => {});
  expect(control.instances.every(worker => worker.threadId === -1)).toBe(true);
  control.mode = ''; control.signal = undefined; control.instances = []; control.allocations = []; control.handlers = []; control.reads = 0; control.commits = 0;
  control.policies = []; control.writes = [];
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it.each(['before-commit', 'after-commit'])('recovers a native worker %s failure without accepting an uncertain write', async fault => {
  const f = await fixture(), o = owner(f.directory); control.mode = fault;
  await expect(o.write(hash(value), value)).rejects.toThrow('worker exited');
  await expect(o.read(hash(value))).resolves.toBe(fault === 'after-commit' ? value : undefined);
  await o.write(hash(value), value);
  // A stale owner's error cannot invalidate its replacement.
  expect(control.handlers.length).toBeGreaterThan(1);
  const workers = control.instances.length;
  control.handlers[0]!(new Error('late old-owner failure'));
  const distinct = value+'after-stale-callback';
  await o.write(hash(distinct), distinct);
  expect(control.instances).toHaveLength(workers);
  await expect(o.read(hash(distinct))).resolves.toBe(distinct);
});
it('retains a real native FULL failure and succeeds with a fresh owner after the limit is removed', async () => {
  const f = await fixture(), o = owner(f.directory); control.mode = 'full';
  await expect(o.write(hash(value), value)).rejects.toThrow('database or disk is full');
  await expect(o.read(hash(value))).resolves.toBeUndefined();
  // Reopening the failed native connection permits ordinary retry on this owner.
  await o.write(hash(value), value); await o.close();
  expect(control.policies).toHaveLength(2);
  expect(control.policies).toEqual([requiredPolicy, requiredPolicy]);
  const retry = owner(f.directory);
  await expect(retry.read(hash(value))).resolves.toBe(value);
});
it('keeps writes arriving during a held COMMIT behind a separate native barrier', async () => {
  const f = await fixture(), o = owner(f.directory), signal = new Int32Array(new SharedArrayBuffer(8)); holds.push(signal);
  control.mode = 'hold'; control.signal = signal.buffer as SharedArrayBuffer;
  let firstDone = false, secondDone = false;
  const first = o.write(hash(value), value).then(() => { firstDone = true; });
  await vi.waitFor(() => expect(Atomics.load(signal, 0)).toBe(1));
  const secondValue = value+'second', second = o.write(hash(secondValue), secondValue).then(() => { secondDone = true; });
  await new Promise(resolve => setImmediate(resolve)); expect(firstDone).toBe(false); expect(secondDone).toBe(false);
  Atomics.store(signal, 1, 1); Atomics.notify(signal, 1);
  await first; await vi.waitFor(() => expect(Atomics.load(signal, 0)).toBe(2));
  expect(secondDone).toBe(false);
  Atomics.store(signal, 1, 2); Atomics.notify(signal, 1); await second;
  await expect(o.read(hash(secondValue))).resolves.toBe(secondValue);
});
it('registers accepted writes before close and drains a held native commit', async () => {
  const f = await fixture(), o = owner(f.directory), signal = new Int32Array(new SharedArrayBuffer(8)); holds.push(signal);
  control.mode = 'hold'; control.signal = signal.buffer as SharedArrayBuffer;
  const writing = o.write(hash(value), value);
  await vi.waitFor(() => expect(Atomics.load(signal, 0)).toBe(1));
  let closed = false; const closing = o.close().then(() => { closed = true; });
  await expect(o.write(hash('late'), 'late')).rejects.toThrow('closing');
  await new Promise(resolve => setImmediate(resolve)); expect(closed).toBe(false);
  Atomics.store(signal, 1, 1); Atomics.notify(signal, 1); await writing; await closing;
  await expect(owner(f.directory).read(hash(value))).resolves.toBe(value);
});
it('hydrates committed bytes through an independent reader while the writer is held at COMMIT', async () => {
  const f = await fixture(), seed = owner(f.directory); await seed.write(hash('seed'), 'seed'); await seed.close();
  const o = owner(f.directory), signal = new Int32Array(new SharedArrayBuffer(8)); holds.push(signal);
  control.mode = 'hold'; control.signal = signal.buffer as SharedArrayBuffer;
  let done = false; const writing = o.write(hash(value), value).then(() => { done = true; });
  await vi.waitFor(() => expect(Atomics.load(signal, 0)).toBe(1));
  await expect(o.read(hash('seed'))).resolves.toBe('seed');
  expect(done).toBe(false);
  Atomics.store(signal, 1, 1); Atomics.notify(signal, 1); await writing;
  await expect(o.read(hash(value))).resolves.toBe(value);
});
it('rejects an oversized BLOB without allocating its stored payload', async () => {
  const f = await fixture(), seed = owner(f.directory); await seed.write(hash('seed'), 'seed'); await seed.close();
  const db = new DatabaseSync(join(f.directory, SQLITE_BLOB_FILENAME));
  db.prepare('UPDATE blobs SET term=zeroblob(?) WHERE hash=?').run(16*1024*1024, hash('seed')); db.close();
  control.mode = 'allocation'; control.allocations = [];
  await expect(owner(f.directory).read(hash('seed'), 16)).rejects.toMatchObject({ code: 'STORE_RESPONSE_TOO_LARGE', actualBytes: 16*1024*1024 });
  expect(control.allocations.length).toBeGreaterThan(0);
  expect(Math.max(...control.allocations)).toBeLessThan(1024*1024);
});

it('detaches an aborted read, permits an independent write and drains the accepted read RPC', async () => {
  const f = await fixture(), seed = owner(f.directory); await seed.write(hash('seed'), 'seed'); await seed.close();
  const o = owner(f.directory), signal = new Int32Array(new SharedArrayBuffer(8)); holds.push(signal);
  control.mode = 'hold-read'; control.signal = signal.buffer as SharedArrayBuffer;
  const controller = new AbortController(), reading = o.read(hash('seed'), undefined, controller.signal);
  await vi.waitFor(() => expect(Atomics.load(signal, 0)).toBe(1));
  controller.abort(); await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
  await o.write(hash(value), value);
  let closed = false; const closing = o.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); expect(closed).toBe(false);
  Atomics.store(signal, 1, 1); Atomics.notify(signal, 1); await closing;
  await expect(owner(f.directory).read(hash(value))).resolves.toBe(value);
});

it('coalesces a ready group into one native durable transaction', async () => {
  const f = await fixture(), o = owner(f.directory); control.mode = 'collect';
  const values = Array.from({ length: 8 }, (_, i) => 'ready-batch-'+i);
  await Promise.all(values.map(term => o.write(hash(term), term)));
  expect(control.commits).toBe(1);
  await expect(Promise.all(values.map(term => o.read(hash(term))))).resolves.toEqual(values);
});

const graph = 'urn:sqlite-blob/_shared_memory';
const requiredPolicy = { journal_mode: 'wal', synchronous: 2, fullfsync: 1, checkpoint_fullfsync: 1 };
async function composed(directory: string) {
  const store = await createTripleStore({ backend: 'oxigraph-worker', options: { path: join(directory, 'store.nq') },
    graphSetIndex: true, changelog: true, largeLiteralStorage: { directory: join(directory, 'blobs'), thresholdBytes: 1024, persistence: 'sqlite-wal' } });
  stores.push(store); return store;
}
const quad = (subject: string, object = '"small"') => ({ graph, subject, predicate: 'urn:value', object });
const select = (subject: string) => `SELECT ?value WHERE { GRAPH <${graph}> { <${subject}> <urn:value> ?value } }`;
it('keeps native group commit outside RDF sequence allocation and drains it before store close', async () => {
  const f = await fixture(), s = await composed(f.root), signal = new Int32Array(new SharedArrayBuffer(8)); holds.push(signal);
  await s.insert([quad('urn:seed')]); control.mode = 'hold'; control.signal = signal.buffer as SharedArrayBuffer;
  const large = s.insert([quad('urn:large', value)]);
  await vi.waitFor(() => expect(Atomics.load(signal, 0)).toBe(1));
  await s.insert([quad('urn:independent')]);
  await expect(s.query(select('urn:large'))).resolves.toMatchObject({ bindings: [] });
  expect((await asChangelogReader(s)!.readChanges(0, 10)).map(change => change.seq)).toEqual([1, 2]);
  expect(await s.listGraphs()).toEqual([graph]);
  let closed = false; const closing = s.close().then(() => { closed = true; });
  await expect(s.insert([quad('urn:late')])).rejects.toThrow('closing');
  await new Promise(resolve => setImmediate(resolve)); expect(closed).toBe(false);
  Atomics.store(signal, 1, 1); Atomics.notify(signal, 1); await large; await closing;
  const reopened = await composed(f.root);
  await expect(reopened.query(select('urn:large'))).resolves.toMatchObject({ bindings: [{ value }] });
  expect((await asChangelogReader(reopened)!.readChanges(0, 10)).map(change => change.seq)).toEqual([1, 2, 3]);
});
it.each(['before-commit', 'after-commit', 'full'])('retries %s without publishing an RDF ref or changelog prematurely', async fault => {
  const f = await fixture(), s = await composed(f.root); await s.insert([quad('urn:seed')]); control.mode = fault;
  await expect(s.insert([quad('urn:retry', value)])).rejects.toThrow();
  await expect(s.query(select('urn:retry'))).resolves.toMatchObject({ bindings: [] });
  expect((await asChangelogReader(s)!.readChanges(0, 10)).map(change => change.seq)).toEqual([1]);
  await s.insert([quad('urn:retry', value)]); await s.close();
  const reopened = await composed(f.root);
  await expect(reopened.query(select('urn:retry'))).resolves.toMatchObject({ bindings: [{ value }] });
  expect((await asChangelogReader(reopened)!.readChanges(0, 10)).map(change => change.seq)).toEqual([1, 2]);
});
it('rejects an unsupported runtime before allocating an RDF worker', async () => {
  const f = await fixture(), probe = workerAllocationProbe(f.root), descriptor = Object.getOwnPropertyDescriptor(process.versions, 'sqlite')!;
  try {
    Object.defineProperty(process.versions, 'sqlite', { ...descriptor, value: '3.51.2' });
    await expect(createTripleStore({ ...probe.config, largeLiteralStorage: { directory: f.directory, persistence: 'sqlite-wal' } })).rejects.toThrow('requires a Node runtime');
    expect(probe.backends).toHaveLength(0); expect(control.instances).toHaveLength(0);
  } finally {
    Object.defineProperty(process.versions, 'sqlite', descriptor);
    // Close captured real backends intentionally so a failing counterfactual cannot auto-respawn.
    await Promise.all(probe.backends.map(backend => backend.close()));
  }
});
it.each([
  { label: 'unknown layout', input: { persistence: 'sqlite' }, error: 'Unsupported literal blob persistence' },
  { label: 'nonstring layout', input: { persistence: 42 }, error: 'Unsupported literal blob persistence' },
  { label: 'blank directory', input: { directory: ' ' }, error: 'requires options.blobDir' },
  { label: 'nonstring directory', input: { directory: 17 }, error: 'requires options.blobDir' },
  { label: 'negative threshold', input: { thresholdBytes: -1 }, error: 'non-negative integer thresholdBytes' },
  { label: 'fractional threshold', input: { thresholdBytes: 1.25 }, error: 'non-negative integer thresholdBytes' },
])('rejects invalid JSON blob options ($label) before allocating an RDF worker', async ({ input, error }) => {
  const f = await fixture(), probe = workerAllocationProbe(f.root);
  const config = JSON.parse(JSON.stringify({ ...probe.config,
    largeLiteralStorage: { directory: f.directory, persistence: 'files', ...input } }));
  try {
    await expect(createTripleStore(config)).rejects.toThrow(error);
    expect(probe.backends).toHaveLength(0); expect(control.instances).toHaveLength(0);
  } finally { await Promise.all(probe.backends.map(backend => backend.close())); }
});
it.each(['journal_mode', 'synchronous', 'fullfsync', 'checkpoint_fullfsync'])(
  'rejects a native %s downgrade before publication, then reestablishes the full policy on retry', async key => {
    const f = await fixture(), s = await composed(f.root); await s.insert([quad('urn:seed')]);
    control.mode = 'policy-downgrade:'+key;
    await expect(s.insert([quad('urn:policy', value)])).rejects.toThrow('required durability policy');
    await expect(s.query(select('urn:policy'))).resolves.toMatchObject({ bindings: [] });
    expect((await asChangelogReader(s)!.readChanges(0, 10)).map(change => change.seq)).toEqual([1]);
    expect(control.policies).toHaveLength(1); expect(control.policies[0]![key]).not.toBe(requiredPolicy[key as keyof typeof requiredPolicy]);
    await s.insert([quad('urn:policy', value)]);
    expect(control.policies).toHaveLength(2); expect(control.policies[1]).toEqual(requiredPolicy);
    await expect(s.query(select('urn:policy'))).resolves.toMatchObject({ bindings: [{ value }] });
  });
it.each(['fresh-owner', 'lost-ACK'])('re-submits full matching bytes after %s and refuses a real native write error', async mode => {
  const f = await fixture(), s = await composed(f.root); await s.insert([quad('urn:seed')]);
  if (mode === 'fresh-owner') { const seed = owner(f.directory); await seed.write(hash(value), value); await seed.close(); }
  else {
    control.mode = 'after-commit';
    await expect(s.insert([quad('urn:adopt', value)])).rejects.toThrow('worker exited');
  }
  control.mode = 'resubmit-readonly'; control.writes = [];
  await expect(s.insert([quad('urn:adopt', value)])).rejects.toThrow('readonly');
  expect(control.writes).toMatchObject([{ hash: hash(value), bytes: Buffer.byteLength(value), payloadHash: hash(value) }]);
  await expect(s.query(select('urn:adopt'))).resolves.toMatchObject({ bindings: [] });
  await expect(owner(f.directory).read(hash(value))).resolves.toBe(value);
  await s.insert([quad('urn:adopt', value)]);
  expect(control.writes).toHaveLength(2);
  expect(control.writes[1]).toMatchObject({ hash: hash(value), bytes: Buffer.byteLength(value), payloadHash: hash(value) });
  await expect(s.query(select('urn:adopt'))).resolves.toMatchObject({ bindings: [{ value }] });
});

it.each(['full', 'before-commit'])('rejects every collected group member on native %s, drains close and permits ordinary retry', async fault => {
  const f = await fixture(), s = await composed(f.root); await s.insert([quad('urn:seed')]);
  control.mode = 'collect-'+fault;
  const values = Array.from({ length: 8 }, (_, i) => JSON.stringify('immutable exact bytes '.repeat(4096)+'failed-group-'+i));
  const subjects = values.map((_, i) => 'urn:failed-group:'+i);
  const settled = Promise.allSettled(values.map((term, i) => s.insert([quad(subjects[i]!, term)])));
  let timeout: NodeJS.Timeout | undefined;
  let outcomes: Awaited<typeof settled>;
  try {
    outcomes = await Promise.race([settled, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Every failed group member must settle')), 3_000);
    })]);
  } catch (error) {
    // A broken failure fan-out must fail without leaving its accepted work stranded.
    await Promise.all(control.instances.map(worker => worker.terminate()));
    await settled; throw error;
  } finally { clearTimeout(timeout); }
  expect(outcomes.every(result => result.status === 'rejected')).toBe(true);
  for (const result of outcomes) {
    if (result.status !== 'rejected') throw new Error('Expected failed group member');
    expect(String(result.reason)).toContain(fault === 'full' ? 'database or disk is full' : 'worker exited');
  }
  for (const subject of subjects) await expect(s.query(select(subject))).resolves.toMatchObject({ bindings: [] });
  expect((await asChangelogReader(s)!.readChanges(0, 20)).map(change => change.seq)).toEqual([1]);
  // In particular, failed accepted work must not strand physical or logical drainage.
  await s.close();
  const retry = await composed(f.root);
  await Promise.all(values.map((term, i) => retry.insert([quad(subjects[i]!, term)])));
  for (const [i, subject] of subjects.entries()) {
    await expect(retry.query(select(subject))).resolves.toMatchObject({ bindings: [{ value: values[i] }] });
  }
  expect((await asChangelogReader(retry)!.readChanges(0, 20)).map(change => change.seq)).toEqual([1,2,3,4,5,6,7,8,9]);
  await retry.close();
});

it('refuses writes sent to the fixed read-only worker without creating a missing database', async () => {
  const f = await fixture(), o = owner(f.directory);
  await expect(o.read(hash(value))).resolves.toBeUndefined();
  const reader = control.instances[0]!;
  const response = new Promise<{ error?: { message: string } }>(resolve => {
    const onMessage = (message: { id?: number; error?: { message: string } }) => {
      if (message.id === 90001) { reader.off('message', onMessage); resolve(message); }
    };
    reader.on('message', onMessage);
  });
  reader.postMessage({ id: 90001, operation: 'write', hash: hash(value), term: value });
  await expect(response).resolves.toMatchObject({ error: { message: 'Literal blob read owner cannot write' } });
  await expect(o.read(hash(value))).resolves.toBeUndefined(); expect(await readdir(f.root)).toEqual([]);
});
