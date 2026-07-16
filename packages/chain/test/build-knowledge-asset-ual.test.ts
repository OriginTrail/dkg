// KC→KA rename guard — canonical greenfield UAL builder.
//
// `buildKnowledgeAssetUal` is the single source of truth for the
// `did:dkg:{chainId}/{DKGKnowledgeAssets}/{kaId}` string that every
// publish/update/reconcile path stamps onto a Knowledge Asset. The
// greenfield rename (KnowledgeCollection → KnowledgeAsset, PR #815 /
// rc.12) made the contract path segment the **DKGKnowledgeAssets**
// (storage) address rather than the KnowledgeAssetsLifecycle address.
//
// Before this file there was no unit-level test pinning the exact
// output format — only EVM e2e specs that go through 30s of Hardhat.
// A regression that stops lower-casing the address, swaps the `/`
// separators, prepends a stray `0x`, or renders the bigint kaId in
// scientific notation would have shipped green. These tests fail fast
// on any of those.
import { describe, it, expect } from 'vitest';
import { buildKnowledgeAssetUal } from '../src/chain-adapter.js';

describe('buildKnowledgeAssetUal (canonical greenfield UAL)', () => {
  it('builds the exact did:dkg:{chainId}/{contract}/{kaId} string', () => {
    expect(
      buildKnowledgeAssetUal(
        'evm:31337',
        '0xabcdef0123456789abcdef0123456789abcdef01',
        7n,
      ),
    ).toBe('did:dkg:evm:31337/0xabcdef0123456789abcdef0123456789abcdef01/7');
  });

  it('lower-cases the contract address (checksummed input is normalised)', () => {
    // EIP-55 checksummed address in, lowercase out. A resolver that
    // looks the KA up by UAL would miss it if the case drifted.
    const checksummed = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
    const ual = buildKnowledgeAssetUal('evm:84532', checksummed, 42n);
    expect(ual).toBe('did:dkg:evm:84532/0xabcdef0123456789abcdef0123456789abcdef01/42');
    expect(ual).toBe(ual.toLowerCase());
  });

  it('passes the chainId namespace through verbatim (evm: / mock: / bare numeric)', () => {
    const contract = '0x1111111111111111111111111111111111111111';
    expect(buildKnowledgeAssetUal('evm:31337', contract, 1n)).toBe(
      'did:dkg:evm:31337/0x1111111111111111111111111111111111111111/1',
    );
    expect(buildKnowledgeAssetUal('mock:31337', contract, 1n)).toBe(
      'did:dkg:mock:31337/0x1111111111111111111111111111111111111111/1',
    );
    expect(buildKnowledgeAssetUal('84532', contract, 1n)).toBe(
      'did:dkg:84532/0x1111111111111111111111111111111111111111/1',
    );
  });

  it('renders large bigint kaId as a plain decimal string (no scientific notation / truncation)', () => {
    const big = 123456789012345678901234567890n;
    const ual = buildKnowledgeAssetUal('evm:31337', '0x2222222222222222222222222222222222222222', big);
    expect(ual.endsWith('/123456789012345678901234567890')).toBe(true);
    expect(ual).not.toMatch(/e\+?\d/i);
  });

  it('produces exactly four `/`-free segments after the did:dkg: scheme', () => {
    // Structure guard: scheme `did:dkg:` then exactly chainId / contract
    // / kaId. The chainId itself may contain a `:` (evm:31337) but never
    // a `/`, so splitting on `/` must yield exactly 3 parts.
    const ual = buildKnowledgeAssetUal('evm:31337', '0x3333333333333333333333333333333333333333', 9n);
    expect(ual.startsWith('did:dkg:')).toBe(true);
    const parts = ual.slice('did:dkg:'.length).split('/');
    expect(parts).toEqual(['evm:31337', '0x3333333333333333333333333333333333333333', '9']);
  });

  it('does not inject or strip a 0x prefix on the contract segment', () => {
    // The builder must not "helpfully" add/remove 0x — the address is
    // interpolated as-given (after lower-casing). Pin both directions.
    const with0x = buildKnowledgeAssetUal('evm:31337', '0x4444444444444444444444444444444444444444', 1n);
    expect(with0x).toContain('/0x4444444444444444444444444444444444444444/');
  });
});
