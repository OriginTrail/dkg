import { describe, expect, it } from 'vitest';
import type { RpcRequestTimingSnapshot, RpcTimingDistribution } from '@origintrail-official/dkg-chain';
import {
  VM_RECOVERY_PHASES,
  VmRecoveryPhaseRecorder,
  describeVmRecoveryRpcSince,
  formatVmRecoveryPhases,
  markVmRecoveryRpc,
  noteVmReconcilePassEnd,
  observeVmRecoveryTiming,
  vmReconcilePassGapMs,
  type VmRecoveryTimingSources,
} from '../src/vm-recovery-phase-timing.js';

function distribution(count: number, totalMs: number, buckets = [count, 0, 0, 0, 0, 0]): RpcTimingDistribution {
  return { count, totalMs, buckets };
}

function timing(input: {
  bgWait?: RpcTimingDistribution;
  bgEndpoint?: RpcTimingDistribution;
  fgEndpoint?: RpcTimingDistribution;
  bgFailures?: number;
}): RpcRequestTimingSnapshot {
  return {
    schemaVersion: 1,
    background: {
      admissionWait: input.bgWait ?? distribution(0, 0),
      endpointLatency: input.bgEndpoint ?? distribution(0, 0),
      endpointFailures: input.bgFailures ?? 0,
    },
    foreground: {
      admissionWait: distribution(0, 0),
      endpointLatency: input.fgEndpoint ?? distribution(0, 0),
      endpointFailures: 0,
    },
  };
}

function usageSnapshot(
  methods: Record<string, number>,
  consumers: Record<string, Record<string, number>>,
): ReturnType<VmRecoveryTimingSources['usage']> {
  return {
    schemaVersion: 1,
    consumerVocabularyVersion: 2,
    processEpoch: 'test',
    capturedAtUtc: '2026-10-01T00:00:00.000Z',
    capturedAtMonotonicMs: 0,
    completeness: {
      complete: true,
      reasons: [],
      populationEpoch: 1,
      sources: {
        mainAgent: { status: 'included', totalRegisteredTrackers: 1, totalsRetained: true },
        publisherWallets: { status: 'included', totalRegisteredTrackers: 0, totalsRetained: true },
        routeRuntimes: { status: 'included', totalRegisteredTrackers: 0, totalsRetained: true },
        other: { status: 'included', totalRegisteredTrackers: 0, totalsRetained: true },
      },
    },
    cumulative: { methods, consumers, adapterRoles: {} },
  } as ReturnType<VmRecoveryTimingSources['usage']>;
}

/** Each source consumes its own scripted queue, so call order is explicit in the test. */
function scriptedSources(script: {
  clocks?: number[];
  timings?: RpcRequestTimingSnapshot[];
  usages?: Array<ReturnType<typeof usageSnapshot>>;
}): VmRecoveryTimingSources {
  const clocks = [...(script.clocks ?? [])];
  const timings = [...(script.timings ?? [])];
  const usages = [...(script.usages ?? [])];
  return {
    clock: () => clocks.shift() ?? 0,
    timing: () => timings.shift() ?? timing({}),
    usage: () => usages.shift() ?? usageSnapshot({}, {}),
  };
}

