import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore, UnsupportedTripleStoreCapabilityError, type TripleStore } from '@origintrail-official/dkg-storage';
import { STORAGE_ACK_LEDGER_GRAPH as GRAPH, STORAGE_ACK_LEDGER_PREDICATES as LEDGER } from '@origintrail-official/dkg-publisher';
import { ContextGraphMetaProjection } from '../src/context-graph-meta-projection.js';
import { DKGAgent } from '../src/dkg-agent.js';
import { VmPromotionMethods } from '../src/dkg-agent-vm-promotion.js';
import { createProjectionMutationObserver } from '../src/internal/projection-mutation-observer.js';
import { createStoreMutationOwner } from '../src/internal/observed-store-mutation.js';
import { createMutationObservedStore } from '../src/internal/context-graph-cache-invalidating-store.js';
import { createStorageAckLedgerTimestampWriter } from '../src/internal/storage-ack-ledger-timestamp-writer.js';

const SUBJECT = 'urn:dkg:share:test:storage-ack-proof';
const WHEN = new Date('2026-01-01T00:00:00.000Z');
const options = { source: 'agent.storageAckLedger.mark', touchedGraphs: [GRAPH] };
const predicates = [LEDGER.registeredAt, LEDGER.absentSeenAt, LEDGER.unregisteredAt,
  LEDGER.supersededAt, LEDGER.epoch, LEDGER.grandfatheredThrough, LEDGER.seenAt];
const stores: OxigraphStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });

async function stack() {
  const raw = new OxigraphStore(); stores.push(raw);
  const projection = new ContextGraphMetaProjection(raw);
  await projection.recipientKeyRouteFence.ensureReady();
  const invalidate = vi.fn();
  const mutationOwner = createStoreMutationOwner(invalidate, createProjectionMutationObserver(() => projection));
  const execute = mutationOwner.execute;
  return { raw, projection, invalidate, store: createMutationObservedStore(raw, mutationOwner),
    writer: createStorageAckLedgerTimestampWriter(raw, execute) };
}

