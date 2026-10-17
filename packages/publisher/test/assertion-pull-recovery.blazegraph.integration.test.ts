import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BlazegraphNamespaceManager, BlazegraphStore, blazegraphNamespaceApiUrlFromSparqlEndpoint,
} from '@origintrail-official/dkg-storage';
import {
  RECOVERY_AUTHOR as AUTHOR, RECOVERY_CG as CG, RECOVERY_NAME as NAME,
  RECOVERY_META, RECOVERY_SUBJECT, RECOVERY_PREDICATES,
  recoveryPublisher, seedRecoveryAsset, seedInterruptedSealClear,
} from './_helpers/pull-recovery.js';

const endpoint = process.env.BLAZEGRAPH_TEST_URL;
const content = (quads: { subject: string; predicate: string; object: string }[]) =>
  quads.map(q => JSON.stringify([q.subject, q.predicate, q.object])).sort();

// test-disable-allow: D1 #3332 -- owner=publisher-lifecycle lane=tornado-blazegraph expires=2026-11-14 Requires the real Blazegraph CI/devnet service; the required backend lane supplies BLAZEGRAPH_TEST_URL.
describe.skipIf(!endpoint)('interrupted SWM pull recovery (live Blazegraph)', () => {
  let manager: BlazegraphNamespaceManager;
  let handles: Awaited<ReturnType<BlazegraphNamespaceManager['acquireMany']>> = [];
  let store: BlazegraphStore;
  beforeEach(async () => {
    manager = new BlazegraphNamespaceManager({
      namespaceApiUrl: blazegraphNamespaceApiUrlFromSparqlEndpoint(endpoint!), requestTimeoutMs: 10_000,
    });
    handles = await manager.acquireMany([`pull-recovery-${randomUUID()}`]);
    expect(handles[0]!.sparqlUrl).not.toBe(endpoint);
    store = new BlazegraphStore(handles[0]!.sparqlUrl, { timeout: 10_000 });
  }, 30_000);
  afterEach(async () => {
    vi.restoreAllMocks();
    try { await store?.close(); }
    finally { if (handles.length) await manager.disposeAll(handles); handles = []; }
  }, 30_000);

  it.each(RECOVERY_PREDICATES.map((_, index) => index + 1))(
    'reconnects and resumes after %i legacy active-seal predicate deletions', async deletedCount => {
      const { finalized } = await seedRecoveryAsset(store);
      await seedInterruptedSealClear(store, deletedCount);
      await store.close();
      store = new BlazegraphStore(handles[0]!.sparqlUrl, { timeout: 10_000 });
      const restarted = await recoveryPublisher(store);
      await expect(restarted.assertionPullFrom(CG, NAME, AUTHOR, 'swm')).resolves.toMatchObject({
        seededPublic: 1, seededPrivate: 1, kaUal: finalized.kaUal,
      });
      expect(content(await restarted.assertionQuery(CG, NAME, AUTHOR))).toEqual(content(finalized.publicQuads));
      expect(content(await restarted.assertionQueryPrivate(CG, NAME, AUTHOR))).toEqual(content(finalized.privateQuads));
    },
  );

  it('rolls back a failed backend clear transaction and resumes a lost committed acknowledgement', async () => {
    const { publisher, finalized } = await seedRecoveryAsset(store);
    const activeQuery = `SELECT ?p ?o WHERE { GRAPH <${RECOVERY_META}> { <${RECOVERY_SUBJECT}> ?p ?o } } ORDER BY ?p ?o`;
    const activeBefore = await store.query(activeQuery);
    const transport = globalThis.fetch;
    let dispatches = 0;
    const intercepted = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      if (typeof init?.body === 'string' && init.body.includes('VALUES ?predicate')
        && init.body.includes(RECOVERY_SUBJECT)) {
        dispatches++;
        // Real backend execution failure AFTER DELETE evaluation must roll back
        // its transaction; this graph already exists, so CREATE is rejected.
        return transport(url, { ...init, body: `${init.body}; CREATE GRAPH <${RECOVERY_META}>` });
      }
      return transport(url, init);
    });
    await expect(publisher.assertionPullFrom(CG, NAME, AUTHOR, 'swm')).rejects.toThrow();
    expect(dispatches).toBe(1);
    intercepted.mockRestore();
    expect(await store.query(activeQuery)).toEqual(activeBefore);

    const update = store.update.bind(store);
    const lost = new Error('test: clear committed but acknowledgement lost');
    let committed = false;
    vi.spyOn(store, 'update').mockImplementation(async (query, options) => {
      await update(query, options);
      if (options?.source === 'publisher.pullFrom.clearActiveSeal') { committed = true; throw lost; }
    });
    await expect(publisher.assertionPullFrom(CG, NAME, AUTHOR, 'swm')).rejects.toBe(lost);
    expect(committed).toBe(true);
    vi.restoreAllMocks();
    await store.close();
    store = new BlazegraphStore(handles[0]!.sparqlUrl, { timeout: 10_000 });
    const restarted = await recoveryPublisher(store);
    await expect(restarted.assertionPullFrom(CG, NAME, AUTHOR, 'swm')).resolves.toMatchObject({ seeded: 2 });
    expect(content(await restarted.assertionQuery(CG, NAME, AUTHOR))).toEqual(content(finalized.publicQuads));
  });
});
