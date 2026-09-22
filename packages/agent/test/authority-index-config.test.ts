import { describe, expect, it } from 'vitest';
import {
  resolveAuthorityIndexConfig,
  resolveDefaultAuthorityIndexConfig,
} from '../src/authority-index-config.js';

const PINNED_PEER = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
const pinnedAddress = `/ip4/127.0.0.1/tcp/9200/p2p/${PINNED_PEER}`;

describe('authority index role defaults', () => {
  it('discovers on-chain cores for an edge that configured nothing', () => {
    const resolved = resolveDefaultAuthorityIndexConfig('edge')!;
    expect(resolved).toMatchObject({
      mode: 'core-snapshot',
      trustedCorePeers: [],
      maxTailBlocks: 2_000,
      cacheEpoch: 0,
    });
    expect(resolved.discovery).toBe('on-chain-cores');
    expect(resolved.snapshot).toEqual({ trustedCorePeers: [], maxTailBlocks: 2_000 });
    // Runtime-only metadata never reaches the public wire shape.
    expect(Object.keys(resolved)).toEqual(['mode', 'trustedCorePeers', 'maxTailBlocks', 'cacheEpoch']);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.trustedCorePeers)).toBe(true);
    expect(Object.isFrozen(resolved.snapshot)).toBe(true);
    expect(Object.isFrozen(resolved.snapshot.trustedCorePeers)).toBe(true);
  });

  it('keeps a core on its own chain log', () => {
    expect(resolveDefaultAuthorityIndexConfig('core')).toBeUndefined();
  });

  it('passes the default through agent resolution unchanged while still refusing it on a core', () => {
    const resolved = resolveDefaultAuthorityIndexConfig('edge')!;
    expect(resolveAuthorityIndexConfig(resolved, 'edge')).toBe(resolved);
    expect(() => resolveAuthorityIndexConfig(resolved, 'core')).toThrow('only supported on edge nodes');
  });

  it('never accepts discovery from persisted configuration', () => {
    expect(() => resolveAuthorityIndexConfig({
      mode: 'core-snapshot', discovery: 'on-chain-cores', trustedCorePeers: [pinnedAddress],
    }, 'edge')).toThrow('Unknown authorityIndex option(s): discovery');
    // A serialized default is a runtime decision, not a config.json shape: it
    // carries no discovery key, and what it does carry names no peers, which
    // explicit configuration may not do.
    const persisted = JSON.parse(JSON.stringify(resolveDefaultAuthorityIndexConfig('edge')));
    expect(persisted).toEqual({ mode: 'core-snapshot', trustedCorePeers: [], maxTailBlocks: 2_000, cacheEpoch: 0 });
    expect(() => resolveAuthorityIndexConfig(persisted, 'edge'))
      .toThrow('authorityIndex: Authority index trustedCorePeers must contain at least 1');
  });

  it('scans every input for unknown keys, our own resolved objects included', () => {
    const resolved = resolveDefaultAuthorityIndexConfig('edge')!;
    expect(() => resolveAuthorityIndexConfig({ ...resolved, discovery: 'on-chain-cores' }, 'edge'))
      .toThrow('Unknown authorityIndex option(s): discovery');
    const explicit = resolveAuthorityIndexConfig({ mode: 'core-snapshot', trustedCorePeers: [pinnedAddress] }, 'edge')!;
    expect(() => resolveAuthorityIndexConfig({ ...explicit, unexpected: 1 }, 'edge'))
      .toThrow('Unknown authorityIndex option(s): unexpected');
  });

  it('resolves explicit trust without a discovery mode', () => {
    const explicit = resolveAuthorityIndexConfig({ mode: 'core-snapshot', trustedCorePeers: [pinnedAddress] }, 'edge')!;
    expect(explicit.discovery).toBeUndefined();
    expect('discovery' in explicit).toBe(false);
    expect(explicit.snapshot.trustedCorePeers).toEqual([{ peerId: PINNED_PEER, multiaddr: pinnedAddress }]);
  });
});
