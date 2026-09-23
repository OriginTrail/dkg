import { describe, expect, it } from 'vitest';
import { formatAuthorityIndexStartupLine } from '../src/daemon/authority-index-startup-line.js';

// Pure formatter for the `[info] [authority-index]` daemon startup line. The
// wiring test (`daemon-sync-agents-meta-wiring.test.ts`) greps the same shapes
// out of a real daemon.log; this file pins the exact text per bootstrap plan
// so a field rename or reorder is caught without booting a daemon.

const trustedCorePeer = '/dns4/core.example.com/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const pinned = {
  mode: 'core-snapshot' as const,
  trustedCorePeers: [trustedCorePeer, trustedCorePeer.replace('core.', 'core-b.')],
  maxTailBlocks: 500,
  cacheEpoch: 3,
};

describe('formatAuthorityIndexStartupLine', () => {
  it('keeps the pre-10.0.18 line for an operator trusted-core block', () => {
    expect(formatAuthorityIndexStartupLine({ source: 'operator', config: pinned }))
      .toBe('[info] [authority-index] mode=core-snapshot trustedCoreCount=2 maxTailBlocks=500 cacheEpoch=3');
  });

  it('keeps the pre-10.0.18 line for local history, whether or not a default was skipped', () => {
    const line = '[info] [authority-index] mode=local-history trustedCoreCount=0 maxTailBlocks=unbounded cacheEpoch=0';
    expect(formatAuthorityIndexStartupLine({ source: 'local-history' })).toBe(line);
    const skipped = { source: 'local-history' as const, skipReason: 'no EVM chain is configured' };
    expect(formatAuthorityIndexStartupLine(skipped)).toBe(line);
  });

  it('reports the trust source and fallback for the network-relay edge default', () => {
    expect(formatAuthorityIndexStartupLine({
      source: 'network-relays',
      config: { ...pinned, maxTailBlocks: 2_000, cacheEpoch: 0 },
    })).toBe(
      '[info] [authority-index] mode=core-snapshot trustedCoreCount=2 '
      + 'source=network-relays fallback=local-history maxTailBlocks=2000 cacheEpoch=0',
    );
  });
});
