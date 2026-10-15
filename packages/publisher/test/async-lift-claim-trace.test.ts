import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger, GRAPH_KA_CONTENT_SCOPE_VERSION } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '../src/index.js';
import { ClaimTrace, withObservedClaimLock } from '../src/async-lift-claim-trace.js';
import { seedLegacyRawLiftTestJob } from './_helpers/legacy-raw-lift.js';

const prefix = 'async_publish_claim_trace ';
function capture() {
  const events: Array<Record<string, unknown>> = [];
  vi.spyOn(Logger.prototype, 'info').mockImplementation((_context, line) => {
    if (line.startsWith(prefix)) events.push(JSON.parse(line.slice(prefix.length)));
  });
  return events;
}
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('async publisher native claim trace', () => {
  it('records native free/busy decisions and claim outcomes without exposing wallet or token', async () => {
    vi.stubEnv('DKG_ASYNC_PUBLISH_TRACE', '1');
    const events = capture();
    const store = new OxigraphStore();
    await seedLegacyRawLiftTestJob(store, {
      swmId: 'swm', namespace: 'default', contextGraphId: 'cg', shareOperationId: 'share',
      roots: [], contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/7',
      assertionVersion: '1', publicTripleCount: 2, privateTripleCount: 0,
      scope: 'full', transitionType: 'CREATE', authority: { type: 'owner', proofRef: 'proof:1' },
    }, { idGenerator: () => 'trace-job', now: () => 1 });
    const publisher = new TripleStoreAsyncLiftPublisher(store, {
      now: () => 2, claimTokenGenerator: () => 'secret-claim-nonce',
    });
    expect((await publisher.claimNext('private-wallet-id'))?.jobId).toBe('trace-job');
    expect(await publisher.claimNext('private-wallet-id')).toBeNull();
    expect(await publisher.processNext('other-wallet')).toBeNull();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'wallet_checked', usableActiveLock: false, ownershipMode: 'absent' }),
      expect.objectContaining({ event: 'wallet_checked', usableActiveLock: true, ownershipMode: 'lease-bound', matching: true }),
      expect.objectContaining({ event: 'wallet_lock_written', jobId: 'trace-job' }),
      expect.objectContaining({ event: 'claim_outcome', result: 'claimed', jobId: 'trace-job' }),
      expect.objectContaining({ event: 'claim_outcome', result: 'wallet-active' }),
      expect.objectContaining({ event: 'claim_outcome', result: 'no-candidate' }),
      expect.objectContaining({ event: 'process_next_end', result: 'idle' }),
    ]));
    const checks = events.filter((e) => e.event === 'wallet_checked');
    expect(checks[0]!.walletHash).toMatch(/^[a-f0-9]{64}$/);
    expect(checks[1]!.walletHash).toBe(checks[0]!.walletHash);
    expect(JSON.stringify(events)).not.toContain('private-wallet-id');
    expect(JSON.stringify(events)).not.toContain('secret-claim-nonce');
    expect(events.filter((e) => e.event === 'claim_lock_released')).toHaveLength(3);
  });

  it('does not emit diagnostic lines unless explicitly enabled', async () => {
    vi.stubEnv('DKG_ASYNC_PUBLISH_TRACE', '0');
    const events = capture();
    const publisher = new TripleStoreAsyncLiftPublisher(new OxigraphStore());
    expect(await publisher.processNext('wallet')).toBeNull();
    expect(events).toEqual([]);
  });
});


describe('claim lock diagnostic isolation', () => {
  it('separates monotonic wait/hold and preserves queue order through a rejecting holder', async () => {
    const events: Array<Record<string, unknown>> = [];
    let time = 0;
    const trace = new ClaimTrace({ enabled: () => true, clock: () => time,
      wallClock: () => 1_000 - time, write: (line) => events.push(JSON.parse(line.slice(prefix.length))) });
    const queues = new Map<string, Promise<void>>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const failure = new Error('holder failure');
    const first = withObservedClaimLock(queues, 'queue', async () => { await gate; throw failure; }, 'admission', undefined, trace);
    const rejected = expect(first).rejects.toBe(failure);
    await Promise.resolve();
    time = 5;
    let secondEntered = false;
    const second = withObservedClaimLock(queues, 'queue', async () => {
      secondEntered = true; time = 30; return 42;
    }, 'claim', 'wallet', trace);
    expect(secondEntered).toBe(false);
    time = 20;
    release();
    await rejected;
    await expect(second).resolves.toBe(42);
    expect(queues.size).toBe(0);
    expect(events.filter((event) => event.event === 'claim_lock_released')).toEqual([
      expect.objectContaining({ kind: 'admission', result: 'error', waitMs: 0, holdMs: 20 }),
      expect.objectContaining({ kind: 'claim', result: 'success', waitMs: 15, holdMs: 10 }),
    ]);
  });

  it.each(['enabled', 'clock', 'wallClock', 'write'] as const)('survives a throwing %s observer and releases the next waiter', async (failing) => {
    const fail = () => { throw new Error('observer failure'); };
    const trace = new ClaimTrace({ enabled: () => true, clock: () => 0, wallClock: () => 0,
      write: () => undefined, [failing]: fail });
    const queues = new Map<string, Promise<void>>();
    const first = withObservedClaimLock(queues, 'queue', async () => 'first', 'claim', 'wallet', trace);
    const second = withObservedClaimLock(queues, 'queue', async () => 'second', 'claim', 'wallet', trace);
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(queues.size).toBe(0);
  });

  it('does not read clocks or write when disabled', async () => {
    const touched = vi.fn(() => { throw new Error('disabled observer touched'); });
    const trace = new ClaimTrace({ enabled: () => false, clock: touched, wallClock: touched, write: touched });
    await expect(withObservedClaimLock(new Map(), 'queue', async () => 1, 'claim', 'wallet', trace)).resolves.toBe(1);
    expect(touched).not.toHaveBeenCalled();
  });
});
