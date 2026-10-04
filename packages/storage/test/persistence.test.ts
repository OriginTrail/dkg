import { describe, expect, it, vi } from 'vitest';
import { ChangelogStore, GraphSetIndexStore, OxigraphStore, SparqlHttpStore, asTripleStorePersistenceCapability } from '../src/index.js';

describe('storage persistence boundary', () => {
  it('runs a real composed store barrier on the outer store with the caller options', async () => {
    const backend = new OxigraphStore(), store = new ChangelogStore(new GraphSetIndexStore(backend));
    const innerFlush = vi.spyOn(backend, 'flush'), outerFlush = vi.spyOn(store, 'flush');
    const options = { source: 'persistence-boundary-test' };
    try {
      await store.insert([{ graph: 'urn:persistence', subject: 'urn:asset', predicate: 'urn:value', object: '"durable"' }]);
      await asTripleStorePersistenceCapability(store)!.persist(options);
      expect(outerFlush).toHaveBeenCalledWith(options); expect(innerFlush).toHaveBeenCalledWith(options);
    } finally { await store.close(); }
  });
  it('refuses a decorator-only no-op flush around an uncertified endpoint', async () => {
    const endpoint = new SparqlHttpStore({ queryEndpoint: 'http://untrusted.test/query', consistencyProfile: 'atomic-readback' });
    const store = new ChangelogStore(new GraphSetIndexStore(endpoint));
    expect(typeof store.flush).toBe('function'); expect(asTripleStorePersistenceCapability(store)).toBeNull();
    await store.close();
  });
  it('does not accept a persistence callback from generic managed-looking endpoint options', async () => {
    const flush = vi.fn(async () => {});
    const endpoint = new SparqlHttpStore({ queryEndpoint: 'http://localhost/query',
      managedByDkg: true, managedOxigraph: true, managedPersistence: flush });
    expect(endpoint.flush).toBeUndefined(); expect(asTripleStorePersistenceCapability(endpoint)).toBeNull();
    expect(flush).not.toHaveBeenCalled(); await endpoint.close();
  });
  it('accepts a separately certified acknowledgement through decorators', async () => {
    const endpoint = new SparqlHttpStore({ queryEndpoint: 'http://durable.test/query', writesDurableOnAcknowledgement: true });
    const store = new ChangelogStore(new GraphSetIndexStore(endpoint)), outerFlush = vi.spyOn(store, 'flush');
    await asTripleStorePersistenceCapability(store)!.persist();
    expect(outerFlush).toHaveBeenCalledOnce(); await store.close();
  });
  it('does not retire evidence after an outer persistence error', async () => {
    const backend = new OxigraphStore(), store = new GraphSetIndexStore(backend), failure = new Error('disk unavailable');
    vi.spyOn(backend, 'flush').mockRejectedValueOnce(failure);
    await expect(asTripleStorePersistenceCapability(store)!.persist()).rejects.toBe(failure);
    await store.close();
  });
});
