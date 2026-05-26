import { describe, it, expect } from 'vitest';
import {
  buildRelayStatusBlock,
  type RelayStatsSubset,
} from '../src/daemon/relay-status-block.js';

const FULL_STATS: RelayStatsSubset = {
  capacity: 1024,
  reservationCount: 17,
  activeCircuits: 5,
  bytesIn: 123456789n,
  bytesOut: 987654321n,
};

describe('buildRelayStatusBlock — edge node shape', () => {
  it('null relayStats yields the edge baseline: held=0, capacity/circuits/bytes null', () => {
    // Edge nodes don't run a relay server, so `agent.node.getRelayStats()`
    // returns null. The block still includes the relay key (uniform shape),
    // but every role-irrelevant field is null. The one exception is
    // `reservationsHeld` which is `0` rather than null — semantically more
    // truthful (zero is "no held reservations", null is "field not applicable").
    const block = buildRelayStatusBlock({
      isCore: false,
      relayStats: null,
      natStatus: 'unknown',
      advertisedAddresses: ['/ip4/192.168.1.1/tcp/4001', '/p2p-circuit'],
      configuredAnnounceAddresses: [],
    });
    expect(block).toEqual({
      isCore: false,
      reservationsHeld: 0,
      reservationCapacity: null,
      activeCircuits: null,
      bytesIn: null,
      bytesOut: null,
      natStatus: 'unknown',
      advertisedAddresses: ['/ip4/192.168.1.1/tcp/4001', '/p2p-circuit'],
      configuredAnnounceAddresses: [],
    });
  });

  it('advertisedAddresses + configuredAnnounceAddresses are passed through unchanged for edge', () => {
    const block = buildRelayStatusBlock({
      isCore: false,
      relayStats: null,
      natStatus: 'private',
      advertisedAddresses: ['/ip4/10.0.0.5/tcp/4001'],
      configuredAnnounceAddresses: ['/dns4/edge.example.com/tcp/4001'],
    });
    expect(block.advertisedAddresses).toEqual(['/ip4/10.0.0.5/tcp/4001']);
    expect(block.configuredAnnounceAddresses).toEqual(['/dns4/edge.example.com/tcp/4001']);
  });
});

describe('buildRelayStatusBlock — core node shape', () => {
  it('populated relayStats yields every numeric + stringified-bigint field on a core', () => {
    const block = buildRelayStatusBlock({
      isCore: true,
      relayStats: FULL_STATS,
      natStatus: 'public',
      advertisedAddresses: ['/ip4/203.0.113.5/tcp/4001'],
      configuredAnnounceAddresses: [],
    });
    expect(block).toEqual({
      isCore: true,
      reservationsHeld: 17,
      reservationCapacity: 1024,
      activeCircuits: 5,
      bytesIn: '123456789',
      bytesOut: '987654321',
      natStatus: 'public',
      advertisedAddresses: ['/ip4/203.0.113.5/tcp/4001'],
      configuredAnnounceAddresses: [],
    });
  });

  it("isCore: true with null relayStats handles the boot-race window (relay server not yet initialised)", () => {
    // Realistic during the first few hundred ms of boot: nodeRole is 'core'
    // but the relay server hasn't finished spinning up, so getRelayStats()
    // returns null. The block must not crash on this — it should look the
    // same as the edge case (zeros / nulls) for the duration of the race.
    const block = buildRelayStatusBlock({
      isCore: true,
      relayStats: null,
      natStatus: 'unknown',
      advertisedAddresses: [],
      configuredAnnounceAddresses: [],
    });
    expect(block.isCore).toBe(true);
    expect(block.reservationsHeld).toBe(0);
    expect(block.reservationCapacity).toBeNull();
    expect(block.bytesIn).toBeNull();
  });
});

describe('buildRelayStatusBlock — BigInt serialization', () => {
  it('preserves precision past Number.MAX_SAFE_INTEGER via toString()', () => {
    // The whole reason `bytesIn` / `bytesOut` are typed as bigint internally
    // is that a busy long-uptime Core can run past 2^53 bytes (≈ 9 PB) in a
    // few weeks. Naive `Number(b)` would silently truncate. Verify the
    // stringification path preserves precision via JSON round-trip.
    const big = (BigInt(Number.MAX_SAFE_INTEGER) + 1n) * 7n; // > 2^53
    const block = buildRelayStatusBlock({
      isCore: true,
      relayStats: { ...FULL_STATS, bytesIn: big, bytesOut: big * 3n },
      natStatus: 'public',
      advertisedAddresses: [],
      configuredAnnounceAddresses: [],
    });
    expect(block.bytesIn).toBe(big.toString());
    expect(block.bytesOut).toBe((big * 3n).toString());

    // Round-trip through JSON (the real API code path) must work.
    const reJson = JSON.parse(JSON.stringify(block));
    expect(reJson.bytesIn).toBe(big.toString());
    expect(BigInt(reJson.bytesIn)).toBe(big);
  });

  it('returns bytes as strings even when the values are small (uniform type — never number-on-some-bodies)', () => {
    // The temptation is "small enough → return as number for convenience".
    // Don't. Consumers parsing the response would have to typeof-switch,
    // which is exactly the kind of footgun this PR's "one schema, no role
    // switch" goal is designed to prevent.
    const block = buildRelayStatusBlock({
      isCore: true,
      relayStats: { ...FULL_STATS, bytesIn: 5n, bytesOut: 0n },
      natStatus: 'public',
      advertisedAddresses: [],
      configuredAnnounceAddresses: [],
    });
    expect(block.bytesIn).toBe('5');
    expect(block.bytesOut).toBe('0');
    expect(typeof block.bytesIn).toBe('string');
    expect(typeof block.bytesOut).toBe('string');
  });
});

describe('buildRelayStatusBlock — natStatus pass-through', () => {
  it.each(['public', 'private', 'unknown'] as const)(
    'natStatus=%s flows through unchanged',
    (natStatus) => {
      const block = buildRelayStatusBlock({
        isCore: true,
        relayStats: FULL_STATS,
        natStatus,
        advertisedAddresses: [],
        configuredAnnounceAddresses: [],
      });
      expect(block.natStatus).toBe(natStatus);
    },
  );
});

describe('buildRelayStatusBlock — schema uniformity across edge and core', () => {
  it('edge and core responses have identical key sets (consumers parse one schema)', () => {
    const edge = buildRelayStatusBlock({
      isCore: false,
      relayStats: null,
      natStatus: 'unknown',
      advertisedAddresses: [],
      configuredAnnounceAddresses: [],
    });
    const core = buildRelayStatusBlock({
      isCore: true,
      relayStats: FULL_STATS,
      natStatus: 'public',
      advertisedAddresses: ['/ip4/203.0.113.5/tcp/4001'],
      configuredAnnounceAddresses: ['/dns4/relay.example.com/tcp/4001'],
    });
    expect(Object.keys(edge).sort()).toEqual(Object.keys(core).sort());
  });
});
