import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@origintrail-official/dkg-core';
import { AsyncLiftCompletionTrace, type CompletionTraceSources } from '../src/async-lift-completion-trace.js';

const prefix = 'async_publish_completion_trace ';
const txHash = `0x${'ab'.repeat(32)}`;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function capture() {
  const lines: string[] = [];
  let tick = 0;
  const source: CompletionTraceSources = {
    enabled: () => true, clock: () => ++tick,
    monotonicNs: () => BigInt(tick) * 1_000_000n,
    wallClock: () => 10_000 - tick,
    write: (line) => { lines.push(line); },
  };
  return { source, lines, events: () => lines.map(line => JSON.parse(line.slice(prefix.length))) };
}

describe('async publisher completion trace', () => {
  it('emits all five immediate observations in call order without a duration threshold', () => {
    const { source, events } = capture();
    const trace = new AsyncLiftCompletionTrace(source);
    expect(trace.acceptedPrimaryCommitted('job-1')).toBeUndefined();
    trace.finalityObserved('job-1', txHash);
    // Canonical proof can release a wallet before local terminal persistence.
    trace.walletOwnershipReleased('job-1', 'private-wallet', 'private-epoch');
    trace.terminalPrimaryCommitted('job-1');
    trace.terminalOperationSettled('job-1');
    const rows = events();
    expect(rows.map(row => row.event)).toEqual([
      'accepted_primary_committed', 'finality_observed', 'wallet_ownership_released',
      'terminal_primary_committed', 'terminal_operation_settled',
    ]);
    expect(rows.map(row => row.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.map(row => row.monotonicMs)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.map(row => row.hrtimeNs)).toEqual(['1000000', '2000000', '3000000', '4000000', '5000000']);
    expect(rows.map(row => row.wallTimeMs)).toEqual([9999, 9998, 9997, 9996, 9995]);
    expect(rows.every(row => row.processId === process.pid && row.schemaVersion === 1 && row.jobId === 'job-1')).toBe(true);
    expect(rows[1].txHash).toBe(txHash);
  });

  it('hashes wallet and epoch and never serializes raw context fields', () => {
    const { source, lines, events } = capture();
    const trace = new AsyncLiftCompletionTrace(source);
    trace.walletOwnershipReleased('job-1', 'secret-wallet', 'secret-claim-token');
    trace.walletOwnershipReleased('job-2', 'secret-wallet');
    expect(events()[0]).toMatchObject({ walletHash: sha('secret-wallet'), claimEpochHash: sha('secret-claim-token') });
    expect(events()[1]).toMatchObject({ walletHash: sha('secret-wallet') });
    expect(events()[1]).not.toHaveProperty('claimEpochHash');
    expect(lines.join('')).not.toMatch(/secret-wallet|secret-claim-token|walletId|claimToken/);
    expect(Object.keys(events()[0]).sort()).toEqual([
      'claimEpochHash', 'event', 'hrtimeNs', 'jobId', 'monotonicMs', 'processId',
      'schemaVersion', 'sequence', 'wallTimeMs', 'walletHash',
    ]);
  });

  it('does no clock or output work when disabled', () => {
    const clock = vi.fn(() => 0), monotonicNs = vi.fn(() => 0n), wallClock = vi.fn(() => 0), write = vi.fn();
    const trace = new AsyncLiftCompletionTrace({ enabled: () => false, clock, monotonicNs, wallClock, write });
    expect(trace.enabled).toBe(false);
    trace.acceptedPrimaryCommitted('job'); trace.finalityObserved('job', txHash);
    trace.terminalPrimaryCommitted('job'); trace.terminalOperationSettled('job');
    trace.walletOwnershipReleased('job', 'wallet', 'token');
    for (const observer of [clock, monotonicNs, wallClock, write]) expect(observer).not.toHaveBeenCalled();
  });

  it.each(['enabled', 'clock', 'monotonicNs', 'wallClock', 'write'] as const)(
    'contains a throwing %s observer without preventing later observations', (field) => {
      const { source, events } = capture();
      const restored = source[field];
      const failure = { ...source, [field]: () => { throw new Error('observer error'); } };
      const trace = new AsyncLiftCompletionTrace(failure);
      if (field === 'enabled') expect(trace.enabled).toBe(false);
      expect(() => trace.terminalPrimaryCommitted('job')).not.toThrow();
      Object.assign(failure, { [field]: restored });
      trace.terminalOperationSettled('job');
      expect(events()).toHaveLength(1);
      expect(events()[0].event).toBe('terminal_operation_settled');
    },
  );

  it('requires the explicit opt-in and writes even a single short-lived event at info', () => {
    const info = vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {});
    const trace = new AsyncLiftCompletionTrace();
    vi.stubEnv('DKG_ASYNC_PUBLISH_COMPLETION_TRACE', '0');
    trace.acceptedPrimaryCommitted('job');
    expect(info).not.toHaveBeenCalled();
    vi.stubEnv('DKG_ASYNC_PUBLISH_COMPLETION_TRACE', '1');
    trace.acceptedPrimaryCommitted('job');
    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0][1]).toContain(prefix);
  });
});
