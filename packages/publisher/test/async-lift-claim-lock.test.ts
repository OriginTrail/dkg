import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import {
  OxigraphStore, activeDefaultStoreWorkPriority, withDefaultStoreWorkPriority,
} from '@origintrail-official/dkg-storage';
import { withClaimDomainLock, type ClaimLockKind, type ClaimLockQueue } from '../src/async-lift-claim-lock.js';
import type { ClaimLockObservation } from '../src/async-lift-claim-lock.js';
import { ClaimTrace, withObservedClaimLock } from '../src/async-lift-claim-trace.js';
import { TripleStoreAsyncLiftPublisher } from '../src/index.js';
import { kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  const queues = new Map<string, ClaimLockQueue>();
  const order: string[] = [];
  let active = 0;
  const run = (kind: ClaimLockKind, name: string, work: () => Promise<void> = async () => undefined) =>
    withClaimDomainLock(queues, 'graph', kind, async () => {
      expect(active).toBe(0);
      active += 1;
      order.push(name);
      try { await work(); } finally { active -= 1; }
    });
  async function hold() {
    const entered = deferred();
    const release = deferred();
    const done = run('admission', 'holder', async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    return { release: release.resolve, done };
  }
  return { queues, order, run, hold };
}

describe('claim-domain admission bypass', () => {
  it('passes an admission convoy once per admission, including claims arriving while the bypass runs', async () => {
    const h = harness();
    const holder = await h.hold();
    const a1 = h.run('admission', 'a1');
    const a2 = h.run('admission', 'a2');
    const a3 = h.run('admission', 'a3');
    const entered = deferred();
    const release = deferred();
    const c1 = h.run('claim', 'c1', async () => { entered.resolve(); await release.promise; });
    holder.release();
    await entered.promise;
    expect(h.order).toEqual(['holder', 'c1']);
    const c2 = h.run('claim', 'c2');
    const c3 = h.run('claim', 'c3');
    release.resolve();
    await Promise.all([holder.done, a1, a2, a3, c1, c2, c3]);
    expect(h.order).toEqual(['holder', 'c1', 'a1', 'c2', 'a2', 'c3', 'a3']);
    expect(h.queues.size).toBe(0);
  });

  it.each(['claim', 'admission'] as const)('preserves same-kind %s FIFO', async (kind) => {
    const h = harness();
    const holder = await h.hold();
    const pending = Array.from({ length: 8 }, (_, i) => h.run(kind, String(i)));
    holder.release();
    await Promise.all([holder.done, ...pending]);
    expect(h.order).toEqual(['holder', ...Array.from({ length: 8 }, (_, i) => String(i))]);
    expect(h.queues.size).toBe(0);
  });

  it.each(['transition', 'recovery', 'sweep', 'admin'] as const)('never crosses a %s barrier in the waiting prefix', async (barrier) => {
    const h = harness();
    const holder = await h.hold();
    const pending = [
      h.run('admission', 'a1'), h.run('admission', 'a2'), h.run('claim', 'c1'),
      h.run(barrier, 'barrier'), h.run('claim', 'c2'),
    ];
    holder.release();
    await Promise.all([holder.done, ...pending]);
    expect(h.order).toEqual(['holder', 'c1', 'a1', 'a2', 'barrier', 'c2']);
    expect(h.queues.size).toBe(0);
  });

  it('runs a head barrier before all later claims', async () => {
    const h = harness();
    const holder = await h.hold();
    const pending = [h.run('admin', 'barrier'), h.run('admission', 'a1'), h.run('claim', 'c1')];
    holder.release();
    await Promise.all([holder.done, ...pending]);
    expect(h.order).toEqual(['holder', 'barrier', 'c1', 'a1']);
  });

  it.each(['idle', 'throw', 'reject'] as const)('consumes the admission credit when an expedited claim ends with %s', async (outcome) => {
    const h = harness();
    const holder = await h.hold();
    const a1 = h.run('admission', 'a1');
    const error = new Error('claim failure');
    const claim = withClaimDomainLock(h.queues, 'graph', 'claim', () => {
      h.order.push('c1');
      if (outcome === 'throw') throw error;
      return outcome === 'reject' ? Promise.reject(error) : Promise.resolve(null);
    }).then((value) => ({ value }), (cause: unknown) => ({ cause }));
    const c2 = h.run('claim', 'c2');
    holder.release();
    const result = await claim;
    await Promise.all([holder.done, a1, c2]);
    expect(h.order).toEqual(['holder', 'c1', 'a1', 'c2']);
    expect(result).toEqual(outcome === 'idle' ? { value: null } : { cause: error });
    expect(h.queues.size).toBe(0);
  });

  it('does not poison successors when an admission rejects', async () => {
    const h = harness();
    const holder = await h.hold();
    const error = new Error('admission failure');
    const admission = h.run('admission', 'a1', async () => { throw error; })
      .then(() => undefined, (cause: unknown) => cause);
    const c1 = h.run('claim', 'c1');
    const c2 = h.run('claim', 'c2');
    holder.release();
    expect(await admission).toBe(error);
    await Promise.all([holder.done, c1, c2]);
    expect(h.order).toEqual(['holder', 'c1', 'a1', 'c2']);
    expect(h.queues.size).toBe(0);
  });

  it('lets disjoint graph domains progress while one domain is held', async () => {
    const h = harness();
    const holder = await h.hold();
    await expect(withClaimDomainLock(h.queues, 'other-graph', 'claim', async () => 42)).resolves.toBe(42);
    expect(h.queues.size).toBe(1);
    holder.release();
    await holder.done;
    expect(h.queues.size).toBe(0);
  });

  it('keeps each callback in its original caller async context and store-priority lane', async () => {
    const h = harness();
    const context = new AsyncLocalStorage<string>();
    const holder = await h.hold();
    const seen: unknown[] = [];
    const normal = context.run('normal-caller', () => withDefaultStoreWorkPriority('normal', () =>
      h.run('admission', 'normal', async () => { seen.push([context.getStore(), activeDefaultStoreWorkPriority()]); })));
    const background = context.run('background-caller', () => withDefaultStoreWorkPriority('background', () =>
      h.run('claim', 'background', async () => { seen.push([context.getStore(), activeDefaultStoreWorkPriority()]); })));
    withDefaultStoreWorkPriority('ack', holder.release);
    await Promise.all([holder.done, normal, background]);
    expect(seen).toEqual([['background-caller', 'background'], ['normal-caller', 'normal']]);
  });
});

describe('claim-domain observer boundaries', () => {
  it('reserves the first owner synchronously before a reentrant queued observer', async () => {
    const queues = new Map<string, ClaimLockQueue>();
    const order: string[] = [];
    let reentrant!: Promise<void>;
    const first = withClaimDomainLock(queues, 'graph', 'admission', async () => { order.push('first'); }, {
      queued: () => {
        expect(queues.size).toBe(1);
        reentrant = withClaimDomainLock(queues, 'graph', 'claim', async () => { order.push('reentrant'); });
      },
    });
    await Promise.all([first, reentrant]);
    expect(order).toEqual(['first', 'reentrant']);
    expect(queues.size).toBe(0);
  });

  it('reserves a successor before acquired/released observers can enqueue later callers', async () => {
    const queues = new Map<string, ClaimLockQueue>();
    const order: string[] = [];
    const gate = deferred();
    const entered = deferred();
    const pending: Promise<void>[] = [];
    const first = withClaimDomainLock(queues, 'graph', 'claim', async () => {
      order.push('first'); entered.resolve(); await gate.promise;
    }, {
      acquired: () => { pending.push(withClaimDomainLock(queues, 'graph', 'admission', async () => { order.push('reserved'); })); },
      released: () => { pending.push(withClaimDomainLock(queues, 'graph', 'claim', async () => { order.push('late'); })); },
    });
    await entered.promise;
    gate.resolve();
    await first;
    await Promise.all(pending);
    expect(order).toEqual(['first', 'reserved', 'late']);
    expect(queues.size).toBe(0);
  });

  it('does not evict a replacement queue created by the final released observer', async () => {
    const queues = new Map<string, ClaimLockQueue>();
    const entered = deferred();
    const release = deferred();
    let replacement!: Promise<void>;
    await withClaimDomainLock(queues, 'graph', 'admission', async () => undefined, {
      released: () => {
        expect(queues.size).toBe(0);
        replacement = withClaimDomainLock(queues, 'graph', 'claim', async () => {
          entered.resolve(); await release.promise;
        });
      },
    });
    await entered.promise;
    expect(queues.size).toBe(1);
    release.resolve();
    await replacement;
    expect(queues.size).toBe(0);
  });

  it.each(['queued', 'acquired', 'released'] as const)('isolates throwing %s hooks and getters', async (phase) => {
    for (const getter of [false, true]) {
      const queues = new Map<string, ClaimLockQueue>();
      const observation: ClaimLockObservation = {};
      const fail = () => { throw new Error('observer failure'); };
      if (getter) Object.defineProperty(observation, phase, { get: fail });
      else observation[phase] = fail;
      const first = withClaimDomainLock(queues, 'graph', 'admission', async () => 42, observation);
      const next = withClaimDomainLock(queues, 'graph', 'claim', async () => 43);
      await expect(Promise.all([first, next])).resolves.toEqual([42, 43]);
      expect(queues.size).toBe(0);
    }
  });

  it('traces full registration-to-acquisition time and releases before successor acquisition', async () => {
    const queues = new Map<string, ClaimLockQueue>();
    const events: Array<Record<string, unknown>> = [];
    let now = 0;
    const trace = new ClaimTrace({ enabled: () => true, clock: () => now, wallClock: () => 100,
      write: (line) => { events.push(JSON.parse(line.slice('async_publish_claim_trace '.length))); } });
    const entered = deferred();
    const release = deferred();
    const holder = withObservedClaimLock(queues, 'graph', async () => {
      entered.resolve(); await release.promise;
    }, 'admission', undefined, trace);
    await entered.promise;
    now = 5;
    const admission = withObservedClaimLock(queues, 'graph', async () => { now = 40; }, 'admission', undefined, trace);
    now = 10;
    const claim = withObservedClaimLock(queues, 'graph', async () => { now = 30; }, 'claim', undefined, trace);
    now = 20;
    release.resolve();
    await Promise.all([holder, admission, claim]);
    const released = events.filter((event) => event.event === 'claim_lock_released');
    expect(released).toEqual([
      expect.objectContaining({ kind: 'admission', waitMs: 0, holdMs: 20 }),
      expect.objectContaining({ kind: 'claim', waitMs: 10, holdMs: 10 }),
      expect.objectContaining({ kind: 'admission', waitMs: 25, holdMs: 10 }),
    ]);
    expect(events.filter((event) => event.event !== 'claim_lock_wait').map((event) => event.event)).toEqual([
      'claim_lock_acquired', 'claim_lock_released', 'claim_lock_acquired',
      'claim_lock_released', 'claim_lock_acquired', 'claim_lock_released',
    ]);
  });
});

describe('publisher admission convoy', () => {
  it('claims the first durably accepted job across publisher instances before eleven queued admissions', async () => {
    const store = new OxigraphStore();
    let id = 0;
    const makePublisher = () => new TripleStoreAsyncLiftPublisher(store, {
      now: () => 1_000, idGenerator: () => `convoy-${++id}`,
      claimTokenGenerator: () => 'convoy-token', autoRetryEnabled: false,
    });
    const admissionPublisher = makePublisher();
    const claimingPublisher = makePublisher();
    const entered = deferred();
    const release = deferred();
    let admissionReads = 0;
    let admissionReadsAtClaim: number | undefined;
    const originalQuery = store.query.bind(store);
    store.query = async (...args) => {
      const result = await originalQuery(...args);
      if (args[1]?.source === 'publisher.asyncLift.findActiveVmPublish') {
        admissionReads += 1;
        if (admissionReads === 1) { entered.resolve(); await release.promise; }
      }
      return result;
    };
    const originalReplace = store.replaceSubject.bind(store);
    store.replaceSubject = async (...args) => {
      if (args[3]?.source === 'publisher.asyncLift.walletLock.write') admissionReadsAtClaim = admissionReads;
      return originalReplace(...args);
    };
    const enqueue = (index: number) => admissionPublisher.enqueueKnowledgeAssetVmPublish(
      kaVmPublishRequest({ name: `convoy-${index}`, shareOperationId: `convoy-${index}` }),
    );
    const first = enqueue(0);
    await entered.promise;
    const queued = Array.from({ length: 11 }, (_, index) => enqueue(index + 1));
    const claim = claimingPublisher.claimNext('wallet-convoy');
    release.resolve();
    const [firstJob, claimed] = await Promise.all([first, claim]);
    await Promise.all(queued);
    expect(claimed?.jobId).toBe(firstJob);
    expect(claimed?.status).toBe('claimed');
    expect(admissionReadsAtClaim).toBe(1);
    expect(admissionReads).toBe(12);
    expect((await admissionPublisher.getStats()).accepted).toBe(11);
  });
});
