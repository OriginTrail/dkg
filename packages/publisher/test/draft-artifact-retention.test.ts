import { TripleStoreAsyncLiftPublisher } from '../src/async-lift-publisher-impl.js';
import { seedLegacyRawLiftTestJob } from './_helpers/legacy-raw-lift.js';
import { CONTROL_JOB_TYPE, CONTROL_PAYLOAD, CONTROL_REQUEST_TYPE, RDF_TYPE_PREDICATE, jobSubject } from '../src/async-lift-control-plane.js';
import { KA_VM_VALIDATION, kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';
import { describe, expect, it, vi } from 'vitest';
import { OxigraphStore, UnsupportedTripleStoreCapabilityError, type TripleStore } from '@origintrail-official/dkg-storage';
import { withDraftArtifactCollection, withDraftArtifactReferences, readDraftArtifactReferences, draftOperationReferenceKey, draftPrivateReferenceKey, markDraftOperationRetired, assertDraftOperationNotRetired } from '../src/draft-artifact-retention.js';

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

describe('draft artifact operation leases and exclusive collection', () => {
  it('excludes operations during collection and releases the fence after collector failure', async () => {
    const store = {} as TripleStore; const held = gate(); const entered = gate();
    const failure = new Error('collector failed');
    const collecting = withDraftArtifactCollection(store, async () => { entered.release(); await held.promise; throw failure; }).catch(error => error);
    await entered.promise;
    let admitted = false;
    const admission = withDraftArtifactReferences(store, async () => { admitted = true; });
    await tick(); expect(admitted).toBe(false);
    held.release(); expect(await collecting).toBe(failure); await admission;
    expect(admitted).toBe(true);
    await expect(withDraftArtifactCollection(store, async () => 'next')).resolves.toBe('next');
  });

  it('waits for every shared lease, releases failed operations and serializes collectors', async () => {
    const store = {} as TripleStore; const a = gate(); const b = gate(); const firstCollector = gate(); const startedCollector = gate();
    const failure = new Error('signer failed');
    const operationA = withDraftArtifactReferences(store, async () => { await a.promise; throw failure; }).catch(error => error);
    const operationB = withDraftArtifactReferences(store, () => b.promise);
    let firstStarted = false; let secondStarted = false;
    const first = withDraftArtifactCollection(store, async () => { firstStarted = true; startedCollector.release(); await firstCollector.promise; });
    const second = withDraftArtifactCollection(store, async () => { secondStarted = true; });
    a.release(); expect(await operationA).toBe(failure); await tick(); expect(firstStarted).toBe(false);
    b.release(); await operationB; await startedCollector.promise;
    expect(secondStarted).toBe(false);
    firstCollector.release(); await Promise.all([first, second]); expect(secondStarted).toBe(true);
  });
});


describe('durable draft queue references and retirement admission', () => {
  it('retains raw root/subgraph namespaces and complete named private version identity from real persisted jobs', async () => {
    const store = new OxigraphStore();
    try {
      const queue = new TripleStoreAsyncLiftPublisher(store);
      const kaUal = 'did:dkg:31337/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/7';
      const request = kaVmPublishRequest({ contextGraphId: 'named', subGraphName: 'team', shareOperationId: 'queued', kaUal, assertionVersion: '3' });
      await queue.enqueueKnowledgeAssetVmPublish(request);
      const raw = { swmId: 'legacy', shareOperationId: 'raw-root', roots: ['urn:root'], contextGraphId: 'raw', namespace: 'raw', scope: 'roots', transitionType: 'CREATE' as const, authority: { type: 'owner' as const, proofRef: 'owner' } };
      await seedLegacyRawLiftTestJob(store, raw);
      await seedLegacyRawLiftTestJob(store, { ...raw, subGraphName: 'team', shareOperationId: 'raw-team' });
      const references = await readDraftArtifactReferences(store);
      expect(references?.operations).toEqual(new Set([draftOperationReferenceKey('named', 'team', 'queued'), draftOperationReferenceKey('raw', undefined, 'raw-root'), draftOperationReferenceKey('raw', 'team', 'raw-team')]));
      expect(references?.privateVersions).toEqual(new Set([draftPrivateReferenceKey('named', 'team', '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '7', '3')]));
      expect(references?.rawNamespaces).toEqual(new Set([JSON.stringify(['raw', '']), JSON.stringify(['raw', 'team'])]));
      await markDraftOperationRetired(store, 'named', 'team', 'retired', Date.now());
      await expect(queue.enqueueKnowledgeAssetVmPublish({ ...request, name: 'retired', shareOperationId: 'retired' })).rejects.toMatchObject({ code: 'PUBLISH_INTENT_STALE' });
      await expect(assertDraftOperationNotRetired(store, request)).resolves.toBeUndefined();
    } finally { await store.close(); }
  });

  it.each(['missing-payload', 'malformed-payload', 'orphan-request', 'over-budget'] as const)('fails closed for real %s queue state', async damage => {
    const store = new OxigraphStore();
    try {
      const graph = 'urn:test:damaged-queue';
      if (damage === 'orphan-request') await store.insert([{ graph, subject: 'urn:request', predicate: RDF_TYPE_PREDICATE, object: CONTROL_REQUEST_TYPE }]);
      else {
        const size = damage === 'over-budget' ? 257 : 1;
        await store.insert(Array.from({ length: size }, (_, index) => ({ graph, subject: `urn:job:${index}`, predicate: RDF_TYPE_PREDICATE, object: CONTROL_JOB_TYPE })));
        if (damage === 'malformed-payload') await store.insert([{ graph, subject: 'urn:job:0', predicate: CONTROL_PAYLOAD, object: '"not-json"' }]);
      }
      expect(await readDraftArtifactReferences(store)).toBeNull();
    } finally { await store.close(); }
  });

  it.each(['orphanRequests', 'queueReferences'] as const)('fails closed when %s acquisition has an unexpected response type', async source => {
    const store = new OxigraphStore(); const original = store.query.bind(store);
    vi.spyOn(store, 'query').mockImplementation((text, options) => options?.source === `publisher.draftArtifacts.${source}` ? Promise.resolve(source === 'orphanRequests' ? { type: 'bindings', bindings: [] } : { type: 'boolean', value: false }) : original(text, options));
    try { expect(await readDraftArtifactReferences(store)).toBeNull(); }
    finally { vi.restoreAllMocks(); await store.close(); }
  });

  it('refuses admission when retirement evidence is unavailable', async () => {
    const store = new OxigraphStore(); vi.spyOn(store, 'query').mockResolvedValue({ type: 'bindings', bindings: [] });
    try { await expect(assertDraftOperationNotRetired(store, kaVmPublishRequest())).rejects.toThrow('Cannot determine draft artifact retirement state'); }
    finally { vi.restoreAllMocks(); await store.close(); }
  });
});


describe('coherent persisted draft queue acquisition', () => {
  it.each(['absent', 'refused'] as const)('waits through a real %s atomic-capability fallback before reading references', async mode => {
    const inner = new OxigraphStore(); const deleted = gate(); const insertJob = gate();
    let armed = false; let jobRef = ''; let acquired = false;
    const store = new Proxy(inner, { get(target, property) {
      if (property === 'replaceSubject') return mode === 'absent' ? undefined : async () => {
        throw new UnsupportedTripleStoreCapabilityError('replaceSubject', 'non-atomic test backend');
      };
      if (property === 'deleteByPatternWithoutCount') return async (...args: Parameters<OxigraphStore['deleteByPatternWithoutCount']>) => {
        await target.deleteByPatternWithoutCount(...args);
        if (armed && args[0].subject === jobRef) { deleted.release(); await insertJob.promise; }
      };
      if (property === 'query') return async (...args: Parameters<OxigraphStore['query']>) => {
        if (armed && args[1]?.source === 'publisher.draftArtifacts.orphanRequests') acquired = true;
        return target.query(...args);
      };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const queue = new TripleStoreAsyncLiftPublisher(store);
    const request = kaVmPublishRequest({ shareOperationId: 'retained-during-fallback' });
    const id = await queue.enqueueKnowledgeAssetVmPublish(request); await queue.claimNext('wallet'); jobRef = jobSubject(id);
    let transition: Promise<void> | undefined; let reading: ReturnType<typeof readDraftArtifactReferences> | undefined;
    try {
      armed = true; transition = queue.update(id, 'validated', { validation: KA_VM_VALIDATION });
      await deleted.promise; expect(await queue.getStatus(id)).toBeNull();
      reading = readDraftArtifactReferences(store); await tick(); expect(acquired).toBe(false);
      insertJob.release(); await transition;
      expect((await reading)?.operations).toContain(draftOperationReferenceKey(request.contextGraphId, request.subGraphName, request.shareOperationId));
      expect(acquired).toBe(true); expect((await queue.getStatus(id))?.status).toBe('validated');
    } finally { insertJob.release(); await Promise.allSettled([transition, reading]); await inner.close(); }
  });

  it.each(['reader-first', 'delete-first'] as const)('serializes real cancellation deletion and both reference queries: %s', async order => {
    const inner = new OxigraphStore(); const held = gate(); const entered = gate();
    let armed = false; let jobRef = ''; let deleted = false; let acquired = false;
    const store = new Proxy(inner, { get(target, property) {
      if (property === 'query') return async (...args: Parameters<OxigraphStore['query']>) => {
        const result = await target.query(...args);
        if (armed && args[1]?.source === 'publisher.draftArtifacts.orphanRequests') {
          acquired = true; if (order === 'reader-first') { entered.release(); await held.promise; }
        }
        return result;
      };
      if (property === 'deleteByPatternWithoutCount') return async (...args: Parameters<OxigraphStore['deleteByPatternWithoutCount']>) => {
        await target.deleteByPatternWithoutCount(...args);
        if (armed && args[0].subject === jobRef) {
          deleted = true; if (order === 'delete-first') { entered.release(); await held.promise; }
        }
      };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const queue = new TripleStoreAsyncLiftPublisher(store); const request = kaVmPublishRequest();
    const id = await queue.enqueueKnowledgeAssetVmPublish(request); jobRef = jobSubject(id);
    let reading: ReturnType<typeof readDraftArtifactReferences> | undefined; let clearing: ReturnType<typeof queue.cancel> | undefined;
    try {
      armed = true;
      if (order === 'reader-first') {
        reading = readDraftArtifactReferences(store); await entered.promise; clearing = queue.cancel(id);
        await tick(); expect(deleted).toBe(false);
      } else {
        clearing = queue.cancel(id); await entered.promise; reading = readDraftArtifactReferences(store);
        await tick(); expect(acquired).toBe(false);
      }
      held.release(); expect(await clearing).toBeUndefined();
      const references = await reading;
      expect(references).not.toBeNull();
      expect(references?.operations).toEqual(new Set(order === 'reader-first' ? [draftOperationReferenceKey(request.contextGraphId, request.subGraphName, request.shareOperationId)] : []));
      expect(await queue.getStatus(id)).toBeNull();
      expect((await readDraftArtifactReferences(store))?.operations.size).toBe(0);
    } finally { held.release(); await Promise.allSettled([reading, clearing]); await inner.close(); }
  });

  it('releases the queue fence after persistence and reference-read errors', async () => {
    const store = new OxigraphStore(); const queue = new TripleStoreAsyncLiftPublisher(store);
    const original = store.insert.bind(store); let failed = false;
    vi.spyOn(store, 'insert').mockImplementation(async (...args) => {
      if (!failed) { failed = true; throw new Error('request storage unavailable'); }
      return original(...args);
    });
    try {
      await expect(queue.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest())).rejects.toThrow('request storage unavailable');
      await queue.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      vi.spyOn(store, 'query').mockRejectedValueOnce(new Error('queue read unavailable'));
      await expect(readDraftArtifactReferences(store)).rejects.toThrow('queue read unavailable');
      expect((await readDraftArtifactReferences(store))?.operations.size).toBe(1);
    } finally { vi.restoreAllMocks(); await store.close(); }
  });
});
