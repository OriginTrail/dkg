/**
 * GH#2901 — a failed `swmCurrentAssertion` stamp after the SWM commit must be a
 * recoverable post-commit failure of the SAME share operation, never a success.
 *
 * Real store, real publisher, real `agent.assertion.promote`; only the store is
 * wrapped to fail the pointer maintenance once (seal read, pointer delete,
 * pointer insert), the store calls `_stampSwmPointer` makes. The queue/restart
 * half lives in `packages/cli/test/async-promote-swm-pointer-recovery.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
vi.mock('@origintrail-official/dkg-publisher', () => import('../../publisher/src/index.js'));
import {
  DKGPublisher,
  getPromoteFailureDisposition,
  isStoreOperationProvenNotStarted,
} from '@origintrail-official/dkg-publisher';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  ASSERTION_SEAL_PREDICATES,
  TypedEventBus,
  assertionLifecycleUri,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  generateEd25519Keypair,
} from '@origintrail-official/dkg-core';
import { StoreOperationTimeoutError, StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import { finalizeRootlessAssertionForTest } from '../../publisher/test/_helpers/rootless-lifecycle.js';
import { DKGAgent } from '../src/dkg-agent.js';
import { SwmPointerFaultStore, SWM_POINTER_PRED } from './_helpers/swm-pointer-fault-store.js';

const CG = 'swm-pointer-post-commit-cg';
const NAME = 'pointer-asset';
const AGENT = `0x${'11'.repeat(20)}`;
const PEER = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const DKG = 'http://dkg.io/ontology/';
const SWM_PRED = SWM_POINTER_PRED;
const VM_PRED = `${DKG}vmCurrentAssertion`;
const WM_PRED = `${DKG}wmCurrentAssertion`;
const STALE_ROOT = 'ee'.repeat(32);
const TRIPLES = [
  { subject: 'urn:test:entity:alice', predicate: 'http://schema.org/name', object: '"Alice"' },
  { subject: 'urn:test:entity:bob', predicate: 'http://schema.org/name', object: '"Bob"' },
];

const schedulerBusy = (source = 'agent.publish.swmPointerSeal') => new StoreSchedulerBusyError(
  'queue_wait_timeout', 'normal', source, { storeOperation: 'query' },
);
const notStartedTimeout = () => new StoreOperationTimeoutError({
  backend: 'managed-oxigraph', operation: 'deleteByPattern', outcome: 'not_started',
});
const indeterminateTimeout = () => new StoreOperationTimeoutError({
  backend: 'managed-oxigraph', operation: 'insert', outcome: 'indeterminate',
});

/** A "process" over a durable store: fresh in-memory agent + publisher objects. */
async function bootAgent(store: SwmPointerFaultStore) {
  const publisher = new DKGPublisher({
    store,
    chain: new MockChainAdapter(),
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
  });
  const agent = Object.create(DKGAgent.prototype) as any;
  agent.defaultAgentAddress = AGENT;
  agent.node = { peerId: { toString: () => PEER } };
  agent.store = store;
  agent.publisher = publisher;
  agent.log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  agent.prepareAtomicAssertionShare = async () => undefined;
  agent.buildCuratorAckConfirmer = async () => undefined;
  agent.resolveWorkspaceGossipSigningAgent = async () => undefined;
  agent.resolveWorkspaceRecipientsGated = async () => ({ requiresEncryption: false, recipients: [] });
  agent.publishWorkspaceGossip = vi.fn(async () => undefined);
  agent.scheduleRfc64SwmInventoryObserverV1 = vi.fn();
  return { agent, publisher };
}

async function createFixture() {
  const store = new SwmPointerFaultStore();
  const { agent, publisher } = await bootAgent(store);
  await publisher.assertionCreate(CG, NAME, AGENT);
  await publisher.assertionWrite(CG, NAME, AGENT, TRIPLES);
  const finalized = await finalizeRootlessAssertionForTest({
    publisher, store, contextGraphId: CG, name: NAME, agentAddress: AGENT,
  });
  const metaGraph = contextGraphMetaUri(CG);
  const lifecycleUri = assertionLifecycleUri(CG, AGENT, NAME);

  const readPointer = async (pred: string): Promise<string | undefined> => {
    const result = await store.query(
      `SELECT ?o WHERE { GRAPH <${metaGraph}> { <${lifecycleUri}> <${pred}> ?o } } LIMIT 1`,
    );
    const raw = result.type === 'bindings' ? result.bindings[0]?.['o'] : undefined;
    return raw?.replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '');
  };
  const promote = (target = agent) => target.assertion.promote(CG, NAME, {
    accessPolicy: 'public', agentAddress: AGENT,
  });
  const describeKa = (target = agent) => target.assertion.history(CG, NAME, { agentAddress: AGENT });
  return {
    store, agent, publisher, finalized, metaGraph, lifecycleUri,
    sealedRoot: (await readPointer(WM_PRED))!,
    readPointer, promote, describeKa,
    swmTripleCount: () => store.countQuads(finalized.sharedGraphUri),
  };
}

