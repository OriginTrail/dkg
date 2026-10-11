/** Observation-only batch/pass timing lines emitted by exact VM recovery. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DKGAgent } from '../src/index.js';
import type { OrdinalRecoveryTarget } from '../src/chain-reconciler.js';
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

function recoveryTarget(localCgId: string, ordinal: number): RecoveryTarget {
  return {
    localCgId,
    onChainCgId: '1',
    ordinal,
    ual: `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${ordinal}`,
    merkleRoot: `root-${ordinal}`,
    kaId: String(ordinal),
    reason: 'no-swm',
  };
}

async function harness(name: string, targetCount: number, fetchDelayMs = 0) {
  const localCgId = '0x0000000000000000000000000000000000000001/timing';
  return createVmRecoveryHostHarness({
    name,
    localCgId,
    peers: ['12D3KooWTimingHolder'],
    targetCount,
    targetForOrdinal: (ordinal) => recoveryTarget(localCgId, ordinal),
    onFetch: async (_peerId, requested, recovered) => {
      if (fetchDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, fetchDelayMs));
      for (const target of requested) recovered.add(target.ordinal);
      return 'found';
    },
  });
}

describe('VM recovery batch timing lines', () => {
  const agents: DKGAgent[] = [];

  afterEach(async () => {
    await Promise.all(agents.splice(0).map((agent) => agent.stop().catch(() => undefined)));
  });

  it('emits one batch line per executed exact batch plus one pass summary, without secrets', async () => {
    const h = await harness('TimingLines', 8);
    agents.push(h.agent);
    const info = vi.spyOn((h.agent as unknown as { log: { info: (...args: unknown[]) => void } }).log, 'info');

    await h.run();

    const lines = info.mock.calls.map(([, message]) => String(message));
    const batchLines = lines.filter((line) => line.includes('VM recovery batch timing for'));
    const passLines = lines.filter((line) => line.includes('VM recovery pass timing for'));
    // One probe, then one proven-holder microbatch: exactly the executed fetches.
    expect(h.fetched.map(({ uals }) => uals.length)).toEqual([1, 7]);
    expect(batchLines).toHaveLength(2);
    expect(passLines).toHaveLength(1);
    // The wire decision is logged when it is made, before the exchange can stall.
    const decisions = lines.filter((line) => line.includes('VM exact recovery transport for'));
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toMatch(/kind=probe transport=\S+ assets=1 streamAdvertised=\d+ streamPeers=\d+ registeredAuthority=\S+/);
    expect(decisions[1]).toMatch(/kind=proven-holder-reuse transport=\S+ assets=7 /);
    expect(batchLines[0]).toMatch(/assets=1 .*kind=probe /);
    expect(batchLines[1]).toMatch(/assets=7 .*kind=proven-holder-reuse /);
    for (const line of batchLines) {
      expect(line).toMatch(/streamAdvertised=\d+ streamPeers=\d+ registeredAuthority=\S+ totalMs=\d+/);
      expect(line).toMatch(/totalMs=\d+ rosterMs=\d+ rosterBgReq=\d+ rosterBgWaitMs=\d+/);
      expect(line).toMatch(/sizingRequested=\d+ sizingPrepared=\d+ sizingResolved=\d+ sizingTimedOut=\d+/);
      expect(line).toMatch(/rpcTotal=\S+/);
      expect(line).not.toMatch(/https?:\/\//);
    }
    expect(passLines[0]).toMatch(/batches=2 assets=8 eligible=8 totalMs=\d+/);
  });

  it('reports the combined phase totals of every batch in the pass summary', async () => {
    const h = await harness('TimingPassTotals', 8, 15);
    agents.push(h.agent);
    const info = vi.spyOn((h.agent as unknown as { log: { info: (...args: unknown[]) => void } }).log, 'info');

    await h.run();

    const lines = info.mock.calls.map(([, message]) => String(message));
    const batchLines = lines.filter((line) => line.includes('VM recovery batch timing for'));
    const passLines = lines.filter((line) => line.includes('VM recovery pass timing for'));
    expect(batchLines).toHaveLength(2);
    expect(passLines).toHaveLength(1);
    const exchangeMs = (line: string): number => Number(/ exchangeMs=(\d+) /.exec(line)![1]);
    const batchesTotal = exchangeMs(batchLines[0]!) + exchangeMs(batchLines[1]!);
    expect(batchesTotal).toBeGreaterThanOrEqual(25);
    // Every batch drains its own totals; the pass summary must still carry all of them
    // (each figure is rounded to a millisecond, hence the small tolerance).
    expect(Math.abs(exchangeMs(passLines[0]!) - batchesTotal)).toBeLessThanOrEqual(2);
  });

  it('counts sizing outcomes for the batch whose packing they shaped', async () => {
    const h = await harness('TimingSizing', 6);
    agents.push(h.agent);
    const info = vi.spyOn((h.agent as unknown as { log: { info: (...args: unknown[]) => void } }).log, 'info');

    await h.run();

    const batchLines = info.mock.calls
      .map(([, message]) => String(message))
      .filter((line) => line.includes('VM recovery batch timing for'));
    // The second batch sized the five targets that remained after the probe.
    expect(batchLines[1]).toContain('sizingRequested=5 sizingPrepared=0 sizingResolved=5 sizingTimedOut=0');
  });

  it('never lets a failing log sink change the recovery result', async () => {
    const quiet = await harness('TimingQuiet', 8);
    agents.push(quiet.agent);
    const expected = await quiet.run();

    const noisy = await harness('TimingNoisy', 8);
    agents.push(noisy.agent);
    const log = (noisy.agent as unknown as { log: { info: (...args: unknown[]) => void } }).log;
    const original = log.info.bind(log);
    vi.spyOn(log, 'info').mockImplementation((context: unknown, message: unknown) => {
      if (String(message).includes('timing for')) throw new Error('sink failed');
      original(context, message);
    });

    const actual = await noisy.run();

    expect(noisy.fetched.map(({ uals }) => uals.length)).toEqual(quiet.fetched.map(({ uals }) => uals.length));
    expect(actual.attemptedOrdinals).toEqual(expected.attemptedOrdinals);
    expect([...actual.outcomes]).toEqual([...expected.outcomes]);
    expect(actual.continuationOrdinal).toBe(expected.continuationOrdinal);
  });
});
