/**
 * MockChainAdapter — Network State Registry surface (RFC 04 v0.3 / Issue #461).
 *
 * Covers the chain-adapter methods edges and core nodes exercise for the
 * on-chain side of the relay-capability flag:
 *  - getRelayCapable(identityId)
 *  - setRelayCapable(relayCapable)
 *
 * Plus the event surface:
 *  - RelayCapabilityUpdated
 *
 * Multiaddrs are NOT stored on Profile (RFC 04 §5.2) — an earlier revision
 * added them, removed in the v0.3 reconciliation patch.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MockChainAdapter } from '../src/mock-adapter.js';

describe('MockChainAdapter — relay registry reads', () => {
  it('returns false for an identity that never opted in', async () => {
    const adapter = new MockChainAdapter();
    expect(await adapter.getRelayCapable(42n)).toBe(false);
  });
});

describe('MockChainAdapter — setRelayCapable', () => {
  let adapter: MockChainAdapter;

  beforeEach(async () => {
    adapter = new MockChainAdapter();
    await adapter.ensureProfile();
  });

  it('flips relayCapable and surfaces it via getRelayCapable', async () => {
    expect(await adapter.getRelayCapable(1n)).toBe(false);
    const tx = await adapter.setRelayCapable!(true);
    expect(tx.success).toBe(true);
    expect(await adapter.getRelayCapable(1n)).toBe(true);
  });

  it('throws when no profile is registered', async () => {
    const fresh = new MockChainAdapter();
    await expect(fresh.setRelayCapable!(true)).rejects.toThrow(/no profile/);
  });
});

describe('MockChainAdapter — relay registry events surface', () => {
  it('emits RelayCapabilityUpdated through listenForEvents', async () => {
    const adapter = new MockChainAdapter();
    await adapter.ensureProfile();

    await adapter.setRelayCapable!(true);

    const events: { type: string; data: Record<string, unknown> }[] = [];
    for await (const e of adapter.listenForEvents({
      eventTypes: ['RelayCapabilityUpdated'],
      fromBlock: 0,
    })) {
      events.push({ type: e.type, data: e.data });
    }

    expect(events).toEqual([
      {
        type: 'RelayCapabilityUpdated',
        data: { identityId: '1', oldValue: false, newValue: true },
      },
    ]);
  });
});
