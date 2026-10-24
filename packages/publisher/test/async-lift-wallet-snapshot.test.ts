import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '../src/index.js';
import {
  CONTROL_CLAIM_TOKEN, CONTROL_LOCKED_JOB, CONTROL_LOCK_STATUS, CONTROL_PAYLOAD,
  DEFAULT_CONTROL_GRAPH_URI, DEFAULT_WALLET_LOCK_GRAPH_URI,
  jobSubject, literal, serializeWalletLock, walletLockSubject,
} from '../src/async-lift-control-plane.js';
import { KA_VM_EXECUTOR_TX_HASH, KA_VM_VALIDATION, kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';

describe('wallet ownership query snapshot', () => {
  let store: OxigraphStore;
  let now: number;
  let ids: number;

  beforeEach(() => {
    store = new OxigraphStore();
    now = 1_000;
    ids = 0;
  });

  function publisher(graphUri = DEFAULT_CONTROL_GRAPH_URI) {
    return new TripleStoreAsyncLiftPublisher(store, {
      graphUri, now: () => now, idGenerator: () => `job-${++ids}`,
      claimTokenGenerator: () => `token-${++ids}`, autoRetryEnabled: false,
    });
  }

  async function enqueue(p: TripleStoreAsyncLiftPublisher, name: string) {
    return p.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name, shareOperationId: name }));
  }

  async function lock(jobId: string, claimToken?: string, status: 'active' | 'released' = 'active') {
    await store.deleteByPattern({ graph: DEFAULT_WALLET_LOCK_GRAPH_URI, subject: walletLockSubject('wallet-a') });
    await store.insert(serializeWalletLock({
      walletId: 'wallet-a', jobId, claimToken, status, acquiredAt: 1_000, expiresAt: 61_000,
    }, DEFAULT_WALLET_LOCK_GRAPH_URI));
  }

  async function replaceLockTerm(predicate: string, object: string) {
    const subject = walletLockSubject('wallet-a');
    await store.deleteByPattern({ graph: DEFAULT_WALLET_LOCK_GRAPH_URI, subject, predicate });
    await store.insert([{ graph: DEFAULT_WALLET_LOCK_GRAPH_URI, subject, predicate, object }]);
  }

  async function replacePayload(jobId: string, payload: string, graph = DEFAULT_CONTROL_GRAPH_URI) {
    await store.deleteByPattern({ graph, subject: jobSubject(jobId), predicate: CONTROL_PAYLOAD });
    await store.insert([{ graph, subject: jobSubject(jobId), predicate: CONTROL_PAYLOAD, object: literal(payload) }]);
  }

  it('rejects an active wallet using one query and no separate exact-job read, across publisher instances', async () => {
    const p = publisher();
    const first = await enqueue(p, 'first');
    await p.claimNext('wallet-a');
    const second = await enqueue(p, 'second');
    const other = publisher();
    const query = vi.spyOn(store, 'query');

    expect(await other.claimNext('wallet-a')).toBeNull();
    expect(query.mock.calls.map(([, options]) => options?.source)).toEqual([
      'publisher.asyncLift.walletLock.ownership',
    ]);
    query.mockRestore();
    expect((await p.getStatus(first))?.status).toBe('claimed');
    expect((await other.claimNext('wallet-b'))?.jobId).toBe(second);
  });

  it.each(['absent', 'released', 'dangling', 'foreign', 'empty-id'] as const)(
    'preserves the free-wallet outcome for a %s lock',
    async (kind) => {
      const p = publisher();
      const jobId = await enqueue(p, 'candidate');
      if (kind !== 'absent') await lock('missing', undefined, kind === 'released' ? 'released' : 'active');
      if (kind === 'foreign') await replaceLockTerm(CONTROL_LOCKED_JOB, '<urn:foreign:job>');
      if (kind === 'empty-id') await replaceLockTerm(CONTROL_LOCKED_JOB, '<urn:dkg:publisher:lift-job:>');
      expect((await p.claimNext('wallet-a'))?.jobId).toBe(jobId);
    },
  );

  it('does not decode an inactive lock payload even when it is malformed', async () => {
    const p = publisher();
    const broken = await enqueue(p, 'broken');
    await replacePayload(broken, '{broken');
    await lock(broken, undefined, 'released');
    const candidate = await enqueue(p, 'candidate');
    expect((await p.claimNext('wallet-a'))?.jobId).toBe(candidate);
  });

  it.each(['malformed', 'unknown'] as const)('fails closed for an active lock with a %s job', async (kind) => {
    const p = publisher();
    const jobId = await enqueue(p, 'broken');
    const original = await p.getStatus(jobId);
    await lock(jobId);
    await replacePayload(jobId, kind === 'malformed' ? '{broken' : JSON.stringify({ ...original, status: 'future-state' }));
    await expect(p.claimNext('wallet-a')).rejects.toThrow();
    expect(await store.hasGraph(DEFAULT_WALLET_LOCK_GRAPH_URI)).toBe(true);
  });

  it('keeps malformed lock parsing ahead of job decoding', async () => {
    const p = publisher();
    const jobId = await enqueue(p, 'broken');
    await lock(jobId);
    await replacePayload(jobId, '{broken');
    await replaceLockTerm(CONTROL_LOCK_STATUS, '"active"^^<urn:test:status>');
    // A non-JSON status retains the same failure rather than granting a free wallet.
    await expect(p.claimNext('wallet-a')).rejects.toBeInstanceOf(SyntaxError);
  });

  it.each(['token', 'wallet', 'job'] as const)('does not reserve a wallet for a mismatched %s fence', async (mismatch) => {
    const p = publisher();
    const first = await enqueue(p, 'first');
    const claimed = await p.claimNext('wallet-a');
    if (!claimed) throw new Error('missing claim');
    const candidate = await enqueue(p, 'second');
    if (mismatch === 'token') await replaceLockTerm(CONTROL_CLAIM_TOKEN, literal('replacement-token'));
    else await replacePayload(first, JSON.stringify({
      ...claimed,
      ...(mismatch === 'job' ? { jobId: 'different-job', controlPlane: { jobRef: jobSubject('different-job') } } : { claim: { ...claimed.claim, walletId: 'wallet-b' } }),
    }));
    expect((await p.claimNext('wallet-a'))?.jobId).toBe(candidate);
  });

  it('expires a lease-bound claim but retains proof-bound ownership past the lease', async () => {
    const p = publisher();
    const first = await enqueue(p, 'first');
    const claimed = await p.claimNext('wallet-a');
    if (!claimed) throw new Error('missing claim');
    await p.update(first, 'validated', { validation: KA_VM_VALIDATION });
    await p.update(first, 'broadcast', { broadcast: { txHash: KA_VM_EXECUTOR_TX_HASH, walletId: 'wallet-a', nonce: 1, operationKind: 'create' } });
    const second = await enqueue(p, 'second');
    now = claimed.claim.claimLeaseExpiresAt + 1;
    expect(await publisher().claimNext('wallet-a')).toBeNull();

    // Restore the exact pre-broadcast record to characterize the lease-only branch.
    await replacePayload(first, JSON.stringify(claimed));
    expect((await p.claimNext('wallet-a'))?.jobId).toBe(second);
  });

  it('uses the configured job graph and does not join a same-ID payload from the default graph', async () => {
    const graph = 'urn:test:custom-publisher';
    const p = publisher(graph);
    const first = await enqueue(p, 'first');
    await p.claimNext('wallet-a');
    await replacePayload(first, '{broken');
    expect(await publisher(graph).claimNext('wallet-a')).toBeNull();
  });

  it('allows a wallet whose referenced job has released ownership', async () => {
    const p = publisher();
    const first = await enqueue(p, 'first');
    // An accepted job is a released ownership state even with an old active lock.
    await lock(first);
    expect((await p.claimNext('wallet-a'))?.jobId).toBe(first);
  });

  it('retains global claim fencing when two publishers compete for one accepted job', async () => {
    const first = publisher();
    const jobId = await enqueue(first, 'only');
    const results = await Promise.all([first.claimNext('wallet-a'), publisher().claimNext('wallet-b')]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)?.jobId).toBe(jobId);
  });
});
