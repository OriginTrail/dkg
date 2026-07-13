import { describe, expect, it } from 'vitest';
import {
  buildActiveRelayConnectionGater,
  buildActiveRelayDiscoveryFilter,
  buildActiveRelayNetworkPolicy,
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
