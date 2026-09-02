/**
 * `ChainEventPoller` — the `kaRootMutations` lane (#2435): the root-mutation
 * INTEGRATION suite. Subscription against the chain constant, the dispatched
 * payload's shape through the real lane, the no-swallow contract, and the
 * removed-key construction warning. Lifecycle rows live in
 * `chain-event-poller-lifecycle.unit.test.ts`, cursor/recovery/observability
 * rows in `chain-event-lane-cursor.unit.test.ts`, and direct decoder rows in
 * `ka-root-mutation-decode.unit.test.ts` (split at PR #2436 review r16).
 */
import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@origintrail-official/dkg-core';
import { KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES, type ChainEvent } from '@origintrail-official/dkg-chain';
import {
  ChainEventPoller,
  type ChainEventPollerLane,
  type KnowledgeAssetRootMutationEventV1,
  type LaneCursorPersistence,
} from '../src/chain-event-poller.js';
import {
  CADENCE_MS,
  MAX_RANGE,
  AUTHOR,
  ROOT,
  makeChain,
  makeHandler,
  poll,
  rootMutation,
  forceScan,
} from './chain-event-poller-harness.js';

describe('ChainEventPoller — kaRootMutations subscription', () => {
  it('subscribes with exactly the chain package join constant', async () => {
    const chain = makeChain(1_000);
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      onKnowledgeAssetRootMutated: async () => { /* sink */ },
    });

    await poll(poller);

    expect(chain.filters).toHaveLength(1);
    expect(chain.filters[0].eventTypes).toEqual([...KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES]);
  });

  it('does not subscribe at all when no callback is wired', async () => {
    const chain = makeChain(1_000);
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
    });

    await poll(poller);

    expect(chain.filters).toEqual([]);
  });

  it('seeds one full RPC page back from the head on first activation', async () => {
    const chain = makeChain(50_000);
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      onKnowledgeAssetRootMutated: async () => { /* sink */ },
    });

    await poll(poller);

    expect(chain.filters[0].fromBlock).toBe(50_000 - MAX_RANGE + 1);
    expect(chain.filters[0].toBlock).toBe(50_000);
  });
});

describe('ChainEventPoller — kaRootMutations payload', () => {
  async function dispatchOne(event: ChainEvent): Promise<KnowledgeAssetRootMutationEventV1[]> {
    const chain = makeChain(100, [event]);
    const seen: KnowledgeAssetRootMutationEventV1[] = [];
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      onKnowledgeAssetRootMutated: async (e) => { seen.push(e); },
    });
    await poll(poller);
    return seen;
  }

  it('maps every event type to its kind', async () => {
    const events = KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES.map((t, i) => rootMutation(t, 50 + i));
    const chain = makeChain(100, [...events]);
    const seen: KnowledgeAssetRootMutationEventV1[] = [];
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      onKnowledgeAssetRootMutated: async (e) => { seen.push(e); },
    });

    await poll(poller);

    expect(seen.map((e) => e.kind)).toEqual([
      'lifecycle-update',
      'root-added',
      'roots-replaced',
      'root-removed',
    ]);
  });

  it('carries author on the lifecycle update only, and no root on roots-replaced', async () => {
    const [update] = await dispatchOne(rootMutation('KnowledgeAssetUpdated', 50));
    const [added] = await dispatchOne(rootMutation('KnowledgeAssetMerkleRootAdded', 50));
    const [replaced] = await dispatchOne(rootMutation('KnowledgeAssetMerkleRootsUpdated', 50));

    expect(update.author).toBe(AUTHOR);
    expect(update.merkleRoot).toBe(ROOT);
    expect('author' in added).toBe(false);
    expect(added.merkleRoot).toBe(ROOT);
    expect('author' in replaced).toBe(false);
    expect('merkleRoot' in replaced).toBe(false);
  });

  it('lowercases a checksummed author and nulls the zero address', async () => {
    const checksummed = '0xAbC0000000000000000000000000000000000001';
    const [mixed] = await dispatchOne(
      rootMutation('KnowledgeAssetUpdated', 50, { author: checksummed }),
    );
    const [zero] = await dispatchOne(
      rootMutation('KnowledgeAssetUpdated', 50, { author: '0x' + '00'.repeat(20) }),
    );

    expect(mixed.author).toBe(checksummed.toLowerCase());
    // The unattributed publish path. `null` — not the literal zero address —
    // so a consumer never records a real-looking author nobody attested.
    expect(zero.author).toBeNull();
  });

  it('a missing or malformed author is UNKNOWN (omitted), never explicitly unattributed (review r7)', async () => {
    // `author` is advisory; the asset identity is not. Dropping the event over
    // a bad author field would lose a convergence for a cosmetic reason — but
    // reporting the failure as `author: null` would be worse: `null` is the
    // POSITIVE on-chain claim "the zero address published this", and a corrupt
    // RPC payload must not manufacture that claim. Tri-state: attributed
    // string / explicit-zero `null` / unknown OMITTED.
    const malformed = await dispatchOne(
      rootMutation('KnowledgeAssetUpdated', 50, { author: 'not-an-address' }),
    );
    const missing = await dispatchOne(
      rootMutation('KnowledgeAssetUpdated', 50, { author: undefined }),
    );

    for (const seen of [malformed, missing]) {
      expect(seen).toHaveLength(1);
      expect('author' in seen[0]).toBe(false);
      expect(seen[0].kaId).toBe('42');
    }
  });

  it('drops an event whose chain position is incomplete', async () => {
    // The position is what a consumer orders and de-duplicates on. A missing
    // block hash makes "is this newer than what I stored" unanswerable, so the
    // event is unusable — but it must NOT throw, or one malformed log stalls
    // the lane behind it forever.
    for (const broken of [
      { blockHash: undefined },
      { txHash: 'not-a-hash' },
      { txIndex: -1 },
      { logIndex: 'x' },
      { kaId: '0xdead' },
    ]) {
      const seen = await dispatchOne(rootMutation('KnowledgeAssetUpdated', 50, broken));
      expect(seen, JSON.stringify(broken)).toEqual([]);
    }
  });

  it('advances the cursor even when every event in the window was dropped', async () => {
    const chain = makeChain(100, [rootMutation('KnowledgeAssetUpdated', 50, { blockHash: undefined })]);
    const saveCalls: Array<{ lane: ChainEventPollerLane; block: number }> = [];
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      cursorPersistence: {
        async loadLane() { return undefined; },
        async saveLane(lane, block) { saveCalls.push({ lane, block }); },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async () => { /* never called */ },
    });

    await poll(poller);

    expect(saveCalls).toEqual([{ lane: 'kaRootMutations', block: 100 }]);
  });
});

