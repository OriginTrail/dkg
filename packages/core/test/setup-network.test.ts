import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETUP_NETWORK,
  LEGACY_FALLBACK_NETWORK,
  resolveSetupNetworkName,
} from '../src/setup-network.js';

describe('resolveSetupNetworkName', () => {
  it('defaults a genuinely fresh node to mainnet-gnosis', () => {
    expect(resolveSetupNetworkName({ configExisted: false })).toBe('mainnet-gnosis');
    expect(DEFAULT_SETUP_NETWORK).toBe('mainnet-gnosis');
  });

  it('keeps a legacy node (config exists, no networkConfig) on testnet', () => {
    expect(resolveSetupNetworkName({ configExisted: true })).toBe('testnet');
    expect(LEGACY_FALLBACK_NETWORK).toBe('testnet');
  });

  it('fails SAFE to testnet when configExisted is omitted (only proven-fresh gets mainnet)', () => {
    // A forgotten/ambiguous configExisted must never silently flip a node
    // onto a real-money chain — undefined resolves to the legacy network.
    expect(resolveSetupNetworkName({})).toBe('testnet');
    expect(resolveSetupNetworkName({ existingNetworkConfig: undefined })).toBe('testnet');
  });

  it('keeps an existing explicit networkConfig over the default', () => {
    expect(
      resolveSetupNetworkName({ existingNetworkConfig: 'mainnet-base', configExisted: true }),
    ).toBe('mainnet-base');
    // Even on a "fresh" run, an inherited networkConfig wins over the default.
    expect(
      resolveSetupNetworkName({ existingNetworkConfig: 'mainnet-base', configExisted: false }),
    ).toBe('mainnet-base');
  });

  it('lets an explicit choice win over everything', () => {
    expect(
      resolveSetupNetworkName({
        explicit: 'testnet',
        existingNetworkConfig: 'mainnet-base',
        configExisted: true,
      }),
    ).toBe('testnet');
  });

  it('treats blank/whitespace explicit + existing as absent', () => {
    expect(
      resolveSetupNetworkName({ explicit: '   ', existingNetworkConfig: '  ', configExisted: false }),
    ).toBe('mainnet-gnosis');
    expect(
      resolveSetupNetworkName({ explicit: '', existingNetworkConfig: '', configExisted: true }),
    ).toBe('testnet');
  });

  it('trims a valid explicit value', () => {
    expect(resolveSetupNetworkName({ explicit: '  mainnet-base  ' })).toBe('mainnet-base');
  });
});
