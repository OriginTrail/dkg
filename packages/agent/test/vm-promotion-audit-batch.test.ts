import { afterEach, describe, expect, it, vi } from 'vitest';
import { contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { xsdDateTimeLiteral } from '@origintrail-official/dkg-publisher';
import { OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { DKGAgentBase } from '../src/dkg-agent-base.js';
import type { DKGAgent } from '../src/dkg-agent.js';
import { VmPromotionMethods } from '../src/dkg-agent-vm-promotion.js';
import {
  parseStorageAckLedgerCandidate,
  storageAckPromotedBatchQuery,
  type StorageAckLedgerCandidate,
} from '../src/vm-promotion-audit.js';

const DKG = 'http://dkg.io/ontology/';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const ual = (n: number) => `did:dkg:otp:20430/${AUTHOR}/${n}`;

function candidate(n: number, namespace: string, version = 1n): StorageAckLedgerCandidate {
  return {
    operationSubject: `urn:op:${namespace}:${n}`,
    namespace,
    kaUal: ual(n),
    assertionVersion: version,
    signedAtMs: Date.now() - 2 * 60 * 60_000,
    registered: false,
  };
}

async function confirm(store: TripleStore, copy: StorageAckLedgerCandidate, version = copy.assertionVersion) {
  const graph = contextGraphMetaUri(copy.namespace);
  await store.insert([
    { subject: copy.kaUal, predicate: `${DKG}status`, object: '"confirmed"', graph },
    { subject: copy.kaUal, predicate: `${DKG}assertionVersion`,
      object: `"${version}"^^<http://www.w3.org/2001/XMLSchema#integer>`, graph },
  ]);
}

function auditRow(copy: StorageAckLedgerCandidate): Record<string, string> {
  return {
    op: copy.operationSubject,
    namespace: `"${copy.namespace}"`,
    ka: copy.kaUal,
    version: `"${copy.assertionVersion}"`,
    signedAt: xsdDateTimeLiteral(new Date(copy.signedAtMs)),
    target: '"55"',
  };
}

function host(store: TripleStore) {
  return {
    store,
    config: {},
    vmPromotionAuditCursor: '',
    promotedStorageAckCopies: VmPromotionMethods.prototype.promotedStorageAckCopies,
    storageAckCopyTarget: vi.fn(() => '55'),
    classifyStorageAckCopy: vi.fn(async () => 'unknown'),
    log: { warn: vi.fn() },
  };
}

describe('VM promotion batch audit', () => {
  const stores: OxigraphStore[] = [];
  const statics: Array<() => void> = [];
  const store = () => {
    const created = new OxigraphStore();
    stores.push(created);
    return created;
  };
  const setStatic = (name: string, value: number) => {
    const values = DKGAgentBase as unknown as Record<string, number>;
    const previous = values[name];
    values[name] = value;
    statics.push(() => { values[name] = previous!; });
  };
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const restore of statics.splice(0)) restore();
    await Promise.all(stores.splice(0).map((entry) => entry.close()));
  });

  it('uses one graph-scoped query for exact graphs and version floors', async () => {
    const backend = store();
    const a1 = candidate(201, 'batch-a');
    const a2 = candidate(202, 'batch-a', 2n);
    const b1 = candidate(203, 'batch-b');
    const b2 = candidate(204, 'batch-b');
    const shadow = { ...candidate(205, 'batch-shadow'), kaUal: a1.kaUal };
    await confirm(backend, a1);
    await confirm(backend, a2, 1n);
    await confirm(backend, b1, 2n);
    await confirm(backend, candidate(205, 'batch-shadow'));
    const fixture = host(backend);
    const query = vi.spyOn(backend, 'query');
    await expect(VmPromotionMethods.prototype.isStorageAckCopyPromoted.call(
      fixture as unknown as DKGAgent, a1,
    )).resolves.toBe(true);
    await expect(VmPromotionMethods.prototype.isStorageAckCopyPromoted.call(
      fixture as unknown as DKGAgent, shadow,
    )).resolves.toBe(false);
    await expect(VmPromotionMethods.prototype.promotedStorageAckCopies.call(
      fixture as unknown as DKGAgent, [a1, a2, b1, b2, shadow],
    )).resolves.toEqual(new Set([a1.operationSubject, b1.operationSubject]));
    expect(query.mock.calls.filter(([, options]) =>
      options?.source === 'agent.vmPromotionAudit.promotedBatch')).toHaveLength(3);
  });

  it('rejects unsafe IRIs and negative versions before querying', async () => {
    const unsafe = 'urn:op:bad> ?s ?p ?o . <urn:tail';
    expect(parseStorageAckLedgerCandidate({
      ...auditRow(candidate(301, 'safe-cg')), op: unsafe,
    })).toBeNull();
    expect(() => storageAckPromotedBatchQuery([{
      ...candidate(301, 'safe-cg'), operationSubject: unsafe,
    }])).toThrow();
    expect(() => storageAckPromotedBatchQuery([{
      ...candidate(301, 'safe-cg'), assertionVersion: -1n,
    }])).toThrow('non-negative assertion version');
    const backend = store();
    const query = vi.spyOn(backend, 'query');
    await expect(VmPromotionMethods.prototype.promotedStorageAckCopies.call(
      host(backend) as unknown as DKGAgent, [candidate(302, 'safe-cg')], () => false,
    )).resolves.toEqual(new Set());
    expect(query).not.toHaveBeenCalled();
  });

  it('discards a result if the audit deactivates during the query', async () => {
    const backend = store();
    const copy = candidate(303, 'batch-cancel');
    await confirm(backend, copy);
    const original = backend.query.bind(backend);
    let active = true;
    const query = vi.spyOn(backend, 'query').mockImplementation(async (sparql, options) => {
      const result = await original(sparql, options);
      if (options?.source === 'agent.vmPromotionAudit.promotedBatch') active = false;
      return result;
    });
    await expect(VmPromotionMethods.prototype.promotedStorageAckCopies.call(
      host(backend) as unknown as DKGAgent, [copy], () => active,
    )).resolves.toEqual(new Set());
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('stops at the current cursor if prefetch deactivates', async () => {
    const backend = store();
    const copy = candidate(304, 'audit-cancel');
    await confirm(backend, copy);
    const original = backend.query.bind(backend);
    let active = true;
    vi.spyOn(backend, 'query').mockImplementation(async (sparql, options) => {
      if (options?.source === 'agent.vmPromotionAudit.candidates') {
        return { type: 'bindings', bindings: [auditRow(copy)] };
      }
      const result = await original(sparql, options);
      if (options?.source === 'agent.vmPromotionAudit.promotedBatch') active = false;
      return result;
    });
    const fixture = host(backend);
    const result = await VmPromotionMethods.prototype.auditStorageAckCopies.call(
      fixture as unknown as DKGAgent, Date.now(), () => active,
    );
    expect(result.examined).toBe(0);
    expect(fixture.vmPromotionAuditCursor).toBe('');
  });

  it('crosses the 64-copy slice and classifies the next stale row', async () => {
    setStatic('VM_PROMOTION_AUDIT_PAGE_SIZE', 70);
    setStatic('VM_PROMOTION_AUDIT_MAX_CHAIN_CHECKS', 1);
    const backend = store();
    const copies = Array.from({ length: 65 }, (_, i) =>
      candidate(1000 + i, i % 2 === 0 ? 'batch-a' : 'batch-b'));
    await backend.insert(copies.slice(0, 64).flatMap((copy) => {
      const graph = contextGraphMetaUri(copy.namespace);
      return [
        { subject: copy.kaUal, predicate: `${DKG}status`, object: '"confirmed"', graph },
        { subject: copy.kaUal, predicate: `${DKG}assertionVersion`,
          object: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>', graph },
      ];
    }));
    const original = backend.query.bind(backend);
    const query = vi.spyOn(backend, 'query').mockImplementation((sparql, options) =>
      options?.source === 'agent.vmPromotionAudit.candidates'
        ? Promise.resolve({ type: 'bindings', bindings: copies.map(auditRow) })
        : original(sparql, options));
    const fixture = host(backend);
    const result = await VmPromotionMethods.prototype.auditStorageAckCopies.call(
      fixture as unknown as DKGAgent, Date.now(), () => true,
    );
    expect(result).toMatchObject({ examined: 65, stale: 1 });
    expect(fixture.classifyStorageAckCopy).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.filter(([, options]) =>
      options?.source === 'agent.vmPromotionAudit.promotedBatch')).toHaveLength(2);
  });

  it('does not prefetch a second slice after the chain budget is spent', async () => {
    setStatic('VM_PROMOTION_AUDIT_PAGE_SIZE', 70);
    setStatic('VM_PROMOTION_AUDIT_MAX_CHAIN_CHECKS', 1);
    const backend = store();
    const copies = Array.from({ length: 65 }, (_, i) => candidate(2000 + i, 'budget-cg'));
    const original = backend.query.bind(backend);
    const query = vi.spyOn(backend, 'query').mockImplementation((sparql, options) =>
      options?.source === 'agent.vmPromotionAudit.candidates'
        ? Promise.resolve({ type: 'bindings', bindings: copies.map(auditRow) })
        : original(sparql, options));
    const fixture = host(backend);
    const result = await VmPromotionMethods.prototype.auditStorageAckCopies.call(
      fixture as unknown as DKGAgent, Date.now(), () => true,
    );
    expect(result).toMatchObject({ examined: 1, stale: 1 });
    expect(query.mock.calls.filter(([, options]) =>
      options?.source === 'agent.vmPromotionAudit.promotedBatch')).toHaveLength(1);
  });
});
