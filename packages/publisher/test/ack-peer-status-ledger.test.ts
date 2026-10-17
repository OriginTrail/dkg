import { describe, expect, it } from 'vitest';
import { SUBSCRIPTION_SOURCES, type SubscriptionSource } from '@origintrail-official/dkg-core';
import type { CollectedACK } from '../src/ack-collector.js';
import { ACKRoundDiagnostics } from '../src/ack-diagnostics.js';
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
    expect(events).toEqual([{ kind: 'outcomes', counts: { total: 1, ack: 1, declined: 0,
      invalid: 0, unsupported: 0, transport: 0, pending: 0 } }]);
  });
});
