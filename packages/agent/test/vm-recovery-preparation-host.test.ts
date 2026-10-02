/** Experimental next-batch sizing preparation, exercised through the real recovery pass. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DKGAgent } from '../src/index.js';
import type { OrdinalRecoveryTarget } from '../src/chain-reconciler.js';
import { FinalizationRuntime } from '../src/finalization-runtime.js';
import { existingVmRecoveryPreparation, vmRecoveryPreparationFor } from '../src/vm-recovery-preparation.js';
import { createVmRecoveryHostHarness } from './_helpers/vm-recovery-host.js';

interface RecoveryTarget extends OrdinalRecoveryTarget {
  readonly localCgId: string;
  readonly onChainCgId: string;
  readonly ordinal: number;
  readonly ual: string;
  readonly merkleRoot: string;
  readonly kaId: string;
  readonly reason: 'no-swm';
}

const CG = '0x0000000000000000000000000000000000000001/prepared';

function target(ordinal: number): RecoveryTarget {
  return {
    localCgId: CG,
    onChainCgId: '1',
    ordinal,
    ual: `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${ordinal}`,
    merkleRoot: `root-${ordinal}`,
    kaId: String(ordinal),
    reason: 'no-swm',
  };
}

/** A sizing read that stays outstanding until released and never observes cancellation itself. */
function heldRead() {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  return { gate, release, reached, entered, signal: undefined as AbortSignal | undefined };
}

/** `unsizedReads[ka]` = how many of that KA's first sizing reads return an unusable tuple. */
async function scenario(name: string, options: { unsizedReads?: Record<number, number> } = {}) {
  const events: string[] = [];
  const harness = await createVmRecoveryHostHarness({
    name,
    localCgId: CG,
    peers: ['12D3KooWPreparedHolder'],
    targetCount: 10,
    targetForOrdinal: target,
    onFetch: (_peerId, requested, recovered) => {
      events.push(`fetch:${requested.length}`);
      for (const item of requested) recovered.add(item.ordinal);
      return 'found';
    },
  });
  const readsByKa = new Map<number, number>();
  const failing = new Map(Object.entries(options.unsizedReads ?? {}).map(([ka, count]) => [Number(ka), count]));
  const original = harness.chainAdapter.getKnowledgeAssetUpdateContext!.bind(harness.chainAdapter);
  harness.chainAdapter.getKnowledgeAssetUpdateContext = async (kaId, readOptions) => {
    const ordinal = Number(kaId);
    events.push(`read:${ordinal}`);
    readsByKa.set(ordinal, (readsByKa.get(ordinal) ?? 0) + 1);
    const remaining = failing.get(ordinal) ?? 0;
    if (remaining > 0) {
      failing.set(ordinal, remaining - 1);
      return { merkleRootsCount: 0n, byteSize: 0n, merkleLeafCount: 0 };
    }
    return original(kaId, readOptions);
  };
  return { harness, readsByKa, events };
}

async function twoPasses(h: Awaited<ReturnType<typeof scenario>>['harness']) {
  const first = await h.run();
  const second = await h.internals.recoverVmReconcileBatch(
    CG, h.contextGraphId, h.targets.filter((item) => !h.recovered.has(item.ordinal)), 100, () => true,
  );
  return { first, second };
}

