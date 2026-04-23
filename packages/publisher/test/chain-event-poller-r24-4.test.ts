/**
 * chain-event-poller-r24-4.test.ts
 *
 * PR #229 bot review round 24 (r24-4). `ChainEventPoller.poll()` used
 * to short-circuit on:
 *
 *   if (!hasPending && !watchContextGraphs && !watchUpdates
 *       && !watchAllowList && !watchProfiles) return;
 *
 * A poller configured ONLY for WAL recovery — i.e. wired with
 * `onUnmatchedBatchCreated` (which is the handler we installed in
 * r21-5 / r23-3 to drain the WAL after a restart) but with no
 * pending publishes and no other watchers — would therefore NEVER
 * scan `KnowledgeBatchCreated` / `KCCreated`. The WAL entry it was
 * supposed to reconcile against the chain event would sit there
 * forever, violating the P-1 durability contract.
 *
 * This file uses a captive mock ChainAdapter so we can deterministically
 * assert:
 *   1. `listenForEvents` IS invoked on every tick when only
 *      `onUnmatchedBatchCreated` is wired — even with no pending
 *      publishes. (The regression.)
 *   2. A poller wired for NEITHER pending publishes NOR any watcher
 *      still short-circuits (no spurious RPC traffic).
 *
 * NO blockchain. This is a unit-level pin on the early-return gate
 * because exercising the same regression against Hardhat would
 * require orchestrating a full restart + WAL + real KnowledgeBatch
 * event, which the existing `publish-lifecycle.test.ts` and
 * `wal-recovery.test.ts` already cover at integration scope.
 */
import { describe, it, expect } from 'vitest';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TypedEventBus } from '@origintrail-official/dkg-core';
import { ChainEventPoller } from '../src/chain-event-poller.js';
import { PublishHandler } from '../src/publish-handler.js';

interface MockChain extends Pick<ChainAdapter, 'chainType' | 'chainId' | 'getBlockNumber' | 'listenForEvents'> {
  listenForEventsCalls: number;
}

function makeMockChain(): MockChain {
  const mock: MockChain = {
    chainType: 'evm' as const,
    chainId: 'test-chain',
    listenForEventsCalls: 0,
    getBlockNumber: async () => 100,
    listenForEvents: async function* () {
      mock.listenForEventsCalls += 1;
      // yield nothing — we only care about whether the scan was
      // attempted, not the handler branch coverage
    },
  };
  return mock;
}

function makeHandler(): PublishHandler {
  return new PublishHandler(new OxigraphStore(), new TypedEventBus());
}

/**
 * Call the private `poll()` method directly. Going through
 * `start()` + `setInterval` would add flakiness (min 1ms delay,
 * uncancellable first-tick race) without improving coverage —
 * `start()` just schedules `poll()`; the early-return gate we are
 * pinning is inside `poll()` itself.
 */
async function callPollDirectly(poller: ChainEventPoller): Promise<void> {
  const pollFn = (poller as unknown as { poll: () => Promise<void> }).poll;
  await pollFn.call(poller);
}

describe('ChainEventPoller.poll() — r24-4 early-return gate must include onUnmatchedBatchCreated', () => {
  it('DOES scan when only onUnmatchedBatchCreated is wired (WAL-only poller)', async () => {
    const chain = makeMockChain();
    const handler = makeHandler();

    expect(handler.hasPendingPublishes).toBe(false);

    const poller = new ChainEventPoller({
      chain: chain as unknown as ChainAdapter,
      publishHandler: handler,
      intervalMs: 1_000_000, // never actually ticks in this test
      onUnmatchedBatchCreated: async () => {
        // never invoked because listenForEvents yields nothing
      },
    });

    await callPollDirectly(poller);

    expect(chain.listenForEventsCalls).toBe(1);
  });

  it('short-circuits when NO watcher or pending publish is configured (no spurious RPC)', async () => {
    const chain = makeMockChain();
    const handler = makeHandler();

    const poller = new ChainEventPoller({
      chain: chain as unknown as ChainAdapter,
      publishHandler: handler,
      intervalMs: 1_000_000,
      // intentionally no watchers at all
    });

    await callPollDirectly(poller);

    // The early-return gate fires BEFORE any RPC. If this fails the
    // poller has silently widened its scan surface — every operator
    // would pay for listenForEvents on every tick just to idle.
    expect(chain.listenForEventsCalls).toBe(0);
  });

  it('DOES scan when the publishHandler has a pending publish, regardless of watchers', async () => {
    const chain = makeMockChain();
    const handler = makeHandler();
    // Fake a pending publish by toggling the public getter via the
    // internal map that backs it. PublishHandler exposes
    // `hasPendingPublishes` as a computed getter over
    // `pendingByMerkleRoot`, so planting one sentinel flips it true
    // without forging a real publish.
    (handler as unknown as { pendingPublishes: Map<string, unknown> }).pendingPublishes.set(
      'sentinel',
      {},
    );
    expect(handler.hasPendingPublishes).toBe(true);

    const poller = new ChainEventPoller({
      chain: chain as unknown as ChainAdapter,
      publishHandler: handler,
      intervalMs: 1_000_000,
    });

    await callPollDirectly(poller);

    expect(chain.listenForEventsCalls).toBe(1);
  });
});
