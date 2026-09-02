/**
 * The `kaRootMutations` lane's CURSOR behavior through `ChainEventLaneRunner`
 * (#2435, PR #2436): restore rewind and the zero floor, retired-key adoption
 * and its live-seed cap, failure-streak rewind, failed-scan cursor holds.
 * Split at review r9 along the production boundaries: replay/finality and
 * observability live in their own suites.
 */
import {
  describe,
  it,
  expect,
} from 'vitest';
import {
  ChainEventPoller,
  type ChainEventPollerLane,
  type LaneCursorPersistence,
} from '../src/chain-event-poller.js';
import {
  CADENCE_MS,
  MAX_RANGE,
  makeChain,
  makeHandler,
  poll,
  rootMutation,
  forceScan,
} from './chain-event-poller-harness.js';


describe('kaRootMutations — cursor restore and failure recovery', () => {
  it('rewinds once per failure streak, not once per failure', async () => {
    // An unbounded backward walk during a long outage would re-dispatch that
    // whole stretch on recovery.
    let now = 0;
    const chain = makeChain(50_000);
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      onKnowledgeAssetRootMutated: async () => { /* sink */ },
    });

    chain.failNextScan();
    await poll(poller);
    now = 60_000;
    chain.failNextScan();
    await poll(poller);
    now = 60_000 + 120_000;
    await poll(poller);

    expect(chain.filters).toHaveLength(3);
    const rewound = 41_000 - 50 + 1;
    expect(chain.filters[1].fromBlock).toBe(rewound);
    expect(chain.filters[2].fromBlock).toBe(rewound);
  });

  it('rewinds a restored cursor by 50 blocks; lanes without the field are unchanged', async () => {
    const chain = makeChain(50_000);
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      cursorPersistence: {
        async loadLane() { return 1_000; },
        async saveLane() { /* ignored */ },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async () => { /* sink */ },
      // Same restored cursor, a lane that declares no rewind — the control.
      onKARegisteredToContextGraph: async () => { /* sink */ },
    });

    await poll(poller);

    const byLane = new Map(
      chain.filters.map((f) => [f.eventTypes[0], f] as const),
    );
    expect(byLane.get('KnowledgeAssetUpdated')!.fromBlock).toBe(951);
    expect(byLane.get('KnowledgeAssetRegisteredToContextGraph')!.fromBlock).toBe(1_001);
  });

  it('adopts the retired collectionUpdates cursor instead of live-seeding past it (review r22)', async () => {
    // A lane rename must not orphan an embedder durable cursor: with
    // collectionUpdates=1,000 persisted and a 20,000-block head, a fresh
    // kaRootMutations lane would otherwise live-seed to 11,000 and
    // permanently skip blocks 1,001..11,000.
    const saves: Array<{ lane: string; block: number }> = [];
    const { adapter, filters } = makeChain(20_000);
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => 0,
      cursorPersistence: {
        async loadLane(lane) { return (lane as string) === 'collectionUpdates' ? 1_000 : undefined; },
        async saveLane(lane, block) { saves.push({ lane, block }); },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async () => { /* sink */ },
    });

    await poll(poller);

    // Adopted (1,000), rewound by 50; the first scan starts where the OLD
    // cursor stood — not at head-9,000 — and the first forward-scan save
    // re-homes the ADVANCED cursor under the new key (review r25: no
    // restore-time save, so a crash cannot freeze an uncapped adoption).
    expect(filters[0].fromBlock).toBe(951);
    const rehomed = saves.find((s2) => s2.lane === 'kaRootMutations');
    expect(rehomed?.block).toBe(9_950);
  });
  it('an adopted cursor NEAR HEAD is capped at the activation lookback (review r25)', async () => {
    // The retired cursor proves coverage for ONE event type. Treating it as
    // all-four coverage would skip a recent root-added forever: with
    // collectionUpdates=20,000 at head 20,000, a KnowledgeAssetMerkleRootAdded
    // at 19,500 must still be delivered — the capped start (11,001) is what
    // a cold activation would have scanned anyway.
    const seen: number[] = [];
    const chain = makeChain(20_000, [rootMutation('KnowledgeAssetMerkleRootAdded', 19_500)]);
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => 0,
      cursorPersistence: {
        async loadLane(lane) { return (lane as string) === 'collectionUpdates' ? 20_000 : undefined; },
        async saveLane() { /* not under test */ },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async (e) => { seen.push(e.position.blockNumber); },
    });

    await poll(poller);

    expect(chain.filters[0].fromBlock).toBe(11_001);
    expect(seen).toContain(19_500);
  });
  it('an existing kaRootMutations cursor WINS over the retired key (review r23)', async () => {
    // Precedence matters: always-adopting would move the lane to the
    // retired cursor (18,000) and skip root-added/replaced/removed events
    // in 12,001..17,950 — blocks the retired lane never subscribed to.
    const saves: Array<{ lane: string; block: number }> = [];
    const { adapter, filters } = makeChain(20_000);
    const poller = new ChainEventPoller({
      chain: adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => 0,
      cursorPersistence: {
        async loadLane(lane) {
          if ((lane as string) === 'kaRootMutations') return 12_000;
          if ((lane as string) === 'collectionUpdates') return 18_000;
          return undefined;
        },
        async saveLane(lane, block) { saves.push({ lane, block }); },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async () => { /* sink */ },
    });

    await poll(poller);

    // The current cursor is retained (rewound), no migration save occurs.
    expect(filters[0].fromBlock).toBe(11_951);
    expect(saves.some((s2) => s2.block === 18_000)).toBe(false);
  });
  it('a cursor rewound to the ZERO floor scans from block 1, never live-seeds (review r14)', async () => {
    // Zero is also the uninitialized sentinel: without restored-state
    // tracking, a persisted cursor of 25 rewound by 50 reads as "no cursor"
    // and the lane live-seeds to head - 9_000 — skipping every mutation in
    // blocks 1..11_000 DESPITE having restored a cursor. The boundary case
    // (saved === rewind) floors identically.
    for (const saved of [25, 50]) {
      const { adapter, filters } = makeChain(20_000);
      const poller = new ChainEventPoller({
        chain: adapter,
        publishHandler: makeHandler(),
        intervalMs: CADENCE_MS,
        clock: () => 0,
        cursorPersistence: {
          async loadLane(lane) { return lane === 'kaRootMutations' ? saved : undefined; },
          async saveLane() { /* not under test */ },
        } satisfies LaneCursorPersistence,
        onKnowledgeAssetRootMutated: async () => { /* sink */ },
      });
      await poll(poller);
      expect(filters.length, `saved=${saved}`).toBeGreaterThan(0);
      expect(filters[0].fromBlock, `saved=${saved}`).toBe(1);
    }
  });
  it('does not persist a cursor for a scan that failed', async () => {
    // The runner catches per-lane scan errors, so the forced scan settles normally.
    // What must not happen is a SILENT advance: a driven scan that failed must
    // leave the cursor exactly where a driven scan that never ran would.
    const chain = makeChain(50_000);
    const saveCalls: Array<{ lane: ChainEventPollerLane; block: number }> = [];
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      cursorPersistence: {
        async loadLane() { return undefined; },
        async saveLane(lane, block) { saveCalls.push({ lane, block }); },
      } satisfies LaneCursorPersistence,
      onKnowledgeAssetRootMutated: async () => { /* sink */ },
    });

    chain.failNextScan();
    await forceScan(poller);

    expect(chain.filters).toHaveLength(1);
    expect(saveCalls).toEqual([]);

    // Positive control: the very same drive persists when the scan succeeds,
    // so the empty `saveCalls` above is about the failure and not about
    // the forced scan never persisting anything.
    //
    // 49 950, not the head: the failed scan rewound the cursor from the seed
    // (41 000) to 40 950, so the recovery scan starts at 40 951 and is capped
    // at one MAX_RANGE page. The rewind therefore costs one extra poll to
    // reach the head — which is the intended trade and worth pinning, since a
    // rewind large enough to push catch-up past a page every time would turn a
    // transient failure into a permanently lagging lane.
    await forceScan(poller);
    expect(saveCalls).toEqual([{ lane: 'kaRootMutations', block: 40_951 + MAX_RANGE - 1 }]);
  });
});

