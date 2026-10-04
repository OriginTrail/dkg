import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TripleStore } from '../src/triple-store.js';
import { ChangelogStore, GraphSetIndexStore, OxigraphStore, OxigraphWorkerStore, SharedMemoryLiteralBlobStore, SparqlHttpStore,
  createManagedOxigraphRuntimeStoreConfigV1, createTripleStore } from '../src/index.js';

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function persistentStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dkg-certified-persistence-')); directories.push(dir);
  return new OxigraphStore(join(dir, 'store.nq'));
}

describe('storage persistence boundary', () => {
  it('runs a real composed store barrier on the outer store with the caller options', async () => {
    const backend = await persistentStore(), store = new ChangelogStore(new GraphSetIndexStore(backend));
    const innerFlush = vi.spyOn(backend, 'flush'), outerPersist = vi.spyOn(store, 'persist');
    const options = { source: 'persistence-boundary-test' };
    try {
      await store.insert([{ graph: 'urn:persistence', subject: 'urn:asset', predicate: 'urn:value', object: '"durable"' }]);
      await store.persist!(options);
      expect(outerPersist).toHaveBeenCalledWith(options); expect(innerFlush).toHaveBeenCalledWith(options);
    } finally { await store.close(); }
  });
  it('refuses a decorator-only no-op flush around an uncertified endpoint', async () => {
    const endpoint = new SparqlHttpStore({ queryEndpoint: 'http://untrusted.test/query', consistencyProfile: 'atomic-readback' });
    const store = new ChangelogStore(new GraphSetIndexStore(endpoint));
    expect(typeof store.flush).toBe('function'); expect(store.persist).toBeUndefined();
    await store.close();
  });
  it('does not accept a persistence callback from generic managed-looking endpoint options', async () => {
    const flush = vi.fn(async () => {});
    const endpoint = new SparqlHttpStore({ queryEndpoint: 'http://localhost/query',
      managedByDkg: true, managedOxigraph: true, managedPersistence: flush });
    expect(endpoint.flush).toBeUndefined(); expect(endpoint.persist).toBeUndefined();
    expect(flush).not.toHaveBeenCalled(); await endpoint.close();
  });
  it('accepts the runtime-owned barrier and loses that authority when the runtime brand is omitted', async () => {
    const flush = vi.fn(async () => {}), options = { source: 'owned-persistence' };
    const config = createManagedOxigraphRuntimeStoreConfigV1({ backend: 'sparql-http', options: {
      queryEndpoint: 'http://127.0.0.1/query', managedByDkg: true, managedPersistence: flush,
    } });
    const store = await createTripleStore(config), untrusted = await createTripleStore({ ...config });
    try {
      expect(untrusted.persist).toBeUndefined();
      await store.persist!(options);
      expect(flush).toHaveBeenCalledExactlyOnceWith(options);
    } finally { await store.close(); await untrusted.close(); }
  });
  it('accepts a separately certified acknowledgement through decorators', async () => {
    const endpoint = new SparqlHttpStore({ queryEndpoint: 'http://durable.test/query', writesDurableOnAcknowledgement: true });
    const store = new ChangelogStore(new GraphSetIndexStore(endpoint)), outerPersist = vi.spyOn(store, 'persist');
    await store.persist!();
    expect(outerPersist).toHaveBeenCalledOnce(); await store.close();
  });
  it('does not retire evidence after an outer persistence error', async () => {
    const backend = await persistentStore(), store = new GraphSetIndexStore(backend), failure = new Error('disk unavailable');
    vi.spyOn(backend, 'flush').mockRejectedValueOnce(failure);
    await expect(store.persist!()).rejects.toBe(failure);
    await store.close();
  });
});


