// SPDX-License-Identifier: Apache-2.0
/**
 * W2 (#2435) — the DRAIN seam (split from the combined suite, review r2).
 * Driven through the REAL `runExactAssetFetch` with production-shape chain
 * stubs, not hand-made `{status, versionBlock}` literals: the property under
 * test is that the block the chain view was read at reaches the decision,
 * and a hand-made item would assert the decision while silently skipping the
 * plumbing that carries it.
 */
import { describe, expect, it } from 'vitest';

// Hand-rolled call recorder: wraps an implementation, records every argument
// tuple, returns the result.
function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls });
}

import {
  AUTHOR,
  InMemoryVmReverifyIntentStore,
  kaIdFor,
  position,
} from './_helpers/vm-reverify-fixtures.js';
import { buildReconciledKnowledgeAssetUal } from '../src/ka-identity.js';
import {
  runExactAssetFetch,
  type ContextGraphAssetFetchResult,
  type ExactAssetChainSnapshot,
  type ExactAssetFetchEvidence,
  type ExactAssetLocalState,
} from '../src/sync/exact-asset-fetch.js';
import {
  VM_REVERIFY_ADMISSION_PRIORITY,
  VmReverifyWorker,
} from '../src/vm-reverify-worker.js';
import { EXACT_ASSET_FETCH_ADMISSION_PRIORITY } from '../src/sync/exact-asset-fetch.js';
import type { VmReverifyIntentUpsertInput } from '../src/vm-reverify-intent-store.js';
import {
  VM_REVERIFY_FLAT_BACKOFF_MS,
  VM_REVERIFY_PARK_AFTER_MS,
} from '../src/vm-reverify-intents.js';
describe('vm-reverify drain — the repair, through the real exact-asset fetch', () => {
  const CHAIN_ID = 'mock:31337';
  const STORAGE = '0x000000000000000000000000000000000000c10a';
  const DRAIN_CG = 'w2r-drain-cg';

  const ualOf = (kaNumber: bigint) =>
    buildReconciledKnowledgeAssetUal(CHAIN_ID, STORAGE, kaIdFor(kaNumber));

  function snapshot(blockNumber: number, rootByte = 9): ExactAssetChainSnapshot {
    return {
      latestRoot: `0x${rootByte.toString(16).padStart(2, '0').repeat(32)}`,
      rootCount: 2n,
      latestAuthor: AUTHOR,
      latestPublisher: AUTHOR,
      blockNumber,
    };
  }

  /**
   * A `fetchContextGraphAssets`-shaped function backed by the REAL
   * `runExactAssetFetch`, so `versionBlock` genuinely travels chain read ->
   * evidence -> item result -> decision.
   */
  function makeFetch(overrides: {
    snapshotFor?: (kaId: bigint) => ExactAssetChainSnapshot | null;
    localState?: (evidence: ExactAssetFetchEvidence) => ExactAssetLocalState;
    peerIds?: readonly string[];
    fetchFromPeer?: (peerId: string, uals: readonly string[]) => Promise<void>;
    contextGraphIdFor?: (kaId: bigint) => bigint;
  } = {}) {
    const options: Array<{ inspectOnly?: boolean; admissionPriority?: number }> = [];
    const requested: string[][] = [];
    const fetch = async (
      localCgId: string,
      uals: readonly string[],
      callOptions: { inspectOnly?: boolean; admissionPriority?: number },
    ): Promise<ContextGraphAssetFetchResult> => {
      options.push(callOptions);
      requested.push([...uals]);
      return runExactAssetFetch({ contextGraphId: localCgId, requestedUals: uals }, {
        chainId: CHAIN_ID,
        isCurrent: () => true,
        getKAContextGraphId: async (kaId) => (overrides.contextGraphIdFor ?? (() => 1n))(kaId),
        readKnowledgeAssetVersionSnapshot: async (kaId) =>
          (overrides.snapshotFor ?? (() => snapshot(200)))(kaId),
        verifyLocalContextGraph: async () => true,
        inspectLocal: async (evidence) =>
          (overrides.localState ?? (() => 'present' as const))(evidence),
        resolvePeerIds: async () => overrides.peerIds ?? ['peer-a'],
        preparePeer: async () => true,
        fetchFromPeer: overrides.fetchFromPeer ?? (async () => undefined),
        flush: async () => undefined,
        log: () => undefined,
      });
    };
    return Object.assign(fetch, { options, requested });
  }

  function makeWorker(
    intents: InMemoryVmReverifyIntentStore,
    fetch: ReturnType<typeof makeFetch>,
    settings: Parameters<typeof VmReverifyWorker.prototype.constructor> extends never
      ? never
      : Record<string, number> = {},
    now = 10_000,
    swm: {
      recover?: (localCgId: string, verifyRecovered: () => Promise<boolean>) => Promise<void>;
      durableSyncEnabled?: () => boolean;
    } = {},
  ) {
    const lines: string[] = [];
    const worker = new VmReverifyWorker({
      intents,
      fetchContextGraphAssets: fetch,
      ...(swm.recover ? { recoverContextGraphSwm: swm.recover } : {}),
      ...(swm.durableSyncEnabled ? { durableSyncEnabled: swm.durableSyncEnabled } : {}),
      log: { info: (message) => lines.push(message), warn: (message) => lines.push(message) },
      now: () => now,
      settings: settings as never,
    });
    return { worker, lines };
  }

  async function seed(
    intents: InMemoryVmReverifyIntentStore,
    kaNumber: bigint,
    observedBlock: number,
    kind: VmReverifyIntentUpsertInput['kind'] = 'lifecycle-update',
  ): Promise<string> {
    const ual = ualOf(kaNumber);
    await intents.upsert({
      ual,
      localCgId: DRAIN_CG,
      kaId: kaIdFor(kaNumber).toString(),
      kind,
      position: position(observedBlock),
    });
    return ual;
  }

  it('resolves an already-current asset with ZERO peer contact', async () => {
    const intents = new InMemoryVmReverifyIntentStore();
    const ual = await seed(intents, 1n, 150);
    const fetch = makeFetch({ snapshotFor: () => snapshot(200) });
    const { worker } = makeWorker(intents, fetch);

    const run = await worker.runOnce();

    expect(run.items).toHaveLength(1);
    expect(run.items[0]).toMatchObject({ ual, action: 'resolve', reason: 'already-present' });
    expect(run.networkAttempted, 'no peer may be contacted for a current asset').toBe(false);
    expect(run.peerAttempts).toBe(0);
    expect(await intents.countPending()).toBe(0);
  });

  it('schedules the retry from the clock at COMPLETION, not from before the fetch (review r1)', async () => {
    // The drain pass reads the clock, then does network I/O that can outlast
    // the whole retry delay. A `nextAttemptAt` computed from the PRE-I/O
    // clock would already be overdue when written, so a full backlog would
    // re-poll immediately instead of backing off.
    const intents = new InMemoryVmReverifyIntentStore();
    const ual = await seed(intents, 71n, 300);
    let clock = 10_000;
    const fetch = makeFetch({
      // The chain read consumes 120s — four times the flat retry delay —
      // and answers with a view read BEFORE the event, forcing a retry.
      snapshotFor: () => { clock += 120_000; return snapshot(299); },
    });
    const worker = new VmReverifyWorker({
      intents,
      fetchContextGraphAssets: fetch,
      log: { info: () => undefined, warn: () => undefined },
      now: () => clock,
    });

    const run = await worker.runOnce();

    expect(run.items[0]).toMatchObject({ ual, action: 'retry', reason: 'snapshot-behind-event' });
    const record = intents.rows.get(ual)!;
    // start (10_000) + fetch I/O (120_000) + flat delay — NOT start + delay,
    // which at 40_000 would be 90s in the past by the time it was written.
    expect(record.nextAttemptAt).toBe(130_000 + VM_REVERIFY_FLAT_BACKOFF_MS);
    expect(record.nextAttemptAt! > clock, "the retry must still be in the future").toBe(true);
  });
  it('RETRIES rather than resolves when the chain view predates the event', async () => {
    // The production shape of the bug this design exists to prevent: every
    // configured endpoint answered, unanimously, with a view read one block
    // BEFORE the update. The asset looks current. It is not.
    const intents = new InMemoryVmReverifyIntentStore();
    const ual = await seed(intents, 2n, 300);
    const fetch = makeFetch({
      snapshotFor: () => snapshot(299),          // observedBlock - 1
      localState: () => 'present',                // and the old root IS local
    });
    const { worker } = makeWorker(intents, fetch);

    const run = await worker.runOnce();

    expect(run.items[0]).toMatchObject({
      ual,
      action: 'retry',
      reason: 'snapshot-behind-event',
      versionBlock: 299,
    });
    const row = intents.rows.get(ual);
    expect(row?.state, 'the intent must survive').toBe('PENDING');
    expect(row?.generation, 'a retry does not redefine the event').toBe(0);
    expect(row?.attemptCount).toBe(1);
    expect(await intents.countPending()).toBe(1);
  });

  it('reports the version block the decision was actually made on', async () => {
    // Guards the plumbing, not the rule: an item result that dropped
    // `versionBlock` would make every decision above unfalsifiable.
    const intents = new InMemoryVmReverifyIntentStore();
    await seed(intents, 3n, 100);
    const fetch = makeFetch({ snapshotFor: () => snapshot(4_242) });
    const { worker } = makeWorker(intents, fetch);

    const run = await worker.runOnce();
    expect(run.items[0]?.versionBlock).toBe(4_242);
  });

  it('retries an unresolved asset and parks it once the 24 h budget is spent', async () => {
    const intents = new InMemoryVmReverifyIntentStore();
    const ual = await seed(intents, 4n, 100);
    const fetch = makeFetch({
      snapshotFor: () => snapshot(200),
      localState: () => 'missing',
      peerIds: ['peer-a'],
    });

    const first = makeWorker(intents, fetch, {}, 10_000);
    const firstRun = await first.worker.runOnce();
    expect(firstRun.items[0]).toMatchObject({ action: 'retry', reason: 'unresolved' });
    expect(firstRun.peerAttempts, 'an unresolved asset must have asked a peer').toBeGreaterThan(0);
    expect(intents.rows.get(ual)?.firstAttemptAt).toBe(10_000);

    // Make it due again, then step past the budget.
    intents.rows.set(ual, { ...intents.rows.get(ual)!, nextAttemptAt: 0 });
    const parked = makeWorker(intents, fetch, {}, 10_000 + VM_REVERIFY_PARK_AFTER_MS);
    const parkedRun = await parked.worker.runOnce();
    expect(parkedRun.items[0]).toMatchObject({ action: 'abandon', reason: 'no-peer-has-version' });
    expect(intents.rows.get(ual)?.state).toBe('ABANDONED');
    expect(await intents.countPending()).toBe(0);
  });

  it('deferrals behind a disabled durable plane do not consume the 24h peer budget (review r2)', async () => {
    // Two days behind the switch, then the plane returns: the first genuine
    // peer-unresolved attempt must open a FRESH 24h window, not inherit one
    // that expired while the deferral reason made peer recovery impossible.
    const intents = new InMemoryVmReverifyIntentStore();
    const ual = await seed(intents, 66n, 100);
    let clock = 10_000;
    let durableOn = false;
    const fetch = makeFetch({
      snapshotFor: () => snapshot(200),
      localState: () => 'missing',
      peerIds: [],
    });
    const worker = new VmReverifyWorker({
      intents,
      fetchContextGraphAssets: fetch,
      recoverContextGraphSwm: async () => undefined,
      durableSyncEnabled: () => durableOn,
      log: { info: () => undefined, warn: () => undefined },
      now: () => clock,
    });

    const run1 = await worker.runOnce();
    expect(run1.items[0]).toMatchObject({ ual, action: 'retry', reason: 'durable-sync-disabled' });
    expect(intents.rows.get(ual)!.firstAttemptAt, 'a deferral must not start the budget').toBeUndefined();

    // Two days later the operator re-enables the durable plane.
    clock += 2 * 24 * 60 * 60 * 1_000;
    durableOn = true;
    const run2 = await worker.runOnce();
    expect(
      run2.items[0],
      'the first real peer-unresolved attempt must RETRY on a fresh window, not park',
    ).toMatchObject({ ual, action: 'retry', reason: 'unresolved' });
    expect(intents.rows.get(ual)!.firstAttemptAt).toBe(clock);

    // And the fresh window still ends: 24h of genuine unresolved later, park.
    clock += VM_REVERIFY_PARK_AFTER_MS + 1;
    const run3 = await worker.runOnce();
    expect(run3.items[0]).toMatchObject({ ual, action: 'abandon', reason: 'no-peer-has-version' });
  });

  it('a stale generation is reported as SUPERSEDED, never as the planned transition (review r2)', async () => {
    // The exact race the CAS exists for: the lane advances the row while the
    // drain is planning against the old generation. The refused write must
    // not be tallied as the transition that never happened.
    const intents = new InMemoryVmReverifyIntentStore();
    const ual = await seed(intents, 67n, 100);
    const fetch = makeFetch({
      snapshotFor: () => snapshot(200),
      localState: () => 'missing',
      peerIds: ['peer-a'],
      fetchFromPeer: async () => {
        // Mid-drain: a strictly newer mutation redefines the row.
        await intents.upsert({
          ual,
          localCgId: DRAIN_CG,
          kaId: kaIdFor(67n).toString(),
          kind: 'root-added',
          position: position(200, 0, 1),
        });
      },
    });
    const { worker } = makeWorker(intents, fetch);

    const run = await worker.runOnce();

    expect(run.superseded).toBe(1);
    expect(run.retried, 'the refused retry must not be claimed').toBe(0);
    expect(run.outcomes['superseded:stale-generation']).toBe(1);
    const row = intents.rows.get(ual)!;
    expect(row).toMatchObject({ state: 'PENDING', generation: 1, attemptCount: 0, kind: 'root-added' });
  });
  it('abandons a root REMOVAL it cannot repair, loudly and revivably', async () => {
    const intents = new InMemoryVmReverifyIntentStore();
    const ual = await seed(intents, 5n, 100, 'root-removed');
    const fetch = makeFetch({ snapshotFor: () => snapshot(200), localState: () => 'missing' });
    const { worker, lines } = makeWorker(intents, fetch);

    const run = await worker.runOnce();
    expect(run.items[0]).toMatchObject({
      action: 'abandon',
      reason: 'version-regression-unsupported',
    });
    expect(intents.rows.get(ual)?.state).toBe('ABANDONED');
    expect(lines.some((line) => line.includes('reason=version-regression-unsupported'))).toBe(true);

    // Terminal-until-revived, never terminal: re-hosting the CG restores it.
    expect(await intents.reviveForContextGraph(DRAIN_CG)).toBe(1);
    expect(await intents.countPending()).toBe(1);
  });

  it('does not let ONE poisoned asset strand its siblings for a whole poll interval', async () => {
    // The repair primitive resolves evidence for every requested asset up front
    // and throws for the WHOLE call if any one is bad. Without the singleton
    // fallback, nine healthy assets wait behind a tenth until the next tick —
    // and if the tenth never heals, forever.
    const intents = new InMemoryVmReverifyIntentStore();
    const good1 = await seed(intents, 11n, 100);
    const poison = await seed(intents, 12n, 101);
    const good2 = await seed(intents, 13n, 102);
    const poisonKaId = kaIdFor(12n);

    const fetch = makeFetch({
      snapshotFor: (kaId) => (kaId === poisonKaId ? null : snapshot(200)),
    });
    const { worker } = makeWorker(intents, fetch);

    const run = await worker.runOnce();

    const byUal = new Map(run.items.map((item) => [item.ual, item]));
    expect(byUal.get(good1)).toMatchObject({ action: 'resolve' });
    expect(byUal.get(good2)).toMatchObject({ action: 'resolve' });
    expect(
      byUal.get(poison),
      'a non-unanimous endpoint view is transient, not an identity conflict',
    ).toMatchObject({ action: 'retry', reason: 'snapshot-unavailable' });
    expect(await intents.countPending()).toBe(1);
    expect(
      fetch.requested.map((uals) => uals.length),
      'the chunk is attempted once, then each asset alone',
    ).toEqual([3, 1, 1, 1]);
  });

  it('does not let a poisoned chunk spend the budget another Context Graph needed', async () => {
    // The singleton fallback is deliberately NOT charged against
    // `maxCallsPerRun`: that budget bounds how many CHUNKS a run attempts. If
    // the fallback drew from it, one bad asset would eat the whole run and the
    // next Context Graph's work would wait a full poll interval behind it —
    // reintroducing, one level up, the starvation the fallback exists to
    // remove. Only observable with a budget above one, so it is its own row.
    const intents = new InMemoryVmReverifyIntentStore();
    const poison = await seed(intents, 51n, 10);
    const sibling = await seed(intents, 52n, 11);
    await intents.upsert({
      ual: ualOf(53n),
      localCgId: 'second-cg',
      kaId: kaIdFor(53n).toString(),
      kind: 'lifecycle-update',
      position: position(12),
    });

    const fetch = makeFetch({
      snapshotFor: (kaId) => (kaId === kaIdFor(51n) ? null : snapshot(200)),
    });
    const { worker } = makeWorker(intents, fetch, { maxCallsPerRun: 2 });

    const run = await worker.runOnce();

    const byUal = new Map(run.items.map((item) => [item.ual, item]));
    expect(byUal.get(poison)).toMatchObject({ action: 'retry', reason: 'snapshot-unavailable' });
    expect(byUal.get(sibling)).toMatchObject({ action: 'resolve' });
    expect(
      byUal.get(ualOf(53n)),
      'the second Context Graph must still get its call in this run',
    ).toMatchObject({ action: 'resolve' });
  });

  it('pairs an unresolved item with ONE whole-CG SWM recovery, then retries the fetch ONCE', async () => {
    // ADR-W2R-10. The exact-asset fetch transfers data and metadata but no SWM,
    // and chain-promotion refuses to materialize until the local version-scoped
    // SWM projection is present. For a host-only core nothing else supplies it,
    // so without this pairing the drain detects perfectly and repairs never —
    // green-while-inert for exactly the population the feature exists for.
    const intents = new InMemoryVmReverifyIntentStore();
    const ual = await seed(intents, 61n, 100);
    const recovered: string[] = [];
    // Missing until the recovery lands, present afterwards — the shape the real
    // `head=N, store=0` -> `store=N` transition takes.
    let swmPresent = false;
    const fetch = makeFetch({
      snapshotFor: () => snapshot(200),
      localState: () => (swmPresent ? 'materialized' : 'missing'),
      peerIds: ['peer-a'],
    });
    const { worker } = makeWorker(intents, fetch, {}, 10_000, {
      // The production loop shape (review r1): recover from a peer, then let
      // the TARGET-specific verdict decide whether to stop.
      recover: async (localCgId, verifyRecovered) => {
        recovered.push(localCgId);
        swmPresent = true;
        expect(await verifyRecovered(), 'the recovery served the target').toBe(true);
      },
      durableSyncEnabled: () => true,
    });

    const run = await worker.runOnce();

    expect(recovered, 'exactly one whole-CG recovery, for the right CG').toEqual([DRAIN_CG]);
    expect(run.swmRecoveries).toBe(1);
    expect(
      fetch.requested.length,
      'the chunk call, then ONE re-run for the stranded UAL — not a loop',
    ).toBe(2);
    expect(run.items[0]).toMatchObject({ ual, action: 'resolve' });
    expect(await intents.countPending()).toBe(0);
  });

  it('does NOT resurrect the durable plane an operator switched off', async () => {
    const intents = new InMemoryVmReverifyIntentStore();
    const ual = await seed(intents, 62n, 100);
    const recovered: string[] = [];
    const fetch = makeFetch({ snapshotFor: () => snapshot(200), localState: () => 'missing' });
    const { worker } = makeWorker(intents, fetch, {}, 10_000, {
      recover: async (localCgId) => { recovered.push(localCgId); },
      durableSyncEnabled: () => false,
    });

    const run = await worker.runOnce();

    expect(recovered, 'no recovery may be attempted').toEqual([]);
    expect(run.swmRecoveries).toBe(0);
    expect(fetch.requested.length, 'and no second fetch').toBe(1);
    expect(run.items[0]).toMatchObject({
      ual,
      action: 'retry',
      reason: 'durable-sync-disabled',
    });
    expect(
      intents.rows.get(ual)?.state,
      'deferred, never parked — the work must be waiting when the plane returns',
    ).toBe('PENDING');
  });

  it('survives a recovery that throws, and leaves the item retryable', async () => {
    const intents = new InMemoryVmReverifyIntentStore();
    const ual = await seed(intents, 63n, 100);
    const fetch = makeFetch({ snapshotFor: () => snapshot(200), localState: () => 'missing' });
    const { worker, lines } = makeWorker(intents, fetch, {}, 10_000, {
      recover: async () => { throw new Error('peer hung up'); },
      durableSyncEnabled: () => true,
    });

    const run = await worker.runOnce();

    expect(run.items[0]).toMatchObject({ ual, action: 'retry', reason: 'unresolved' });
    expect(fetch.requested.length, 'a failed recovery must not trigger the re-fetch').toBe(1);
    expect(lines.some((line) => line.includes('swm-recovery') && line.includes('peer hung up')))
      .toBe(true);
    expect(await intents.countPending()).toBe(1);
  });

  it('continues past a peer whose writes did not serve the TARGET (review r1)', async () => {
    // A whole-graph recovery can make plenty of unrelated progress. The
    // verdict is the stranded asset's own re-fetch: a first peer that keeps
    // returning partial, unrelated writes must not stop the traversal before
    // the peer that holds the needed version.
    const intents = new InMemoryVmReverifyIntentStore();
    const ual = await seed(intents, 64n, 100);
    let served = false;
    const fetch = makeFetch({
      snapshotFor: () => snapshot(200),
      localState: () => (served ? 'materialized' : 'missing'),
    });
    const verdicts: boolean[] = [];
    const { worker } = makeWorker(intents, fetch, {}, 10_000, {
      recover: async (_localCgId, verifyRecovered) => {
        // Peer A: unrelated meta progress; the target stays stranded.
        verdicts.push(await verifyRecovered());
        // Peer B: supplies the version-scoped SWM the target needs.
        served = true;
        verdicts.push(await verifyRecovered());
      },
      durableSyncEnabled: () => true,
    });

    const run = await worker.runOnce();

    expect(verdicts, 'stranded after peer A, served after peer B').toEqual([false, true]);
    expect(run.items[0]).toMatchObject({ ual, action: 'resolve' });
    expect(
      fetch.requested.length,
      'the chunk call plus one verification re-fetch per productive peer',
    ).toBe(3);
    expect(await intents.countPending()).toBe(0);
  });
  it('abandons a chain-identity conflict instead of retrying it forever', async () => {
    const intents = new InMemoryVmReverifyIntentStore();
    const ual = await seed(intents, 14n, 100);
    // Registered to no Context Graph: the chain says this UAL is not the asset
    // we think it is, and no amount of retrying changes that.
    const fetch = makeFetch({ contextGraphIdFor: () => 0n });
    const { worker } = makeWorker(intents, fetch);

    const run = await worker.runOnce();
    expect(run.items[0]).toMatchObject({
      ual,
      action: 'abandon',
      reason: 'chain-identity-conflict',
    });
  });

  it('passes inspect-only and a BELOW-operator admission priority on every call', async () => {
    const intents = new InMemoryVmReverifyIntentStore();
    await seed(intents, 15n, 100);
    const fetch = makeFetch();
    const { worker } = makeWorker(intents, fetch);

    await worker.runOnce();

    expect(fetch.options).toHaveLength(1);
    expect(fetch.options[0]).toEqual({
      inspectOnly: true,
      admissionPriority: VM_REVERIFY_ADMISSION_PRIORITY,
    });
    expect(
      VM_REVERIFY_ADMISSION_PRIORITY,
      'automatic convergence must never displace an operator fetch (ADR-W2R-9)',
    ).toBeLessThan(EXACT_ASSET_FETCH_ADMISSION_PRIORITY);
  });

  it('honours the batch size and the per-run call budget', async () => {
    const intents = new InMemoryVmReverifyIntentStore();
    for (let i = 0; i < 12; i += 1) await seed(intents, BigInt(20 + i), 100 + i);
    // A second Context Graph's worth of work, due at the same time.
    await intents.upsert({
      ual: ualOf(99n),
      localCgId: 'other-cg',
      kaId: kaIdFor(99n).toString(),
      kind: 'lifecycle-update',
      position: position(1),
    });

    const fetch = makeFetch();
    const { worker } = makeWorker(intents, fetch);
    const run = await worker.runOnce();

    expect(run.inspected, 'at most one batch of intents per run').toBe(10);
    expect(fetch.requested, 'at most one CHUNK call per run').toHaveLength(1);
    expect(
      fetch.requested[0]?.[0],
      'the oldest observed event is served first',
    ).toBe(ualOf(99n));
  });

  it('serializes overlapping runs instead of racing two planners over one row', async () => {
    const intents = new InMemoryVmReverifyIntentStore();
    await seed(intents, 30n, 100);
    const original = intents.listDue.bind(intents);
    const listDue = recorder((now: number, limit: number) => original(now, limit));
    (intents as unknown as { listDue: unknown }).listDue = listDue;

    const fetch = makeFetch();
    const { worker } = makeWorker(intents, fetch);

    const [a, b] = await Promise.all([worker.runOnce(), worker.runOnce()]);

    expect(a, 'the second caller joins the run in flight').toBe(b);
    expect(listDue.calls, 'exactly one selection pass').toHaveLength(1);
    expect(fetch.requested).toHaveLength(1);
  });

  it('rolls outcomes up under BOUNDED keys — never a UAL, a KA id or a CG id', async () => {
    // This roll-up is the shape PR-C turns into metric attributes. An
    // identifier reaching it would make the cardinality unbounded, which the
    // label allowlist exists to prevent — and the log line right next to it
    // already carries the identifiers, so nothing is lost by excluding them.
    const intents = new InMemoryVmReverifyIntentStore();
    const resolved = await seed(intents, 41n, 100);
    const behind = await seed(intents, 42n, 400);
    const fetch = makeFetch({
      snapshotFor: (kaId) => (kaId === kaIdFor(42n) ? snapshot(399) : snapshot(200)),
    });
    const { worker, lines } = makeWorker(intents, fetch);

    const run = await worker.runOnce();

    expect(run.outcomes).toEqual({
      'resolve:already-present': 1,
      'retry:snapshot-behind-event': 1,
    });
    const forbidden = [resolved, behind, kaIdFor(41n).toString(), DRAIN_CG];
    for (const key of Object.keys(run.outcomes)) {
      for (const identifier of forbidden) {
        expect(key.includes(identifier), `outcome key "${key}" leaks an identifier`).toBe(false);
      }
    }
    // …while the LOG line does carry them, which is where they belong.
    expect(lines.some((line) => line.includes(`ual=${resolved}`) && line.includes(`cg=${DRAIN_CG}`)))
      .toBe(true);
    expect(lines.every((line) => line.startsWith('vm-reverify action='))).toBe(true);
  });
});

