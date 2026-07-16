import { describe, it, expect } from 'vitest';
import { createCGHostEnumerator } from '../src/swm/enumerate-cg-hosts.js';

describe('createCGHostEnumerator', () => {
  it('returns connected peers minus self', async () => {
    const enumerator = createCGHostEnumerator({
      getConnectedPeers: () => ['peerA', 'peerB', 'selfPeer', 'peerC'],
      getSelfPeerId: () => 'selfPeer',
    });
    expect(await enumerator.enumerate('cg-1')).toEqual(['peerA', 'peerB', 'peerC']);
  });

  it('dedups duplicate peer ids', async () => {
    const enumerator = createCGHostEnumerator({
      getConnectedPeers: () => ['peerA', 'peerA', 'peerB', 'peerB', 'peerA'],
      getSelfPeerId: () => 'selfPeer',
    });
    expect(await enumerator.enumerate('cg-1')).toEqual(['peerA', 'peerB']);
  });

  it('returns empty list when only self is connected', async () => {
    const enumerator = createCGHostEnumerator({
      getConnectedPeers: () => ['selfPeer'],
      getSelfPeerId: () => 'selfPeer',
    });
    expect(await enumerator.enumerate('cg-1')).toEqual([]);
  });

  it('preserves insertion order', async () => {
    const enumerator = createCGHostEnumerator({
      getConnectedPeers: () => ['z', 'a', 'm', 'b'],
      getSelfPeerId: () => 'self',
    });
    expect(await enumerator.enumerate('cg-1')).toEqual(['z', 'a', 'm', 'b']);
  });

  it('cgId argument is currently informational (Phase A returns all hosts uniformly)', async () => {
    const enumerator = createCGHostEnumerator({
      getConnectedPeers: () => ['peerA', 'peerB'],
      getSelfPeerId: () => 'self',
    });
    expect(await enumerator.enumerate('cg-foo')).toEqual(['peerA', 'peerB']);
    expect(await enumerator.enumerate('cg-bar')).toEqual(['peerA', 'peerB']);
  });
});
