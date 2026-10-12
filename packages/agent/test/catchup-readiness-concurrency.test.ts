import { describe, expect, it, vi } from 'vitest';
import { selectSyncCapablePeers } from '../src/p2p/catchup-protocol-readiness.js';

describe('catch-up protocol readiness', () => {
  it('checks independent peers concurrently within the probe limit and retains input order', async () => {
    const peers = Array.from({ length: 6 }, (_, index) => ({ toString: () => `peer-${index}` }));
    const started: string[] = [];
    let active = 0;
    let maximumActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const probe = vi.fn(async (peer: { toString(): string }) => {
        started.push(peer.toString());
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await gate;
        active -= 1;
        return false;
    });

    const pending = selectSyncCapablePeers(peers, 4, probe);
    try {
      await vi.waitFor(() => expect(started).toHaveLength(4));
      expect(started).toEqual(['peer-0', 'peer-1', 'peer-2', 'peer-3']);
      expect(maximumActive).toBe(4);
    } finally {
      release();
    }
    const result = await pending;
    expect(started).toEqual(peers.map((peer) => peer.toString()));
    expect(maximumActive).toBe(4);
    expect(result.syncCapable).toEqual([]);
    expect(result.noProtocolPeers).toBe(6);
  });

  it('preserves candidate order when probes settle out of order', async () => {
    const peers = ['first', 'second', 'third'].map((id) => ({ toString: () => id }));
    const result = await selectSyncCapablePeers(peers, 3, async (peer) => {
      const id = peer.toString();
      await new Promise((resolve) => setTimeout(resolve, id === 'first' ? 20 : 1));
      return id !== 'second';
    });
    expect(result).toEqual({ syncCapable: ['first', 'third'], noProtocolPeers: 1 });
  });
});