describe('GH#2901 — SWM pointer maintenance after a durable SWM commit', () => {
  // `raw`: a storage failure PROVEN never to have started keeps its type, so the queue
  // retries it directly and a sync caller gets the retryable 503. `post-commit`: anything
  // else fails closed and is replayed by the recovery sweep. Both repair the SAME share.
  it.each([
    ['the seal read (scheduler busy)', 'seal-read', schedulerBusy(), 'raw'],
    ['the pointer delete (not started)', 'pointer-delete', notStartedTimeout(), 'raw'],
    ['the pointer insert (not started)', 'pointer-insert', notStartedTimeout(), 'raw'],
    ['the pointer insert (indeterminate)', 'pointer-insert', indeterminateTimeout(), 'post-commit'],
    ['the seal read (untyped store error)', 'seal-read', new Error('store connection reset'), 'post-commit'],
  ] as const)(
    'surfaces a failed %s without a success and repairs the SAME share on replay',
    async (_label, fault, injected, classification) => {
      const f = await createFixture();
      expect(f.sealedRoot).toMatch(/^[0-9a-f]{64}$/);
      f.store.arm(fault, injected);

      const failure = await f.promote().catch((error: unknown) => error);

      // Never a success.
      expect(f.store.trips).toEqual([fault]);
      expect(failure).toBeInstanceOf(Error);
      if (classification === 'raw') {
        expect(failure).toBe(injected);
        expect(isStoreOperationProvenNotStarted(failure)).toBe(true);
        expect(getPromoteFailureDisposition(failure)).toBeUndefined();
      } else {
        expect(failure).toMatchObject({ cause: injected });
        expect(getPromoteFailureDisposition(failure)).toEqual({
          classification: 'fatal',
          retryable: false,
          diagnostic: { name: 'PromotePostCommitFailureError', code: 'PROMOTE_POST_COMMIT_FAILURE' },
        });
      }
      // The cause text is the operator's only evidence; the stamp must still log it.
      expect(f.agent.log.warn).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('Failed to stamp swmCurrentAssertion'),
      );

      // The share itself IS committed, with no pointer yet.
      const pending = await f.describeKa();
      expect(pending).toMatchObject({ state: 'promoted', memoryLayer: 'SWM' });
      const operationId = pending!.currentShareOperationId;
      expect(operationId).toBeTruthy();
      expect(await f.swmTripleCount()).toBe(TRIPLES.length);
      expect(await f.readPointer(SWM_PRED)).toBeUndefined();

      // Replay of the existing operation (what the queue sweep triggers).
      f.store.disarm();
      await expect(f.promote()).resolves.toEqual({
        promotedCount: 0,
        sealed: true,
        publishReady: true,
        shareOperationId: operationId,
      });
      expect(await f.readPointer(SWM_PRED)).toBe(f.sealedRoot);
      const repaired = await f.describeKa();
      expect(repaired).toMatchObject({
        state: 'promoted',
        memoryLayer: 'SWM',
        status: 'swm-shared',
        swmCurrentAssertion: f.sealedRoot,
        wmCurrentAssertion: f.sealedRoot,
        currentShareOperationId: operationId,
        kaNumber: pending!.kaNumber,
        reservedUal: pending!.reservedUal,
      });
      // No second promotion: same exact SWM graph, no extra share identity.
      expect(await f.swmTripleCount()).toBe(TRIPLES.length);
    },
  );

  it('does not leave an older pointer behind when the delete lands and the insert fails', async () => {
    const f = await createFixture();
    // A prior share version already stamped a (now stale) pointer.
    await f.store.insert([{
      subject: f.lifecycleUri, predicate: SWM_PRED, object: `"${STALE_ROOT}"`, graph: f.metaGraph,
    }]);
    f.store.arm('pointer-insert', notStartedTimeout());

    await expect(f.promote()).rejects.toBeInstanceOf(StoreOperationTimeoutError);
    // Drop-then-set is not atomic: the old row is gone and the new one is absent.
    expect(await f.readPointer(SWM_PRED)).toBeUndefined();

    f.store.disarm();
    await f.promote();
    expect(await f.readPointer(SWM_PRED)).toBe(f.sealedRoot);
  });

  it('keeps the RFC-64 observer scheduled for the same operation when the stamp fails', async () => {
    const f = await createFixture();
    f.store.arm('seal-read', schedulerBusy());

    await expect(f.promote()).rejects.toBeInstanceOf(StoreSchedulerBusyError);

    const operationId = (await f.describeKa())!.currentShareOperationId;
    expect(f.agent.scheduleRfc64SwmInventoryObserverV1).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ contextGraphId: CG, shareOperationId: operationId }),
    );
  });

  it('still treats a missing seal as "nothing to point at", not a failure', async () => {
    const f = await createFixture();
    await f.store.deleteByPattern({
      graph: f.metaGraph, subject: contextGraphAssertionUri(CG, AGENT, NAME),
    });

    await expect(f.agent._stampSwmPointer(CG, NAME, AGENT)).resolves.toBeUndefined();
    expect(await f.readPointer(SWM_PRED)).toBeUndefined();
    expect(f.agent.log.warn).not.toHaveBeenCalled();
  });

  it('keeps the unchanged always-write fallback when only the VM-guard read fails', async () => {
    const f = await createFixture();
    f.store.arm('vm-guard-read', schedulerBusy('agent.publish.pointerVmGuard'));

    // A failed guard read is not a failure: an extra convergent row is harmless.
    await expect(f.promote()).resolves.toMatchObject({ publishReady: true });
    expect(f.store.trips).toEqual(['vm-guard-read']);
    expect(await f.readPointer(SWM_PRED)).toBe(f.sealedRoot);
  });

  it('surfaces a corrupt seal as a failure, distinct from a missing seal', async () => {
    const f = await createFixture();
    await f.store.deleteByPattern({
      graph: f.metaGraph,
      subject: contextGraphAssertionUri(CG, AGENT, NAME),
      predicate: ASSERTION_SEAL_PREDICATES.AUTHOR_ATTESTATION_R,
    });

    await expect(f.agent._stampSwmPointer(CG, NAME, AGENT)).rejects.toThrow();
    expect(f.agent.log.warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('Failed to stamp swmCurrentAssertion'),
    );
    expect(await f.readPointer(SWM_PRED)).toBeUndefined();
  });

  it('keeps the divergence-only omission when SWM equals the proven VM root', async () => {
    const f = await createFixture();
    await f.store.insert([{
      subject: f.lifecycleUri, predicate: VM_PRED, object: `"${f.sealedRoot}"`, graph: f.metaGraph,
    }]);

    await expect(f.agent._stampSwmPointer(CG, NAME, AGENT)).resolves.toBeUndefined();
    expect(await f.readPointer(SWM_PRED)).toBeUndefined();
    expect((await f.describeKa())!.swmCurrentAssertion).toBe(f.sealedRoot);

    // A VM root that differs from the shared root keeps the explicit pointer.
    await f.store.deleteByPattern({ graph: f.metaGraph, subject: f.lifecycleUri, predicate: VM_PRED });
    await f.store.insert([{
      subject: f.lifecycleUri, predicate: VM_PRED, object: `"${STALE_ROOT}"`, graph: f.metaGraph,
    }]);
    await f.agent._stampSwmPointer(CG, NAME, AGENT);
    expect(await f.readPointer(SWM_PRED)).toBe(f.sealedRoot);
  });

  it('propagates a failed delete of a stale pointer when SWM equals the VM root', async () => {
    const f = await createFixture();
    await f.store.insert([
      { subject: f.lifecycleUri, predicate: VM_PRED, object: `"${f.sealedRoot}"`, graph: f.metaGraph },
      { subject: f.lifecycleUri, predicate: SWM_PRED, object: `"${STALE_ROOT}"`, graph: f.metaGraph },
    ]);
    f.store.arm('pointer-delete', notStartedTimeout());

    await expect(f.agent._stampSwmPointer(CG, NAME, AGENT)).rejects.toMatchObject({
      outcome: 'not_started',
    });
    expect(await f.readPointer(SWM_PRED)).toBe(STALE_ROOT);

    f.store.disarm();
    await f.agent._stampSwmPointer(CG, NAME, AGENT);
    expect(await f.readPointer(SWM_PRED)).toBeUndefined();
  });
});
