// Regression coverage for the libp2p-internal shape readers used by
// `getRelayStats()`. Codex review on PR #525 round 4 flagged that
// reading `(libp2p.services as any).relay.reservations` and
// `(conn as any).streams` directly ties our metrics surface to private
// libp2p object shapes — a future libp2p upgrade can silently break
// the counters with no type error. These tests pin the expected
// shapes so a libp2p change that breaks them fails loud here.
//
// What we assert:
//   1. The "happy path" shapes return non-null and behave correctly.
//   2. Each individual shape mismatch (missing services, wrong type,
//      missing relay key, wrong reservations type, missing streams,
//      non-array streams) returns null — which `getRelayStats()`
//      treats as "metrics not available" rather than crashing or
//      reporting silently-stale data.
import { describe, it, expect } from 'vitest';
import {
  readRelayReservations,
  readConnectionStreams,
} from '../src/relay-internal-shapes.js';

describe('readRelayReservations', () => {
  it('returns the reservations Map when libp2p shape matches the expected contract', () => {
    const res = new Map<{ toString(): string }, unknown>();
    res.set({ toString: () => 'peerA' }, { expiry: new Date(), addr: { toString: () => '/foo' } });
    const node = { services: { relay: { reservations: res } } };
    const got = readRelayReservations(node);
    expect(got).toBe(res);
    let count = 0;
    got?.forEach(() => { count += 1; });
    expect(count).toBe(1);
  });

  it('returns null when the libp2p node is missing entirely', () => {
    expect(readRelayReservations(undefined)).toBeNull();
    expect(readRelayReservations(null)).toBeNull();
  });

  it('returns null when `services` is missing or not an object', () => {
    expect(readRelayReservations({})).toBeNull();
    expect(readRelayReservations({ services: null })).toBeNull();
    expect(readRelayReservations({ services: 'not-an-object' })).toBeNull();
  });

  it('returns null on edge nodes (relay service not configured)', () => {
    expect(readRelayReservations({ services: {} })).toBeNull();
    expect(readRelayReservations({ services: { relay: null } })).toBeNull();
  });

  it('returns null when the relay shape no longer matches (reservations missing or wrong type)', () => {
    expect(readRelayReservations({ services: { relay: {} } })).toBeNull();
    expect(readRelayReservations({ services: { relay: { reservations: null } } })).toBeNull();
    expect(readRelayReservations({ services: { relay: { reservations: 'string' } } })).toBeNull();
    expect(readRelayReservations({ services: { relay: { reservations: { /* no forEach */ } } } })).toBeNull();
  });
});

describe('readConnectionStreams', () => {
  it('returns the stream array when libp2p Connection shape matches', () => {
    const streams = [
      { protocol: '/libp2p/circuit/relay/0.2.0/stop', direction: 'outbound' as const },
      { protocol: '/ipfs/id/1.0.0', direction: 'inbound' as const },
    ];
    const conn = { streams };
    const got = readConnectionStreams(conn);
    expect(got).toBe(streams);
    expect(got).toHaveLength(2);
  });

  it('returns null when conn is missing entirely', () => {
    expect(readConnectionStreams(undefined)).toBeNull();
    expect(readConnectionStreams(null)).toBeNull();
  });

  it('returns null when `streams` is missing or not an array', () => {
    expect(readConnectionStreams({})).toBeNull();
    expect(readConnectionStreams({ streams: null })).toBeNull();
    expect(readConnectionStreams({ streams: 'not-an-array' })).toBeNull();
    expect(readConnectionStreams({ streams: { length: 1 } })).toBeNull();
  });

  it('returns an empty array when the connection has streams but none are open', () => {
    expect(readConnectionStreams({ streams: [] })).toEqual([]);
  });
});
