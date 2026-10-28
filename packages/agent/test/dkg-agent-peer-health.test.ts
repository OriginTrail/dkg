import { describe, expect, it, vi } from 'vitest';
import type { DKGNode, Logger } from '@origintrail-official/dkg-core';
import { pingPeers } from '../src/dkg-agent-diagnostics.js';
import type { PeerHealth } from '../src/dkg-agent-types.js';

type StubConnection = { status: string; rtt?: number };

function nodeWith(connections: Record<string, StubConnection[]>) {
  const ping = vi.fn(async () => { throw new Error('peer health must not open its own ping stream'); });
  const peers = Object.keys(connections).map((id) => ({ toString: () => id }));
  const node = {
    libp2p: {
      getPeers: () => peers,
      getConnections: (peer: { toString(): string }) => connections[peer.toString()] ?? [],
      services: { ping: { ping } },
    },
  } as unknown as DKGNode;
  return { node, ping };
}

describe('peer health', () => {
  it("reads liveness and latency from libp2p's connection monitor without pinging", async () => {
    const { node, ping } = nodeWith({
      'peer-two-connections': [{ status: 'open', rtt: 40 }, { status: 'open', rtt: 25 }, { status: 'closed', rtt: 5 }],
      'peer-not-measured-yet': [{ status: 'open' }, { status: 'open', rtt: Number.NaN }],
      'peer-closing': [{ status: 'closing', rtt: 12 }],
    });
    const peerHealth = new Map<string, PeerHealth>([
      ['peer-closing', { peerId: 'peer-closing', alive: true, latencyMs: 12, lastSeen: 1_000, lastChecked: 1_000 }],
    ]);
    const log = { info: vi.fn() } as unknown as Logger;

    expect(await pingPeers({ node, peerHealth, log })).toBe(2);

    expect(ping).not.toHaveBeenCalled();
    expect(peerHealth.get('peer-two-connections')).toMatchObject({ alive: true, latencyMs: 25 });
    expect(peerHealth.get('peer-not-measured-yet')).toMatchObject({ alive: true, latencyMs: null });
    expect(peerHealth.get('peer-closing')).toMatchObject({ alive: false, latencyMs: null, lastSeen: 1_000 });
    expect(peerHealth.get('peer-two-connections')!.lastSeen).toBe(peerHealth.get('peer-two-connections')!.lastChecked);
    expect(log.info).toHaveBeenCalledWith(expect.anything(), 'Peer health ping: 2/3 peers alive');
  });

  it('records a peer that never had an open connection without a last-seen time', async () => {
    const { node } = nodeWith({ 'peer-gone': [] });
    const peerHealth = new Map<string, PeerHealth>();
    expect(await pingPeers({ node, peerHealth, log: { info: vi.fn() } as unknown as Logger })).toBe(0);
    expect(peerHealth.get('peer-gone')).toMatchObject({ alive: false, lastSeen: null });
  });

  it('returns 0 without touching the health map when no peer is connected', async () => {
    const { node } = nodeWith({});
    const peerHealth = new Map<string, PeerHealth>();
    expect(await pingPeers({ node, peerHealth, log: { info: vi.fn() } as unknown as Logger })).toBe(0);
    expect(peerHealth.size).toBe(0);
  });
});