describe('explicit persistence certification', () => {
  it('uses an explicit callable without inspecting a decorator topology or flush', async () => {
    const persist = vi.fn(async () => {});
    const store = { persist, get innerStore() { throw new Error('topology is not a persistence contract'); } } as unknown as TripleStore;
    const options = { source: 'explicit-capability' };
    await store.persist!(options);
    expect(persist).toHaveBeenCalledExactlyOnceWith(options);
  });
  it('refuses an arbitrary flush-only leaf and an acknowledgement flag without a callable', () => {
    expect(({ flush: vi.fn(async () => {}) } as unknown as TripleStore).persist).toBeUndefined();
    expect(({ writesDurableOnAcknowledgement: true } as unknown as TripleStore).persist).toBeUndefined();
  });
  it('does not certify an in-memory adapter whose optional flush cannot survive restart', async () => {
    const store = new OxigraphStore();
    try { expect(store.persist).toBeUndefined(); } finally { await store.close(); }
  });
  it('drains a held outer mutation before the inner barrier, including changelog markers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-composed-persistence-')), path = join(dir, 'store.nq');
    const backend = new OxigraphStore(path), store = new ChangelogStore(new GraphSetIndexStore(backend));
    const realInsert = backend.insert.bind(backend); let release!: () => void, entered = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(backend, 'insert').mockImplementation(async (quads, options) => {
      if (quads.some(q => q.subject === 'urn:held-asset')) { entered = true; await held; }
      await realInsert(quads, options);
    });
    const flushed = vi.spyOn(backend, 'flush'); let persisted = false;
    const mutation = store.insert([{ graph: 'urn:held-graph', subject: 'urn:held-asset', predicate: 'urn:value', object: '"held"' }]);
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      const barrier = store.persist!().then(() => { persisted = true; });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(persisted).toBe(false); expect(flushed).not.toHaveBeenCalled();
      release(); await mutation; await barrier;
      expect(await store.headSeq()).toBe(1);
      const reopened = new OxigraphStore(path);
      try { expect(await reopened.query('ASK { GRAPH <urn:held-graph> { <urn:held-asset> <urn:value> "held" } }')).toMatchObject({ value: true }); }
      finally { await reopened.close(); }
    } finally { release(); await mutation; await store.close(); await rm(dir, { recursive: true, force: true }); }
  });
});


describe('certified adapter and decorator composition', () => {
  it('binds a receiver-dependent certified adapter method through all outer barriers and survives reopen', async () => {
    const backend = await persistentStore(), path = join(directories.at(-1)!, 'store.nq');
    backend.persist = async function (options) { await this.flush(options); };
    const dir = await mkdtemp(join(tmpdir(), 'dkg-bound-persistence-')); directories.push(dir);
    const store = new ChangelogStore(new GraphSetIndexStore(new SharedMemoryLiteralBlobStore(backend, { blobDir: dir, thresholdBytes: 1024 })));
    const barrier = store.persist!;
    try {
      await store.insert([{ graph: 'urn:receiver', subject: 'urn:asset', predicate: 'urn:value', object: '"bound"' }]);
      await barrier({ source: 'detached-outer-barrier' });
      const reopened = new OxigraphStore(path);
      try { expect(await reopened.query('ASK { GRAPH <urn:receiver> { <urn:asset> <urn:value> "bound" } }')).toMatchObject({ value: true }); }
      finally { await reopened.close(); }
    } finally { await store.close(); }
  });

  it.each(['graph-index', 'literal-blob', 'changelog'] as const)('keeps an uncertified endpoint uncertified through %s', async decorator => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-persistence-wrapper-')); directories.push(dir);
    const endpoint = new SparqlHttpStore({ queryEndpoint: 'http://uncertified.test/query' });
    const store = decorator === 'graph-index' ? new GraphSetIndexStore(endpoint)
      : decorator === 'literal-blob' ? new SharedMemoryLiteralBlobStore(endpoint, { blobDir: dir, thresholdBytes: 10 })
        : new ChangelogStore(endpoint);
    try { expect(store.persist).toBeUndefined(); } finally { await store.close(); }
  });
  it('forwards the certified barrier through literal, graph and changelog decorators in either order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-persistence-permutation-')); directories.push(dir);
    for (const outside of ['literal', 'changelog'] as const) {
      const backend = new OxigraphStore(join(dir, `${outside}.nq`));
      const store = outside === 'literal'
        ? new SharedMemoryLiteralBlobStore(new GraphSetIndexStore(new ChangelogStore(backend)), { blobDir: join(dir, `${outside}-blobs`), thresholdBytes: 10 })
        : new ChangelogStore(new GraphSetIndexStore(new SharedMemoryLiteralBlobStore(backend, { blobDir: join(dir, `${outside}-blobs`), thresholdBytes: 10 })));
      const flush = vi.spyOn(backend, 'flush'), options = { source: `composed-${outside}` };
      try { await store.persist!(options); expect(flush).toHaveBeenCalledExactlyOnceWith(options); }
      finally { await store.close(); }
    }
  });
  it('certifies a real persistent worker, preserves its queued mutations, and refuses a memory worker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-worker-persistence-')); directories.push(dir);
    const path = join(dir, 'worker.nq'), persistent = new OxigraphWorkerStore(path), memory = new OxigraphWorkerStore();
    try {
      expect(memory.persist).toBeUndefined();
      await persistent.insert([{ graph: 'urn:worker', subject: 'urn:asset', predicate: 'urn:value', object: '"persisted"' }]);
      await persistent.persist!();
      const reopened = new OxigraphStore(path);
      try { expect(await reopened.query('ASK { GRAPH <urn:worker> { <urn:asset> <urn:value> "persisted" } }')).toMatchObject({ value: true }); }
      finally { await reopened.close(); }
    } finally { await persistent.close(); await memory.close(); }
  });
  it('checks cancellation before the barrier and after a held backend barrier completes', async () => {
    const backend = await persistentStore(), store = new ChangelogStore(new GraphSetIndexStore(backend));
    const aborted = new AbortController(), reason = new Error('caller retired'); aborted.abort(reason);
    const flush = vi.spyOn(backend, 'flush');
    try {
      await expect(store.persist!({ signal: aborted.signal })).rejects.toBe(reason);
      expect(flush).not.toHaveBeenCalled();
      const controller = new AbortController(); let entered = false, release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      flush.mockImplementationOnce(async () => { entered = true; await held; });
      const barrier = store.persist!({ signal: controller.signal });
      const rejected = expect(barrier).rejects.toBe(reason);
      await vi.waitFor(() => expect(entered).toBe(true)); controller.abort(reason); release(); await rejected;
    } finally { await store.close(); }
  });
});


