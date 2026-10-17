import { describe, expect, it } from 'vitest';
import { SUBSCRIPTION_SOURCES, type SubscriptionSource } from '@origintrail-official/dkg-core';
import type { CollectedACK } from '../src/ack-collector.js';
import { ACKRoundDiagnostics, type ACKDiagnosticSummary } from '../src/ack-diagnostics.js';
import { PeerStatusLedger } from '../src/ack-peer-status-ledger.js';

const ack = (peerId: string, subscriptionSource?: SubscriptionSource): CollectedACK => ({
  peerId, signatureR: new Uint8Array(32), signatureVS: new Uint8Array(32),
  nodeIdentityId: 1n, ...(subscriptionSource ? { subscriptionSource } : {}),
});

describe('typed ACK candidate counts', () => {
  it('counts every terminal state within the frozen candidate scope', () => {
    const ledger = new PeerStatusLedger();
    ledger.recordACK(ack('accepted'));
    ledger.recordStorageDecline('declined', 'BUSY', 'peer text');
    // Validation text must never masquerade as another typed status.
    ledger.recordACKValidation('invalid', 'ACK:manual');
    ledger.recordProtocolUnsupported('unsupported', 'peer text');
    ledger.recordTransportError('transport', 'peer text');
    ledger.recordACK(ack('outside-scope'));
    expect(ledger.counts(['accepted', 'declined', 'invalid', 'unsupported', 'transport', 'missing']))
      .toEqual({ total: 6, ack: 1, declined: 1, invalid: 1, unsupported: 1, transport: 1, pending: 1 });
    expect(ledger.counts([])).toEqual({ total: 0, ack: 0, declined: 0, invalid: 0,
      unsupported: 0, transport: 0, pending: 0 });
  });

  it.each([undefined, ...Object.values(SUBSCRIPTION_SOURCES)])('counts ACK provenance %s without parsing operator text', source => {
    const ledger = new PeerStatusLedger();
    ledger.recordACK(ack('peer', source));
    expect(ledger.counts(['peer'])).toEqual({ total: 1, ack: 1, declined: 0, invalid: 0,
      unsupported: 0, transport: 0, pending: 0 });
    expect(ledger.snapshot(['peer'])[0].reason).toBe(source ? `ACK:${source}` : 'ACK');
  });

  it('preserves replacement and clearing, and keeps settled diagnostics immutable', () => {
    const ledger = new PeerStatusLedger();
    ledger.recordTransportError('peer', 'old failure');
    ledger.recordStorageDecline('peer', 'BUSY', 'retry');
    ledger.recordACK(ack('peer'));
    const events: unknown[] = [];
    const diagnostics = new ACKRoundDiagnostics(event => { events.push(event); });
    diagnostics.finish(ledger.counts(['peer']));
    ledger.clear('peer');
    expect(ledger.counts(['peer']).pending).toBe(1);
    expect(ledger.snapshot(['peer'])).toEqual([{ peerId: 'peer', reason: 'no_response' }]);
    diagnostics.finish(ledger.counts(['peer']));
    expect(events).toEqual([expect.objectContaining({ candidates: { total: 1, ack: 1, declined: 0,
      invalid: 0, unsupported: 0, transport: 0, pending: 0 } })]);
  });
});


describe('publisher-owned ACK summary', () => {
  const empty = () => new PeerStatusLedger().counts([]);
  it('emits one terminal aggregate with successful and failed attempts and both retry causes', async () => {
    let now = 0;
    const summaries: ACKDiagnosticSummary[] = [];
    const diagnostics = new ACKRoundDiagnostics(summary => summaries.push(summary), () => now);
    let resolve!: () => void; let reject!: (error: Error) => void;
    const first = diagnostics.measure('attempt', () => new Promise<void>(r => { resolve = r; }));
    const second = diagnostics.measure('attempt', () => new Promise<void>((_, r) => { reject = r; }))
      .catch(error => error);
    now = 10; resolve(); await first;
    now = 15; reject(new Error('transport failed')); await second;
    now = 20; await diagnostics.measure('backoff', async () => { now = 25; }, 'transport');
    now = 30; await diagnostics.measure('backoff', async () => { now = 37; }, 'transient_decline');
    expect(summaries).toEqual([]);
    diagnostics.finish(empty());
    diagnostics.finish(empty());
    expect(summaries).toEqual([{ completedPeerAttempts: 2, perRoundPeakPeerRequests: 2,
      peerAttemptMs: 25, backoffs: 2, backoffMs: 12, transportBackoffs: 1,
      transientDeclineBackoffs: 1, candidates: empty() }]);
  });

  it('freezes settlement totals and excludes retiring completions and later work', async () => {
    let now = 0; let resolve!: () => void;
    const summaries: ACKDiagnosticSummary[] = [];
    const diagnostics = new ACKRoundDiagnostics(summary => summaries.push(summary), () => now);
    const late = diagnostics.measure('attempt', () => new Promise<void>(r => { resolve = r; }));
    const counts = empty();
    now = 10; diagnostics.finish(counts);
    counts.total = 100;
    now = 100; resolve(); await late;
    await diagnostics.measure('attempt', async () => 1);
    await diagnostics.measure('backoff', async () => {});
    diagnostics.finish(counts);
    expect(summaries).toEqual([{ completedPeerAttempts: 0, perRoundPeakPeerRequests: 1,
      peerAttemptMs: 0, backoffs: 0, backoffMs: 0, transportBackoffs: 0,
      transientDeclineBackoffs: 0, candidates: empty() }]);
    expect(Object.isFrozen(summaries[0])).toBe(true);
    expect(Object.isFrozen(summaries[0].candidates)).toBe(true);
  });

  it('isolates a throwing or reentrant terminal observer', async () => {
    let calls = 0;
    const diagnostics = new ACKRoundDiagnostics(() => {
      calls++; diagnostics.finish(empty()); throw new Error('observer failed');
    });
    await expect(diagnostics.measure('attempt', async () => 42)).resolves.toBe(42);
    expect(() => diagnostics.finish(empty())).not.toThrow();
    expect(calls).toBe(1);
  });
});