async function rows(store: TripleStore) {
  return store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${GRAPH}> { ?s ?p ?o } } ORDER BY ?s ?p ?o`);
}

describe('closed StorageACK ledger timestamp writer', () => {
  it.each(predicates)('replaces only the exact timestamp pair without moving authority: %s', async predicate => {
    const { raw, writer, projection, invalidate } = await stack();
    await raw.insert([
      { graph: GRAPH, subject: SUBJECT, predicate, object: '"old"' },
      { graph: GRAPH, subject: SUBJECT, predicate: 'urn:test:keep', object: '"keep"' },
    ]);
    const revision = projection.recipientKeyRouteFence.revision;
    const peer = projection.peerGateRevision.read('urn:test:cg');
    const original = raw.update;
    const update = vi.spyOn(raw, 'update').mockImplementation(async function (this: OxigraphStore, query, opts) {
      expect(this).toBe(raw);
      expect(projection.recipientKeyRouteFence.hasPendingWrites).toBe(false);
      await original.call(this, query, opts);
    });
    expect(await writer(SUBJECT, predicate, WHEN, options)).toBe(true);
    expect(update).toHaveBeenCalledOnce(); expect(update.mock.calls[0]![1]).toBe(options);
    expect(await rows(raw)).toEqual({ type: 'bindings', bindings: [
      { s: SUBJECT, p: predicate, o: '"2026-01-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>' },
      { s: SUBJECT, p: 'urn:test:keep', o: '"keep"' },
    ] });
    expect(projection.recipientKeyRouteFence.revision).toBe(revision);
    expect(projection.peerGateRevision.read('urn:test:cg')).toBe(peer);
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it.each(['failure', 'postcommit', 'unsupported'] as const)('propagates %s without replay, preserving exact scope while held', async mode => {
    const { raw, writer, projection } = await stack();
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const failure = mode === 'unsupported' ? new UnsupportedTripleStoreCapabilityError('update', 'test') : new Error('lost response');
    const update = raw.update.bind(raw);
    vi.spyOn(raw, 'update').mockImplementation(async (query, opts) => {
      enter(); await held;
      if (mode === 'postcommit') await update(query, opts);
      throw failure;
    });
    const insert = vi.spyOn(raw, 'insert');
    const revision = projection.recipientKeyRouteFence.revision;
    const operation = writer(SUBJECT, LEDGER.seenAt, WHEN, options).catch(error => error);
    await entered;
    try {
      expect(projection.recipientKeyRouteFence.hasPendingWrites).toBe(false);
      expect(projection.recipientKeyRouteFence.cacheable).toBe(true);
    } finally { release(); }
    expect(await operation).toBe(failure); expect(insert).not.toHaveBeenCalled();
    expect(projection.recipientKeyRouteFence.revision).toBe(revision);
    const result = await rows(raw);
    expect(result.type === 'bindings' && result.bindings.length).toBe(mode === 'postcommit' ? 1 : 0);
  });

  it('retains insert-only mark fallback with no update capability', async () => {
    const { raw, writer, store } = await stack();
    Object.defineProperty(raw, 'update', { value: undefined, configurable: true });
    Object.defineProperty(store, 'update', { value: undefined, configurable: true });
    const insert = vi.spyOn(raw, 'insert');
    await VmPromotionMethods.prototype.markStorageAckLedger.call({ store, storageAckLedgerTimestampWriter: writer } as never, SUBJECT, LEDGER.seenAt, WHEN.getTime());
    expect(insert).toHaveBeenCalledOnce();
  });

  it('keeps initialization refusal and heartbeat no-op when update is absent', async () => {
    const { store, writer, raw } = await stack();
    Object.defineProperty(store, 'update', { value: undefined, configurable: true });
    const write = vi.fn(writer); const insert = vi.spyOn(raw, 'insert');
    const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    const host = { store, storageAckLedgerTimestampWriter: write, log,
      vmPromotionAuditStatus: {}, vmPromotionAuditActive: () => true,
      ensureStorageAckLedgerReady: async () => true,
      pruneStorageAckLedgerOrphans: async () => 0,
      backfillCoreHostedStorageAckGraphs: async () => ({ namespaces: 0, wrapped: false, recorded: 0, pending: 0, unresolved: 0 }),
      auditStorageAckCopies: async () => ({ examined: 0, stale: 0, stalled: 0, absent: 0, expired: 0, superseded: 0, reconciled: 0, promoted: 0 }),
    };
    expect(await VmPromotionMethods.prototype.ensureStorageAckLedgerReady.call(host as never)).toBe(false);
    expect(log.warn).toHaveBeenCalledOnce();
    await VmPromotionMethods.prototype.executeVmPromotionAudit.call(host as never);
    expect(write).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('keeps historical non-timestamp mark predicates on the conservative route', async () => {
    const { store, writer, projection } = await stack();
    const before = projection.recipientKeyRouteFence.revision;
    await VmPromotionMethods.prototype.markStorageAckLedger.call({ store, storageAckLedgerTimestampWriter: writer } as never,
      SUBJECT, 'urn:test:historical-predicate', WHEN.getTime());
    expect(projection.recipientKeyRouteFence.revision).toBeGreaterThan(before);
  });
  it('refuses unknown predicates and unsafe subjects before dispatch', async () => {
    const { raw, writer } = await stack(); const update = vi.spyOn(raw, 'update');
    await expect(writer(SUBJECT, 'urn:test:unknown', WHEN, options)).rejects.toThrow();
    await expect(writer('urn:bad> }', LEDGER.seenAt, WHEN, options)).rejects.toThrow();
    await expect(writer(SUBJECT, LEDGER.seenAt, new Date(NaN), options)).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps arbitrary update observations fail closed, including uncertain outcomes', async () => {
    const { raw, store, projection } = await stack();
    const before = projection.recipientKeyRouteFence.revision;
    const update = raw.update.bind(raw);
    vi.spyOn(raw, 'update').mockImplementation(async (query, opts) => { await update(query, opts); throw new Error('unknown outcome'); });
    await expect(store.update!(`INSERT DATA { GRAPH <urn:test:other> { <urn:test:s> <urn:test:p> "x" } }`)).rejects.toThrow('unknown outcome');
    expect(projection.recipientKeyRouteFence.revision).toBeGreaterThan(before);
    expect(projection.recipientKeyRouteFence.cacheable).toBe(false);
  });

  it('production DKGAgent.create wires mark to its configured store and scoped observation', async () => {
    const raw = new OxigraphStore();
    const agent = await DKGAgent.create({ name: 'ack-ledger-construction', store: raw,
      chainAdapter: new NoChainAdapter(), rfc64CatalogActivation: { enabled: false } });
    try {
      const projection = (agent as unknown as { contextGraphMetaProjection: ContextGraphMetaProjection }).contextGraphMetaProjection;
      await projection.recipientKeyRouteFence.ensureReady();
      const revision = projection.recipientKeyRouteFence.revision;
      const update = vi.spyOn(raw, 'update');
      await agent.markStorageAckLedger(SUBJECT, LEDGER.registeredAt, WHEN.getTime());
      expect(update).toHaveBeenCalledOnce(); expect(update.mock.calls[0]![1]).toEqual(options);
      expect(projection.recipientKeyRouteFence.revision).toBe(revision);
      const result = await rows(raw);
      expect(result.type === 'bindings' && result.bindings.length).toBe(1);
    } finally { await agent.stop(); }
  });
});