import { describe, expect, it } from 'vitest';
import {
  buildActiveRelayConnectionGater,
  buildActiveRelayDiscoveryFilter,
  buildActiveRelayNetworkPolicy,
  buildActiveRelayPathGate,
} from '../src/relay-network-policy.js';

const RELAY_A = '12D3KooWRelayA';
const RELAY_B = '12D3KooWRelayB';
const REMOTE_A = '12D3KooWRemoteA';
const REMOTE_B = '12D3KooWRemoteB';

describe('buildActiveRelayNetworkPolicy', () => {
  it('is disabled when no active relay set is supplied', () => {
    expect(buildActiveRelayNetworkPolicy(undefined)).toBeUndefined();
  });

  it('builds coupled discovery and connection-gater policy for active relays', () => {
    const policy = buildActiveRelayNetworkPolicy(new Set([RELAY_A]));
    expect(policy).toBeDefined();
    expect(policy!.discoveryFilter.has({ toString: () => RELAY_B })).toBe(true);
    expect(
      policy!.connectionGater.denyDialMultiaddr(`/ip4/1.2.3.4/tcp/9090/p2p/${RELAY_B}/p2p-circuit`),
    ).toBe(true);
  });

  it('shares denial-log suppression across the policy path gate and connection gater', () => {
    const logs: string[] = [];
    const policy = buildActiveRelayNetworkPolicy(
      new Set([RELAY_A]),
      message => logs.push(message),
      () => 1_000,
    )!;

    expect(policy.relayPathGate({
      direction: 'outbound',
      relayPeerId: RELAY_B,
      remotePeerId: REMOTE_A,
    })).toBe(true);
    expect(policy.connectionGater.denyDialMultiaddr(
      `/ip4/1.2.3.4/tcp/9090/p2p/${RELAY_B}/p2p-circuit/p2p/${REMOTE_B}`,
    )).toBe(true);
    expect(logs).toHaveLength(1);
  });
});

describe('buildActiveRelayPathGate', () => {
  it('evicts the oldest denial-log key when the bounded cache is full', () => {
    const logs: string[] = [];
    const gate = buildActiveRelayPathGate(
      new Set([RELAY_A]),
      message => logs.push(message),
      () => 1_000,
    );
    const relays = Array.from({ length: 129 }, (_, index) => `12D3KooWForeignRelay${index}`);

    for (const relayPeerId of relays) {
      expect(gate({ direction: 'outbound', relayPeerId })).toBe(true);
    }
    expect(logs).toHaveLength(129);

    // The first key was evicted by the 129th distinct relay, so it logs again
    // inside the interval. The newest retained key remains suppressed.
    expect(gate({ direction: 'outbound', relayPeerId: relays[0] })).toBe(true);
    expect(logs).toHaveLength(130);
    expect(gate({ direction: 'outbound', relayPeerId: relays[128] })).toBe(true);
    expect(logs).toHaveLength(130);
  });
});

describe('buildActiveRelayConnectionGater', () => {
  it('denies circuit-relay paths through relays outside the active network allowlist', () => {
    const gater = buildActiveRelayConnectionGater(new Set([RELAY_A]));

    expect(gater.denyDialMultiaddr(`/ip4/1.2.3.4/tcp/9090/p2p/${RELAY_A}/p2p-circuit/p2p/${REMOTE_A}`)).toBe(false);
    expect(gater.denyDialMultiaddr(`/ip4/1.2.3.4/tcp/9090/p2p/${RELAY_B}/p2p-circuit/p2p/${REMOTE_A}`)).toBe(true);
    expect(gater.denyDialMultiaddr(`/ip4/1.2.3.4/tcp/9090/p2p/${RELAY_B}/p2p-circuit`)).toBe(true);
    expect(gater.denyDialMultiaddr(`/ip4/1.2.3.4/tcp/9090/p2p/${REMOTE_A}`)).toBe(false);

    expect(gater.denyInboundRelayedConnection({ toString: () => RELAY_A }, { toString: () => REMOTE_A })).toBe(false);
    expect(gater.denyInboundRelayedConnection({ toString: () => RELAY_B }, { toString: () => REMOTE_A })).toBe(true);
  });

  it('rate-limits repeated denial logs per direction and foreign relay', () => {
    let now = 1_000;
    const logs: string[] = [];
    const gater = buildActiveRelayConnectionGater(
      new Set([RELAY_A]),
      message => logs.push(message),
      () => now,
    );

    expect(gater.denyDialMultiaddr(`/ip4/1.2.3.4/tcp/9090/p2p/${RELAY_B}/p2p-circuit/p2p/${REMOTE_A}`)).toBe(true);
    expect(gater.denyDialMultiaddr(`/ip4/1.2.3.4/tcp/9090/p2p/${RELAY_B}/p2p-circuit/p2p/${REMOTE_B}`)).toBe(true);
    expect(logs).toHaveLength(1);

    now += 60_000;
    expect(gater.denyDialMultiaddr(`/ip4/1.2.3.4/tcp/9090/p2p/${RELAY_B}/p2p-circuit/p2p/${REMOTE_B}`)).toBe(true);
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain('suppressedSinceLast=1');

    expect(gater.denyInboundRelayedConnection(
      { toString: () => RELAY_B },
      { toString: () => REMOTE_A },
    )).toBe(true);
    expect(logs).toHaveLength(3);
  });
});

describe('buildActiveRelayDiscoveryFilter', () => {
  it('suppresses non-active relay discoveries and still de-duplicates active relays', () => {
    const filter = buildActiveRelayDiscoveryFilter(new Set([RELAY_A]));
    const active = { toString: () => RELAY_A };
    const foreign = { toString: () => RELAY_B };

    expect(filter.has(foreign)).toBe(true);
    expect(filter.has(active)).toBe(false);
    filter.add(active);
    expect(filter.has(active)).toBe(true);
    filter.remove(active);
    expect(filter.has(active)).toBe(false);
  });
});