describe('VM recovery next-batch sizing preparation', () => {
  const agents: DKGAgent[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(agents.splice(0).map((agent) => agent.stop().catch(() => undefined)));
  });

  it('is inert unless explicitly enabled: sizing reads and batches are exactly as before', async () => {
    const { harness, readsByKa } = await scenario('PreparedOff', { unsizedReads: { 5: 2 } });
    agents.push(harness.agent);
    await twoPasses(harness);
    expect(existingVmRecoveryPreparation(harness.agent)).toBeUndefined();
    // Candidates beyond the planned prefix are sized again by the next pass.
    for (const ka of [6, 7, 8, 9]) expect(readsByKa.get(ka)).toBe(2);
  });

  it('carries resolved hints for the unplanned remainder into the next pass instead of re-reading them', async () => {
    vi.stubEnv('DKG_EXPERIMENTAL_VM_RECOVERY_PREFETCH', '1');
    const { harness, readsByKa } = await scenario('PreparedOn', { unsizedReads: { 5: 2 } });
    agents.push(harness.agent);
    const { first, second } = await twoPasses(harness);

    // First pass: probe of 0 and a batch cut at the unsized 5; second pass picks up 5..9.
    expect(harness.fetched.slice(0, 2).map(({ uals }) => uals.length)).toEqual([1, 4]);
    expect(first.attemptedOrdinals).toEqual([0, 1, 2, 3, 4]);
    expect(second.attemptedOrdinals.sort((left, right) => left - right)).toEqual([5, 6, 7, 8, 9]);
    // Each resolved hint was used once; nothing was read twice for the remainder.
    for (const ka of [6, 7, 8, 9]) expect(readsByKa.get(ka)).toBe(1);
    const stats = existingVmRecoveryPreparation(harness.agent)!.stats();
    expect(stats.hits).toBeGreaterThanOrEqual(4);
    expect(stats.maxActiveReads).toBeLessThanOrEqual(2);
    expect(stats.retainedBytes).toBe(0);
  });

  it('never changes which assets are fetched or in what order', async () => {
    const off = await scenario('PreparedParityOff', { unsizedReads: { 5: 2 } });
    agents.push(off.harness.agent);
    await twoPasses(off.harness);

    vi.stubEnv('DKG_EXPERIMENTAL_VM_RECOVERY_PREFETCH', '1');
    const on = await scenario('PreparedParityOn', { unsizedReads: { 5: 2 } });
    agents.push(on.harness.agent);
    await twoPasses(on.harness);

    expect(on.harness.fetched.map(({ uals }) => uals)).toEqual(off.harness.fetched.map(({ uals }) => uals));
  });

  it('does not prepare or hand out hints once recovery ownership is lost', async () => {
    vi.stubEnv('DKG_EXPERIMENTAL_VM_RECOVERY_PREFETCH', '1');
    const { harness, readsByKa } = await scenario('PreparedStale', { unsizedReads: { 5: 2 } });
    agents.push(harness.agent);
    await harness.run();
    const preparation = existingVmRecoveryPreparation(harness.agent)!;
    // The graph is unsubscribed / rebound between passes.
    harness.internals.clearVmReconcileRotationStateForContextGraph(CG);
    expect(preparation.stats().retainedBytes).toBe(0);

    await harness.internals.recoverVmReconcileBatch(
      CG, harness.contextGraphId, harness.targets.filter((item) => !harness.recovered.has(item.ordinal)), 100, () => true,
    );
    // Without the carried hints the next pass reads the remainder again.
    for (const ka of [6, 7, 8, 9]) expect(readsByKa.get(ka)).toBe(2);
  });

  it('starts sizing the pass\'s own targets before the first exchange without adding a read', async () => {
    const off = await scenario('PreparedEntryOff');
    agents.push(off.harness.agent);
    await off.harness.run();

    vi.stubEnv('DKG_EXPERIMENTAL_VM_RECOVERY_PREFETCH', '1');
    const on = await scenario('PreparedEntryOn');
    agents.push(on.harness.agent);
    await on.harness.run();

    // Same fetches, and every target is read exactly as often as without preparation:
    // the first target is the probe's own asset and is never speculatively read.
    expect(on.harness.fetched.map(({ uals }) => uals)).toEqual(off.harness.fetched.map(({ uals }) => uals));
    expect([...on.readsByKa].sort(([a], [b]) => a - b)).toEqual([...off.readsByKa].sort(([a], [b]) => a - b));
    expect(on.readsByKa.get(0)).toBeUndefined();
    for (const ka of [1, 2, 3, 4, 5, 6, 7, 8, 9]) expect(on.readsByKa.get(ka)).toBe(1);
    // Without preparation nothing is sized before the probe transfers; with it, the
    // reads for the following batch are already under way when the first fetch starts.
    expect(off.events[0]).toBe('fetch:1');
    expect(on.events.indexOf('fetch:1')).toBeGreaterThan(0);
    expect(on.events[0]).toMatch(/^read:/);
    const stats = existingVmRecoveryPreparation(on.harness.agent)!.stats();
    expect(stats.hits).toBeGreaterThanOrEqual(1);
    expect(stats.maxActiveReads).toBeLessThanOrEqual(2);
    expect(stats.retainedBytes).toBe(0);
  });

  it('agent shutdown cancels an outstanding speculative read and waits for it to settle before closing the store', async () => {
    vi.stubEnv('DKG_EXPERIMENTAL_VM_RECOVERY_PREFETCH', '1');
    const { harness } = await scenario('PreparedShutdown');
    agents.push(harness.agent);

    // The host's own owner, with one speculative read that stays outstanding and ignores
    // cancellation, like an adapter whose physical request outlives its abort.
    const held = heldRead();
    const preparation = vmRecoveryPreparationFor(harness.agent, {
      readUpdateContext: async (_kaId, readOptions) => {
        held.signal = readOptions?.signal;
        held.entered();
        await held.gate;
        return { merkleRootsCount: 1n, byteSize: 1_024n, merkleLeafCount: 8, minted: 1n, endEpoch: 1n, tokenAmount: 0n, isImmutable: false };
      },
    });
    const scope = { localCgId: CG, onChainCgId: harness.contextGraphId, generation: 0, isCurrent: () => true };
    expect(preparation.prepare(scope, [{ kaId: '6' }]).accepted).toBe(1);
    await held.reached;
    expect(existingVmRecoveryPreparation(harness.agent)).toBe(preparation);
    expect(preparation.stats().activeReads).toBe(1);
    expect(held.signal?.aborted).toBe(false);

    // The real stop(), on the host. The collaborators it tears down after the reconcile
    // drain are recorded so we can see whether it waited.
    const stopNode = vi.fn(async () => {});
    const closeStore = vi.fn(async () => {});
    Object.assign(harness.agent, {
      started: true,
      chainPoller: null,
      coreHostRecordingsClosed: false,
      drainCoreHostRecordings: vi.fn(async () => {}),
      messenger: { stopOutboxDrain: vi.fn(async () => {}) },
      clearStorageACKRegistrationRetry: vi.fn(),
      storageACKRegistrationRetryInFlight: false,
      inFlightSubstrateFanOutCount: () => 0,
      router: { closePooling: vi.fn(async () => {}) },
      node: { libp2p: { getPeers: () => [], getConnections: () => [] }, stop: stopNode },
      finalizationRuntime: new FinalizationRuntime(),
      store: { close: closeStore },
      log: { warn: vi.fn(), info: vi.fn() },
    });
    const stopping = harness.agent.stop();
    let stopped = false;
    void stopping.then(() => { stopped = true; }, () => { stopped = true; });

    // Cancellation reaches the speculative read, and the owner stops handing out hints.
    await vi.waitFor(() => expect(held.signal?.aborted).toBe(true));
    expect(preparation.closed).toBe(true);
    expect(existingVmRecoveryPreparation(harness.agent)).toBeUndefined();

    // The cancelled read has not physically settled, so shutdown must still be waiting for it:
    // the agent's drain holds the owner's close, and neither the network nor the store is torn down.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((harness.agent as unknown as { vmReconcilePhysicalRuns: Set<Promise<unknown>> }).vmReconcilePhysicalRuns.size)
      .toBeGreaterThan(0);
    expect(stopped).toBe(false);
    expect(stopNode).not.toHaveBeenCalled();
    expect(closeStore).not.toHaveBeenCalled();
    expect(preparation.stats().activeReads).toBe(1);

    // Once the read really settles the drain completes and teardown proceeds.
    held.release();
    await stopping;
    expect(preparation.stats().activeReads).toBe(0);
    expect(stopNode).toHaveBeenCalledOnce();
    expect(closeStore).toHaveBeenCalledOnce();
  });
});
