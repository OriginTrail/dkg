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

  it('applies the preference inside the quorum-satisfied confirmed-core shortcut', () => {
    const out = selectACKCandidatePeers({
      connectedPeers: [STAKED[0], STAKED[1], RELAYS[0], STAKED[2]],
      preferredACKPeerIds: RELAYS,
      knownCorePeerIds: new Set([STAKED[0], STAKED[1], STAKED[2], RELAYS[0]]),
      requiredACKs: 3,
    });
    expect(out).toEqual([RELAYS[0], STAKED[0], STAKED[1], STAKED[2]]);
  });

  it('quorum-satisfied shortcut cannot exclude connected listed relays when the confirmed set is foreign-poisoned', () => {
    // Post-restart identify race: 3 stale foreign-network cores classify
    // first (identify-derived core claims are chain-agnostic), the real
    // relays are connected but not yet classified. The shortcut fires on
    // the foreign trio — it must still include the connected listed relays,
    // or chain verification rejects all 3 ACKs and quorum dies with valid
    // signers connected (the regression PR #1482 originally guarded).
    const foreign = ['testnet-core-1', 'testnet-core-2', 'testnet-core-3'];
    const out = selectACKCandidatePeers({
      connectedPeers: [...foreign, RELAYS[0], RELAYS[1]],
      preferredACKPeerIds: RELAYS,
      knownCorePeerIds: new Set(foreign),
      requiredACKs: 3,
    });
    expect(out).toEqual([...foreign, RELAYS[0], RELAYS[1]]);
  });

  it('quorum-satisfied shortcut keeps unlisted connected peers when using preference-only relays', () => {
    const foreign = ['foreign-1', 'foreign-2', 'foreign-3'];
    const unlisted = 'staked-core-4';
    const out = selectACKCandidatePeers({
      connectedPeers: [...foreign, unlisted],
      preferredACKPeerIds: ['relay-1'],
      knownCorePeerIds: new Set(foreign),
      requiredACKs: 3,
    });
    expect(out).toEqual([...foreign, unlisted]);
  });

  it('V2 rounds: v2-advertised tier first, listed-first within every tier, nobody excluded', () => {
    const out = selectACKCandidatePeers({
      connectedPeers: [...STAKED, RELAYS[0], RELAYS[1], 'edge-x'],
      preferredACKPeerIds: RELAYS,
      knownCorePeerIds: new Set([...STAKED, RELAYS[0], RELAYS[1]]),
      knownCorePeerIdsV2: new Set([STAKED[0], STAKED[1], RELAYS[1]]),
      requiredACKs: 3,
      protocol: PROTOCOL_STORAGE_ACK_V2,
    });
    expect(out).toEqual([
      // v2Advertised: listed first
      RELAYS[1], STAKED[0], STAKED[1],
      // remaining confirmed cores: listed first
      RELAYS[0], STAKED[2],
      // rest
      'edge-x',
    ]);
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