describe('ChainEventPoller — kaRootMutations does not swallow', () => {
  it('a rejecting callback holds the cursor and applies the failure backoff', async () => {
    let now = 0;
    const chain = makeChain(50_000, [rootMutation('KnowledgeAssetUpdated', 45_000)]);
    const saveCalls: Array<{ lane: ChainEventPollerLane; block: number }> = [];
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      cursorPersistence: {
        async loadLane() { return undefined; },
        async saveLane(lane, block) { saveCalls.push({ lane, block }); },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async () => { throw new Error('consumer could not record it'); },
    });

    await poll(poller);

    // Nothing persisted: the window was NOT taken responsibility for.
    expect(saveCalls).toEqual([]);

    // Backoff is 60 s, well past one cadence — a poll at +cadence finds the
    // lane not due and issues no second scan.
    now = CADENCE_MS;
    await poll(poller);
    expect(chain.filters).toHaveLength(1);

    // At +60 s the lane is due again and re-scans, rewound by 50 blocks from
    // where the failed scan left the cursor (the seed, 41 000).
    now = 60_000;
    await poll(poller);
    expect(chain.filters).toHaveLength(2);
    expect(chain.filters[1].fromBlock).toBe(41_000 - 50 + 1);
  });
});

describe('ChainEventPoller — construction', () => {
  it("passing the removed 'onCollectionUpdated' key warns loudly and enables no lane (review r3)", async () => {
    // A JavaScript consumer of the old key would otherwise fail silently. The
    // observable behaviour is unchanged from before the rename — the old lane
    // scanned a name the adapter never yielded, so the callback never fired —
    // but silence about a removed key helps nobody, so construction says so.
    const warned: string[] = [];
    const spy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(
      (_ctx: unknown, message: string) => { warned.push(message); },
    );
    try {
      const chain = makeChain(100);
      const poller = new ChainEventPoller({
        chain: chain.adapter,
        publishHandler: makeHandler(),
        intervalMs: CADENCE_MS,
        onCollectionUpdated: async () => { /* legacy consumer */ },
      } as never);

      expect(warned.some((m) => m.includes("'onCollectionUpdated' was removed"))).toBe(true);
      expect(warned.some((m) => m.includes('onKnowledgeAssetRootMutated'))).toBe(true);

      await forceScan(poller);
      expect(chain.filters).toHaveLength(0); // the legacy key enables no lane
    } finally {
      spy.mockRestore();
    }
  });
});
