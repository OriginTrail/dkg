import { describe, it, expect } from 'vitest';
import { orderCatchupPeers } from '../src/p2p/peer-selection.js';

/**
 * Unit tests for `orderCatchupPeers` — the tiered catch-up peer ordering
 * (preferred curator → known Core nodes → everyone else).
 *
 * Strings are valid `{ toString() }` peers, so we use plain ids.
 */
describe('orderCatchupPeers', () => {
  it('returns peers unchanged when there is no preferred peer and no cores', () => {
    const peers = ['a', 'b', 'c'];
    expect(orderCatchupPeers(peers)).toBe(peers);
    expect(orderCatchupPeers(peers, undefined, false, new Set())).toBe(peers);
  });

  it('puts the preferred peer first, preserving the order of the rest', () => {
    const peers = ['a', 'b', 'c', 'd'];
    expect(orderCatchupPeers(peers, 'c')).toEqual(['c', 'a', 'b', 'd']);
  });

  it('orders known cores ahead of non-cores (stable within tier)', () => {
    const peers = ['edge1', 'core1', 'edge2', 'core2'];
    const cores = new Set(['core1', 'core2']);
    expect(orderCatchupPeers(peers, undefined, false, cores)).toEqual([
      'core1',
      'core2',
      'edge1',
      'edge2',
    ]);
  });

  it('ranks preferred first, then cores, then others', () => {
    const peers = ['edge1', 'core1', 'curator', 'edge2', 'core2'];
    const cores = new Set(['core1', 'core2']);
    expect(orderCatchupPeers(peers, 'curator', false, cores)).toEqual([
      'curator',
      'core1',
      'core2',
      'edge1',
      'edge2',
    ]);
  });

  it('keeps the preferred peer first even if it is also a core', () => {
    const peers = ['edge1', 'core1', 'core2'];
    const cores = new Set(['core1', 'core2']);
    expect(orderCatchupPeers(peers, 'core2', false, cores)).toEqual([
      'core2',
      'core1',
      'edge1',
    ]);
  });

  it('is backward compatible: privateOnly does not change ordering output', () => {
    const peers = ['a', 'b', 'c'];
    expect(orderCatchupPeers(peers, 'b', true)).toEqual(['b', 'a', 'c']);
    expect(orderCatchupPeers(peers, 'b', false)).toEqual(['b', 'a', 'c']);
  });
});