describe('legacy aggregate cursor — transient read failure', () => {
  it('a rejected legacy load is retried on the next poll and scanning resumes from the restored cursor (review r16-bot)', async () => {
    // The shared aggregate read used to memoize its FIRST promise, rejection
    // included: one SQLITE_BUSY held every unrestored lane forever behind the
    // fail-closed restore guard. A rejection must be evicted and retried.
    let now = 0;
    let loads = 0;
    const seen: number[] = [];
    const chain = makeChain(1_100, [rootMutation('KnowledgeAssetUpdated', 1_050)]);
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      cursorPersistence: {
        async load() {
          loads += 1;
          if (loads === 1) throw new Error('SQLITE_BUSY');
          return 1_000;
        },
        async save() { /* not under test */ },
      },
      onKnowledgeAssetRootMutated: async (e) => { seen.push(e.position.blockNumber); },
    });

    await poll(poller); // first read rejects: nothing may scan
    expect(chain.filters, 'unrestored lanes hold').toHaveLength(0);
    now += CADENCE_MS;
    await poll(poller); // the read is RETRIED and succeeds
    expect(loads, 'the rejected read was not memoized').toBe(2);
    expect(chain.filters.length, 'scanning resumed').toBeGreaterThan(0);
    // 1000 restored, then the documented 50-block reorg rewind: scanning starts at 951.
    expect(Math.min(...chain.filters.map((f) => f.fromBlock ?? 0)), 'from the restored (rewound) cursor').toBe(951);
    expect(seen, 'and events past it are delivered').toContain(1_050);
  });
});
describe('kaRootMutations — activation contract', () => {
  it('start() fails LOUDLY when the root-mutation callback is wired on an adapter without getBlockNumber (review r14-bot)', async () => {
    // The lane scans only to the finalized head; without a readable head it
    // would hold on every tick and the callback would never fire — an API
    // break disguised as idleness. Activation must reject instead.
    const chain = makeChain(50_000);
    delete (chain.adapter as { getBlockNumber?: unknown }).getBlockNumber;
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      onKnowledgeAssetRootMutated: async () => undefined,
    });
    await expect(poller.start()).rejects.toThrow(/requires a ChainAdapter with getBlockNumber/);
  });

  it('start() refuses the root-mutation lane when the capability probe names a missing event kind (review r15-bot)', async () => {
    // A binding that cannot serve one kind would let the cursor advance
    // past mutations it never saw; activation must refuse and NAME it.
    const chain = makeChain(50_000);
    (chain.adapter as { supportsEventTypes?: (n: readonly string[]) => Promise<string[]> })
      .supportsEventTypes = async () => ['KnowledgeAssetMerkleRootRemoved'];
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      onKnowledgeAssetRootMutated: async () => undefined,
    });
    await expect(poller.start()).rejects.toThrow(/does not declare KnowledgeAssetMerkleRootRemoved/);
    expect(chain.filters, 'no scan may run under an unsupported subscription').toHaveLength(0);
  });

  it('a capability probe that THROWS fails activation as a probe failure, not as a negative answer', async () => {
    // A Hub unreachable at boot is not proof of a legacy ABI; the error must
    // say so, and start() must leave no lane running to retry into.
    const chain = makeChain(50_000);
    (chain.adapter as { supportsEventTypes?: (n: readonly string[]) => Promise<string[]> })
      .supportsEventTypes = async () => { throw new Error('Hub unreachable'); };
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      onKnowledgeAssetRootMutated: async () => undefined,
    });
    await expect(poller.start()).rejects.toThrow(/probe failed: Hub unreachable/);
    expect(chain.filters, 'no lane scans after a refused activation').toHaveLength(0);
    // The refusal is not sticky: once the probe answers, start() succeeds.
    (chain.adapter as { supportsEventTypes?: (n: readonly string[]) => Promise<string[]> })
      .supportsEventTypes = async () => [];
    await expect(poller.start()).resolves.toBeUndefined();
    await poller.stop();
  });
  it('a repeated start() on a running poller neither re-probes nor can fail (review r16-bot)', async () => {
    // The probe answers once; a second answer would throw. start() is
    // documented idempotent, so the second call must be a no-op that never
    // reaches the probe.
    let probes = 0;
    const chain = makeChain(50_000);
    (chain.adapter as { supportsEventTypes?: (n: readonly string[]) => Promise<string[]> })
      .supportsEventTypes = async () => {
        probes += 1;
        if (probes > 1) throw new Error('probe must not run again');
        return [];
      };
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      onKnowledgeAssetRootMutated: async () => undefined,
    });
    await poller.start();
    await expect(poller.start()).resolves.toBeUndefined();
    expect(probes, 'exactly one probe across two starts').toBe(1);
    await poller.stop();
  });
  it('start() refuses the root-mutation lane when the adapter offers NO capability probe (review r17-bot)', async () => {
    // Absence is not evidence: an adapter that emits only lifecycle updates
    // and omits the probe would let the cursor advance past root
    // additions/replacements/removals it never yields.
    const chain = makeChain(50_000);
    delete (chain.adapter as { supportsEventTypes?: unknown }).supportsEventTypes;
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      onKnowledgeAssetRootMutated: async () => undefined,
    });
    await expect(poller.start()).rejects.toThrow(/requires a ChainAdapter with supportsEventTypes/);
    expect(chain.filters, 'no scan may run under unverified coverage').toHaveLength(0);
  });

  it('an adapter without the probe still starts when the root-mutation callback is not wired', async () => {
    const chain = makeChain(50_000);
    delete (chain.adapter as { supportsEventTypes?: unknown }).supportsEventTypes;
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
    });
    await expect(poller.start()).resolves.toBeUndefined();
    await poller.stop();
  });
  it('concurrent start() calls share ONE activation: one probe, one interval (review r18-bot)', async () => {
    let probes = 0;
    let releaseProbe: (() => void) | undefined;
    const chain = makeChain(50_000);
    let heads = 0;
    const realHead = chain.adapter.getBlockNumber!.bind(chain.adapter);
    chain.adapter.getBlockNumber = async () => { heads += 1; return realHead(); };
    (chain.adapter as { supportsEventTypes?: (n: readonly string[]) => Promise<string[]> })
      .supportsEventTypes = () => new Promise((resolve) => {
        probes += 1;
        releaseProbe = () => resolve([]);
      });
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: 10,
      onKnowledgeAssetRootMutated: async () => undefined,
    });
    const first = poller.start();
    const second = poller.start();
    await new Promise((r) => setTimeout(r, 5));
    expect(probes, 'the second start joins the first activation').toBe(1);
    releaseProbe!();
    await Promise.all([first, second]);
    await new Promise((r) => setTimeout(r, 60));
    const polledWhileRunning = heads;
    expect(polledWhileRunning, 'the single interval polls').toBeGreaterThan(0);
    await poller.stop();
    const atStop = heads;
    await new Promise((r) => setTimeout(r, 60));
    expect(heads, 'no orphaned second interval survives stop()').toBe(atStop);
  });

  it('a stop() during the capability probe cancels the activation: no timer is ever installed (review r18-bot)', async () => {
    let releaseProbe: (() => void) | undefined;
    const chain = makeChain(50_000);
    let heads = 0;
    const realHead = chain.adapter.getBlockNumber!.bind(chain.adapter);
    chain.adapter.getBlockNumber = async () => { heads += 1; return realHead(); };
    (chain.adapter as { supportsEventTypes?: (n: readonly string[]) => Promise<string[]> })
      .supportsEventTypes = () => new Promise((resolve) => { releaseProbe = () => resolve([]); });
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: 10,
      onKnowledgeAssetRootMutated: async () => undefined,
    });
    const starting = poller.start();
    await new Promise((r) => setTimeout(r, 5));
    const stopping = poller.stop();
    await new Promise((r) => setTimeout(r, 5));
    releaseProbe!();
    await Promise.all([starting, stopping]);
    await new Promise((r) => setTimeout(r, 60));
    expect(heads, 'the cancelled activation never polled').toBe(0);
    expect((poller as unknown as { running: boolean }).running, 'and the poller is stopped').toBe(false);
    // The cancellation is not sticky: a later start() runs normally.
    (chain.adapter as { supportsEventTypes?: (n: readonly string[]) => Promise<string[]> })
      .supportsEventTypes = async () => [];
    await poller.start();
    await new Promise((r) => setTimeout(r, 40));
    expect(heads).toBeGreaterThan(0);
    await poller.stop();
  });
  it('start() proceeds when the capability probe reports every kind served', async () => {
    const chain = makeChain(50_000);
    (chain.adapter as { supportsEventTypes?: (n: readonly string[]) => Promise<string[]> })
      .supportsEventTypes = async () => [];
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      onKnowledgeAssetRootMutated: async () => undefined,
    });
    await expect(poller.start()).resolves.toBeUndefined();
    await poller.stop();
  });
  it('an adapter without getBlockNumber still starts when the root-mutation callback is not wired', async () => {
    const chain = makeChain(50_000);
    delete (chain.adapter as { getBlockNumber?: unknown }).getBlockNumber;
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
    });
    await expect(poller.start()).resolves.toBeUndefined();
    await poller.stop();
  });
});