describe('explicit process-local commitment', () => {
  it.each(['embedded', 'worker'] as const)('commits a real memory %s without certifying restart durability', async adapter => {
    const backend = adapter === 'embedded' ? new OxigraphStore() : new OxigraphWorkerStore();
    const dir = await mkdtemp(join(tmpdir(), 'dkg-ephemeral-wrapper-')); directories.push(dir);
    const store = new ChangelogStore(new GraphSetIndexStore(new SharedMemoryLiteralBlobStore(backend, { blobDir: dir, thresholdBytes: 1024 })));
    try {
      expect(store.persist).toBeUndefined();
      await store.insert([{ graph: 'urn:memory', subject: 'urn:asset', predicate: 'urn:value', object: '"committed"' }]);
      await store.commitEphemeral!();
      expect(await store.headSeq()).toBe(1);
      expect(await store.query('ASK { GRAPH <urn:memory> { <urn:asset> <urn:value> "committed" } }')).toMatchObject({ value: true });
    } finally { await store.close(); }
  });
  it('does not grant a remote endpoint process-local authority through composed decorators', async () => {
    const store = new ChangelogStore(new GraphSetIndexStore(new SparqlHttpStore({ queryEndpoint: 'http://untrusted.test/query' })));
    try { expect(store.commitEphemeral).toBeUndefined(); } finally { await store.close(); }
  });
  it('waits for an outer queued mutation and propagates a process-local barrier failure', async () => {
    const backend = new OxigraphStore(), store = new ChangelogStore(new GraphSetIndexStore(backend));
    const insert = backend.insert.bind(backend); let release!: () => void, entered = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(backend, 'insert').mockImplementation(async (quads, options) => { entered = true; await held; await insert(quads, options); });
    const failure = new Error('memory worker retired'), flush = vi.spyOn(backend, 'flush').mockRejectedValueOnce(failure);
    const mutation = store.insert([{ graph: 'urn:memory', subject: 'urn:asset', predicate: 'urn:value', object: '"queued"' }]);
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      const barrier = store.commitEphemeral!(), rejected = expect(barrier).rejects.toBe(failure);
      await new Promise(resolve => setImmediate(resolve)); expect(flush).not.toHaveBeenCalled();
      release(); await mutation; await rejected; expect(await store.headSeq()).toBe(1);
    } finally { release(); await mutation; await store.close(); }
  });
});
