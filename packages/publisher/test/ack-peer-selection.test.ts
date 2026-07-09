// ack-peer-selection.test.ts
//
// 2026-07-07 Base/Gnosis mainnet incident regression: bundled network-config
// relays are a preference list, not an eligibility gate. They must rank first
// without excluding connected, staked, chain-valid cores. The legacy
// `ackCandidatePeerIds` field remains a true caller-supplied allowlist.
import { describe, it, expect } from 'vitest';
import { PROTOCOL_STORAGE_ACK_V2 } from '@origintrail-official/dkg-core';
import { selectACKCandidatePeers } from '../src/ack-peer-selection.js';

const RELAYS = ['relay-1', 'relay-2', 'relay-3', 'relay-4'];
const STAKED = ['staked-core-5', 'staked-core-6', 'staked-core-7'];

describe('selectACKCandidatePeers — allowlist vs preference-only ranking', () => {
  it('keeps ackCandidatePeerIds as a legacy allowlist (unlisted connected peers are excluded)', () => {
    const out = selectACKCandidatePeers({
      connectedPeers: ['trusted-core', 'untrusted-peer'],
      ackCandidatePeerIds: ['trusted-core'],
      knownCorePeerIds: new Set(['trusted-core', 'untrusted-peer']),
      requiredACKs: 3,
    });
    expect(out).toEqual(['trusted-core']);
  });

  it('excludes peers that are not verified for the active network even when preferred or core', () => {
    const foreign = ['foreign-core-1', 'foreign-core-2'];
    const sameNetwork = ['same-network-core', RELAYS[0]];
    const out = selectACKCandidatePeers({
      connectedPeers: [...foreign, ...sameNetwork],
      preferredACKPeerIds: [...foreign, RELAYS[0]],
      verifiedSameNetworkPeerIds: new Set(sameNetwork),
      knownCorePeerIds: new Set([...foreign, ...sameNetwork]),
      requiredACKs: 3,
    });
    expect(out).toEqual([RELAYS[0], 'same-network-core']);
  });

  it('keeps same-network non-relay cores eligible while filtering foreign relays', () => {
    const out = selectACKCandidatePeers({
      connectedPeers: ['foreign-relay', STAKED[0], STAKED[1]],
      preferredACKPeerIds: ['foreign-relay'],
      verifiedSameNetworkPeerIds: new Set([STAKED[0], STAKED[1]]),
      knownCorePeerIds: new Set(['foreign-relay', STAKED[0], STAKED[1]]),
      requiredACKs: 3,
    });
    expect(out).toEqual([STAKED[0], STAKED[1]]);
  });

  it('composes the legacy ACK allowlist with active-network eligibility', () => {
    const out = selectACKCandidatePeers({
      connectedPeers: ['same-network-core', 'foreign-core'],
      ackCandidatePeerIds: ['same-network-core', 'foreign-core'],
      verifiedSameNetworkPeerIds: new Set(['same-network-core']),
      knownCorePeerIds: new Set(['same-network-core', 'foreign-core']),
      requiredACKs: 3,
    });
    expect(out).toEqual(['same-network-core']);
  });

  it('keeps unlisted staked cores in the pool when listed relays cannot reach quorum (incident shape)', () => {
    // Base mainnet 2026-07-07: 4-relay preference list, only 2 connected
    // and healthy; 3 upgraded non-relay cores connected. Old behavior
    // returned [relay-1, relay-2] → 3-ACK quorum arithmetically dead.
    const out = selectACKCandidatePeers({
      connectedPeers: [RELAYS[0], RELAYS[1], ...STAKED],
      preferredACKPeerIds: RELAYS,
      knownCorePeerIds: new Set([RELAYS[0], RELAYS[1], ...STAKED]),
      requiredACKs: 3,
    });
    expect(out).toEqual([RELAYS[0], RELAYS[1], ...STAKED]);
  });

  it('orders listed peers first within each tier (confirmed cores, then rest)', () => {
    const out = selectACKCandidatePeers({
      connectedPeers: ['edge-x', STAKED[0], RELAYS[0], 'edge-y', RELAYS[1]],
      preferredACKPeerIds: RELAYS,
      knownCorePeerIds: new Set([STAKED[0], RELAYS[0]]),
      requiredACKs: 3,
    });
    // confirmed tier: RELAYS[0] (listed) before STAKED[0]; rest tier:
    // RELAYS[1] (listed) before the edges (connection order preserved).
    expect(out).toEqual([RELAYS[0], STAKED[0], RELAYS[1], 'edge-x', 'edge-y']);
  });

  it('applies the preference inside the confirmed-core tier', () => {
    const out = selectACKCandidatePeers({
      connectedPeers: [STAKED[0], STAKED[1], RELAYS[0], STAKED[2]],
      preferredACKPeerIds: RELAYS,
      knownCorePeerIds: new Set([STAKED[0], STAKED[1], STAKED[2], RELAYS[0]]),
      requiredACKs: 3,
    });
    expect(out).toEqual([RELAYS[0], STAKED[0], STAKED[1], STAKED[2]]);
  });

  it('keeps fallback peers when a quorum-sized confirmed tier may be stale or foreign-poisoned', () => {
    const foreign = ['testnet-core-1', 'testnet-core-2', 'testnet-core-3'];
    const out = selectACKCandidatePeers({
      connectedPeers: [...foreign, RELAYS[0], RELAYS[1]],
      preferredACKPeerIds: RELAYS,
      knownCorePeerIds: new Set(foreign),
      requiredACKs: 3,
    });
    expect(out).toEqual([...foreign, RELAYS[0], RELAYS[1]]);
  });

  it('keeps connected fallback peers dialable when a quorum-sized identified tier degrades', () => {
    const identified = ['core-1', 'core-2', 'core-3'];
    const fallback = ['core-4', 'core-5'];
    const out = selectACKCandidatePeers({
      connectedPeers: [...identified, ...fallback],
      preferredACKPeerIds: ['relay-1'],
      knownCorePeerIds: new Set(identified),
      requiredACKs: 3,
    });
    expect(out).toEqual([...identified, ...fallback]);
  });

  it('V2 rounds prefer the advertised tier but keep fallback candidates when it reaches quorum', () => {
    const out = selectACKCandidatePeers({
      connectedPeers: [...STAKED, RELAYS[0], RELAYS[1], 'edge-x'],
      preferredACKPeerIds: RELAYS,
      knownCorePeerIds: new Set([...STAKED, RELAYS[0], RELAYS[1]]),
      knownCorePeerIdsV2: new Set([STAKED[0], STAKED[1], RELAYS[1]]),
      requiredACKs: 3,
      protocol: PROTOCOL_STORAGE_ACK_V2,
    });
    expect(out).toEqual([RELAYS[1], STAKED[0], STAKED[1], RELAYS[0], STAKED[2], 'edge-x']);
  });

  it('V2 rounds include fallback candidates when the advertised tier is below quorum', () => {
    const out = selectACKCandidatePeers({
      connectedPeers: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
      knownCorePeerIds: new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G']),
      knownCorePeerIdsV2: new Set(['A', 'B']),
      requiredACKs: 3,
      protocol: PROTOCOL_STORAGE_ACK_V2,
    });
    expect(out).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
  });

  it('does not cap public fallback candidates at 2x quorum', () => {
    const connected = ['core-1', 'core-2', 'core-3', 'core-4', 'core-5', 'core-6', 'core-7'];
    const out = selectACKCandidatePeers({
      connectedPeers: connected,
      knownCorePeerIds: new Set(['core-1', 'core-2']),
      requiredACKs: 3,
    });
    expect(out).toEqual(connected);
  });

  it('without a separate edge filter, confirmed-core quorum keeps connected fallbacks dialable', () => {
    const out = selectACKCandidatePeers({
      connectedPeers: ['core1', 'core2', 'core3', 'edge1', 'edge2'],
      knownCorePeerIds: new Set(['core1', 'core2', 'core3']),
      requiredACKs: 3,
    });
    expect(out).toEqual(['core1', 'core2', 'core3', 'edge1', 'edge2']);
  });

  it('without a preference list, behavior is unchanged (cores first, everyone dialable)', () => {
    const out = selectACKCandidatePeers({
      connectedPeers: ['edge-x', STAKED[0], STAKED[1]],
      knownCorePeerIds: new Set([STAKED[0], STAKED[1]]),
      requiredACKs: 3,
    });
    expect(out).toEqual([STAKED[0], STAKED[1], 'edge-x']);
  });

  it('still excludes self and ignores blank preference entries', () => {
    const out = selectACKCandidatePeers({
      connectedPeers: ['self', STAKED[0], RELAYS[0]],
      selfPeerId: 'self',
      preferredACKPeerIds: ['  ', '', ` ${RELAYS[0]} `],
      knownCorePeerIds: new Set([STAKED[0], RELAYS[0]]),
      requiredACKs: 3,
    });
    expect(out).toEqual([RELAYS[0], STAKED[0]]);
  });
});
