import { describe, expect, it } from 'vitest';
import { formatAuthorityIndexStartupLine } from '../src/daemon/authority-index-startup-line.js';

// Pure formatter for the `[info] [authority-index]` daemon startup line. The
// wiring test (`daemon-sync-agents-meta-wiring.test.ts`) greps the same shapes
// out of a real daemon.log; this file pins the exact text per bootstrap policy
// so a field rename or reorder is caught without booting a daemon.

const trustedCorePeer = '/dns4/core.example.com/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';

describe('formatAuthorityIndexStartupLine', () => {
  it('keeps the pre-10.0.18 line for an explicit trusted-core config', () => {
    expect(formatAuthorityIndexStartupLine({
      mode: 'core-snapshot',
      trustedCorePeers: [trustedCorePeer, trustedCorePeer.replace('core.', 'core-b.')],
      maxTailBlocks: 500,
      cacheEpoch: 3,
    })).toBe('[info] [authority-index] mode=core-snapshot trustedCoreCount=2 maxTailBlocks=500 cacheEpoch=3');
  });

  it('reports local-history when no index config resolves (cores, or no default)', () => {
    expect(formatAuthorityIndexStartupLine(undefined)).toBe(
      '[info] [authority-index] mode=local-history trustedCoreCount=0 maxTailBlocks=unbounded cacheEpoch=0',
    );
  });

  it('reports the discovery source and fallback for the runtime-discovered edge default', () => {
    expect(formatAuthorityIndexStartupLine({
      mode: 'core-snapshot',
      discovery: 'on-chain-cores',
      trustedCorePeers: [],
      maxTailBlocks: 2_000,
      cacheEpoch: 0,
    })).toBe(
      '[info] [authority-index] mode=core-snapshot trustedCoreCount=discovered '
      + 'discovery=on-chain-cores fallback=local-history maxTailBlocks=2000 cacheEpoch=0',
    );
  });

  it('keys the discovered shape off `discovery`, not off an empty peer list', () => {
    // The resolver rejects an explicit empty list today; this pins that the
    // formatter would still not present such a config as runtime discovery.
    expect(formatAuthorityIndexStartupLine({
      mode: 'core-snapshot',
      trustedCorePeers: [],
      maxTailBlocks: 2_000,
      cacheEpoch: 0,
    })).toBe('[info] [authority-index] mode=core-snapshot trustedCoreCount=0 maxTailBlocks=2000 cacheEpoch=0');
  });
});
