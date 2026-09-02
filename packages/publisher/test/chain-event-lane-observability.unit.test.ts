/**
 * The `kaRootMutations` lane's OBSERVABILITY through `ChainEventLaneRunner`
 * (#2435, PR #2436): metrics fault isolation and lane health. Split at
 * review r9 along the production boundaries.
 */
import {
  describe,
  it,
  expect,
} from 'vitest';
import {
  ChainEventPoller,
  type ChainEventLanePollResult,
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


describe('kaRootMutations — observability', () => {
  it('a throwing metrics sink never affects delivery, cursor persistence, or later scans (review r11)', async () => {
    // Metrics are observers, not participants: run the SAME drive twice, once
    // with sinks that always throw and once with none, and require identical
    // deliveries and identical persisted cursors. The lag hook fires before
    // the scan and the result hook after it, so an unisolated throw in either
    // would abort delivery or skip persistence after state advanced.
    async function drive(withThrowingSinks: boolean): Promise<{ seen: string[]; saved: number[] }> {
      const chain = makeChain(50_000, [rootMutation('KnowledgeAssetUpdated', 49_990)]);
      const seen: string[] = [];
      const saved: number[] = [];
      const poller = new ChainEventPoller({
        chain: chain.adapter,
        publishHandler: makeHandler(),
        intervalMs: CADENCE_MS,
        clock: () => 0,
        cursorPersistence: {
          async loadLane() { return undefined; },
          async saveLane(_lane, block) { saved.push(block); },
        } satisfies LaneCursorPersistence,
        ...(withThrowingSinks ? {
          metrics: {
            laneScan: () => { throw new Error('exporter down'); },
            laneCursorLag: () => { throw new Error('exporter down'); },
          },
        } : {}),
        onKnowledgeAssetRootMutated: async (e) => { seen.push(e.kaId); },
      });
      await forceScan(poller);
      // A second manual drive proves failure bookkeeping and schedules were
      // not corrupted by the throwing result hook of the first.
      chain.setHead(50_010);
      await forceScan(poller);
      return { seen, saved };
    }

    const throwing = await drive(true);
    const clean = await drive(false);
    expect(throwing.seen).toEqual(clean.seen);
    expect(throwing.seen.length).toBeGreaterThan(0);
    expect(throwing.saved).toEqual(clean.saved);
    expect(throwing.saved.length).toBeGreaterThan(0);
  });

  it('records lane scans and cursor lag with lane and result only', async () => {
    let now = 0;
    const polls: Array<{ lane: ChainEventPollerLane; result: ChainEventLanePollResult }> = [];
    const lags: Array<{ lane: ChainEventPollerLane; lagBlocks: number }> = [];
    // Captured from the PRODUCTION call sites, not from the objects this test
    // builds: an assertion over `Object.keys` of a literal written here would
    // only confirm what this test itself wrote.
    const rawArgCounts: number[] = [];
    const chain = makeChain(50_000);
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      metrics: {
        laneScan: function (...args) {
          rawArgCounts.push(args.length);
          polls.push({ lane: args[0], result: args[1] });
        },
        laneCursorLag: function (...args) {
          rawArgCounts.push(args.length);
          lags.push({ lane: args[0], lagBlocks: args[1] });
        },
      },
      onKnowledgeAssetRootMutated: async () => { /* sink */ },
    });

    await poll(poller);                      // catch-up  -> success
    now += CADENCE_MS;
    await poll(poller);                      // caught up -> no-work
    now += CADENCE_MS;
    chain.failNextScan();
    chain.setHead(50_100);
    await poll(poller);                      // scan throws -> failure

    expect(polls).toEqual([
      { lane: 'kaRootMutations', result: 'success' },
      { lane: 'kaRootMutations', result: 'noWork' },
      { lane: 'kaRootMutations', result: 'failure' },
    ]);
    // Lag is measured before the scan: seeded 41 000 against head 50 000, then
    // caught up, then 100 blocks behind the advanced head.
    expect(lags).toEqual([
      { lane: 'kaRootMutations', lagBlocks: MAX_RANGE },
      { lane: 'kaRootMutations', lagBlocks: 0 },
      { lane: 'kaRootMutations', lagBlocks: 100 },
    ]);
    // Every production call site passed exactly two arguments — no third
    // channel through which a KA id, context-graph id or transaction hash
    // could reach a metric attribute.
    expect(rawArgCounts.length).toBeGreaterThan(0);
    expect(new Set(rawArgCounts)).toEqual(new Set([2]));
  });

  it('exposes the last scanned head and time per active lane', async () => {
    let now = 1_700_000_000_000;
    const chain = makeChain(50_000);
    const poller = new ChainEventPoller({
      chain: chain.adapter,
      publishHandler: makeHandler(),
      intervalMs: CADENCE_MS,
      clock: () => now,
      onKnowledgeAssetRootMutated: async () => { /* sink */ },
    });

    expect(poller.getLaneHealth()).toEqual([
      { lane: 'kaRootMutations', lastBlock: 0, lastScanHead: undefined, lastScanAtMs: undefined },
    ]);

    await poll(poller);

    expect(poller.getLaneHealth()).toEqual([
      { lane: 'kaRootMutations', lastBlock: 50_000, lastScanHead: 50_000, lastScanAtMs: now },
    ]);
  });
});
