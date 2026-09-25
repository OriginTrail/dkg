import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2,
  PROTOCOL_STORAGE_UPDATE_ACK_V2, PROTOCOL_SYNC,
} from '@origintrail-official/dkg-core';
import { PeerCapabilityRegistry } from '../src/p2p/peer-capability.js';

const CORE = ['core-1', 'core-2'];
const EDGE = ['edge-1'];

describe('PeerCapabilityRegistry evidence', () => {
  it('distinguishes cached identify from authoritative peer updates', () => {
    const registry = new PeerCapabilityRegistry();
    registry.observe(CORE[0], { source: 'negotiation', protocol: PROTOCOL_STORAGE_ACK });
    registry.observe(CORE[0], { source: 'negotiation', protocol: PROTOCOL_STORAGE_ACK_V2 });
    const snapshot = registry.snapshotCorePeerIds();
    registry.observe(CORE[0], { source: 'identify-snapshot', protocols: [PROTOCOL_SYNC] });
    expect(registry.supportsCore(CORE[0])).toBe(true);
    expect(registry.supports(CORE[0], PROTOCOL_STORAGE_ACK_V2)).toBe(true);
    registry.observe(CORE[0], { source: 'peer-update', protocols: [] });
    expect(registry.supportsCore(CORE[0])).toBe(true);
    registry.observe(CORE[0], { source: 'peer-update', protocols: [PROTOCOL_SYNC] });
    expect(registry.supportsCore(CORE[0])).toBe(false);
    expect(registry.supports(CORE[0], PROTOCOL_STORAGE_ACK_V2)).toBe(false);
    registry.observe(CORE[0], {
      source: 'identify-snapshot', protocols: [PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2],
    });
    expect(registry.supportsCore(CORE[0])).toBe(false);
    expect(snapshot.has(CORE[0])).toBe(true);
  });

  it('isolates round evidence from peer updates while committing negotiated cores', () => {
    const registry = new PeerCapabilityRegistry();
    registry.observe(CORE[0], { source: 'peer-update', protocols: [PROTOCOL_STORAGE_ACK] });
    registry.observe(EDGE[0], { source: 'peer-update', protocols: [PROTOCOL_SYNC] });
    expect(registry.supports(EDGE[0], PROTOCOL_SYNC)).toBe(true);
    expect(registry.supportsCore(EDGE[0])).toBe(false);
    const round = registry.beginRound();
    const frozenCorePeers = round.snapshotCorePeerIds();
    registry.observe(CORE[0], { source: 'peer-update', protocols: [PROTOCOL_SYNC] });
    expect(round.supports(CORE[0], PROTOCOL_STORAGE_ACK)).toBe(true);
    expect(frozenCorePeers.has(CORE[0])).toBe(true);
    expect(registry.supportsCore(CORE[0])).toBe(false);

    round.observe(CORE[1], { source: 'negotiation', protocol: PROTOCOL_STORAGE_ACK });
    round.observe(CORE[1], { source: 'negotiation', protocol: PROTOCOL_STORAGE_UPDATE_ACK_V2 });
    expect(round.snapshotProtocolPeers(PROTOCOL_STORAGE_UPDATE_ACK_V2).has(CORE[1])).toBe(true);
    expect(registry.snapshotProtocolPeers(PROTOCOL_STORAGE_UPDATE_ACK_V2).has(CORE[1])).toBe(true);
  });

});