describe('VM recovery phase timing', () => {
  it('charges elapsed time and background request usage to the measured phase', async () => {
    const recorder = new VmRecoveryPhaseRecorder(scriptedSources({
      clocks: [100, 1_600],
      timings: [
        timing({}),
        timing({ bgWait: distribution(4, 2_400), bgEndpoint: distribution(4, 600) }),
      ],
    }));
    const value = await recorder.measure('sizing', async () => 'result');
    expect(value).toBe('result');
    const totals = recorder.take();
    expect(totals.sizing).toMatchObject({
      ms: 1_500, backgroundAttempts: 4, backgroundAdmissionWaitMs: 2_400, backgroundEndpointMs: 600,
    });
    expect(totals.exchange).toMatchObject({ ms: 0, backgroundAttempts: 0 });
  });

  it('passes a rejection through unchanged and still charges the phase', async () => {
    const recorder = new VmRecoveryPhaseRecorder();
    const failure = new Error('boom');
    await expect(recorder.measure('exchange', async () => { throw failure; })).rejects.toBe(failure);
    expect(recorder.take().exchange.ms).toBeGreaterThanOrEqual(0);
  });

  it('drains totals on take() so a second batch starts from zero', async () => {
    const recorder = new VmRecoveryPhaseRecorder();
    await recorder.measure('roster', async () => undefined);
    recorder.take();
    for (const phase of VM_RECOVERY_PHASES) expect(recorder.take()[phase].ms).toBe(0);
  });

  it('keeps whole-pass totals across the per-batch drains', () => {
    const recorder = new VmRecoveryPhaseRecorder(scriptedSources({
      // Two exchanges of 30 ms and 50 ms, each with its own background request.
      clocks: [0, 30, 100, 150],
      timings: [
        timing({}), timing({ bgWait: distribution(1, 4) }),
        timing({ bgWait: distribution(1, 4) }), timing({ bgWait: distribution(2, 11) }),
      ],
    }));
    const first = recorder.begin();
    recorder.chargeSince('exchange', first.startedAt, first.before);
    const batchOne = recorder.take();
    const second = recorder.begin();
    recorder.chargeSince('exchange', second.startedAt, second.before);
    const batchTwo = recorder.take();

    expect(batchOne.exchange).toMatchObject({ ms: 30, backgroundAttempts: 1 });
    expect(batchTwo.exchange).toMatchObject({ ms: 50, backgroundAttempts: 1 });
    // The pass summary reports both batches, not only what followed the last drain.
    expect(recorder.cumulative().exchange).toMatchObject({ ms: 80, backgroundAttempts: 2, backgroundAdmissionWaitMs: 11 });
    expect(recorder.take().exchange.ms).toBe(0);
    // Reading the pass totals changes nothing.
    expect(recorder.cumulative().exchange.ms).toBe(80);
  });

  it('supports manual brackets for code that cannot run as a closure', () => {
    const recorder = new VmRecoveryPhaseRecorder(scriptedSources({
      clocks: [10, 40],
      timings: [timing({}), timing({ bgWait: distribution(1, 5) })],
    }));
    const interval = recorder.begin();
    recorder.chargeSince('transport', interval.startedAt, interval.before);
    expect(recorder.take().transport).toMatchObject({ ms: 30, backgroundAttempts: 1 });
  });

  it('never throws when the counters are unavailable', async () => {
    const broken: VmRecoveryTimingSources = {
      clock: () => performance.now(),
      timing: () => { throw new Error('unavailable'); },
      usage: () => { throw new Error('unavailable'); },
    };
    const recorder = new VmRecoveryPhaseRecorder(broken);
    await expect(recorder.measure('post-fetch', async () => 7)).resolves.toBe(7);
    expect(markVmRecoveryRpc(broken)).toBeUndefined();
    expect(describeVmRecoveryRpcSince(undefined, broken)).toBe('rpcTotal=unknown');
  });

  it('describes the RPC delta by method and consumer with a secret-free vocabulary', () => {
    const before = markVmRecoveryRpc(scriptedSources({
      timings: [timing({})],
      usages: [usageSnapshot(
        { eth_call: 10, eth_getBlockByNumber: 4 },
        { eth_call: { 'kas.getLatestMerkleRoot': 6, 'cgStorage.kaToContextGraph': 4 } },
      )],
    }));
    const description = describeVmRecoveryRpcSince(before, scriptedSources({
      timings: [timing({
        bgWait: distribution(3, 3_000, [0, 0, 0, 3, 0, 0]),
        bgEndpoint: distribution(3, 450), fgEndpoint: distribution(1, 80), bgFailures: 1,
      })],
      usages: [usageSnapshot(
        { eth_call: 17, eth_getBlockByNumber: 5 },
        { eth_call: { 'kas.getLatestMerkleRoot': 12, 'cgStorage.kaToContextGraph': 5 } },
      )],
    }));
    expect(description).toContain('rpcTotal=8');
    expect(description).toContain('rpcByMethod=eth_call:7,eth_getBlockByNumber:1');
    expect(description).toContain('rpcTop=eth_call/kas.getLatestMerkleRoot:6,eth_call/cgStorage.kaToContextGraph:1');
    expect(description).toContain('bgAdmissionCount=3 bgAdmissionTotalMs=3000 bgAdmissionMeanMs=1000 bgAdmissionOver1sCount=3');
    expect(description).toContain('bgEndpointCount=3');
    expect(description).toContain('bgEndpointFailures=1');
    expect(description).toContain('fgEndpointCount=1');
    expect(description).not.toMatch(/https?:\/\//);
  });

  it('formats every phase in a stable order', () => {
    const recorder = new VmRecoveryPhaseRecorder();
    const text = formatVmRecoveryPhases(recorder.take());
    expect(text.split(' ').filter((token) => token.endsWith('Ms=0')).length).toBeGreaterThanOrEqual(6);
    expect(text.indexOf('rosterMs=')).toBeLessThan(text.indexOf('postFetchMs='));
    expect(text).toContain('peerReadyBgReq=0');
  });

  it('tracks pass gaps per owner with a bounded graph table', () => {
    const owner = {};
    expect(vmReconcilePassGapMs(owner, 'cg-a', 500)).toBeUndefined();
    noteVmReconcilePassEnd(owner, 'cg-a', 400);
    expect(vmReconcilePassGapMs(owner, 'cg-a', 515)).toBe(115);
    expect(vmReconcilePassGapMs({}, 'cg-a', 515)).toBeUndefined();
    for (let index = 0; index < 400; index += 1) noteVmReconcilePassEnd(owner, `cg-${index}`, index);
    expect(vmReconcilePassGapMs(owner, 'cg-0', 1_000)).toBeUndefined();
    expect(vmReconcilePassGapMs(owner, 'cg-399', 1_000)).toBe(601);
  });

  it('swallows observation failures', () => {
    expect(() => observeVmRecoveryTiming(() => { throw new Error('log sink failed'); })).not.toThrow();
  });
});
