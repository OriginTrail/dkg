import { describe, it, expect } from 'vitest';
import { buildInitChainOverrides } from '../src/init-chain-config.js';
import { resolveChainConfig } from '../src/config.js';

const defaults = { type: 'evm' as const, rpcUrl: 'https://network.invalid', rpcUrls: ['https://backup.invalid'], hubAddress: '0x1111111111111111111111111111111111111111', chainId: 'base:84532' };
describe('init chain overrides (#1307)', () => {
  it('inherits defaults on new installs and removes previously pinned defaults', () => {
    expect(buildInitChainOverrides(defaults, defaults, undefined)).toBeUndefined();
    expect(buildInitChainOverrides(defaults, defaults, defaults)).toBeUndefined();
  });
  it('persists an operator RPC without pinning the default hub and preserves advanced overrides', () => {
    const chain = buildInitChainOverrides({ ...defaults, rpcUrl: 'https://operator.invalid' }, defaults, { tokenAddress: 'custom-token' });
    expect(chain).toEqual({ type: 'evm', rpcUrl: 'https://operator.invalid', tokenAddress: 'custom-token' });
    expect(resolveChainConfig({ chain }, { chain: { ...defaults, hubAddress: 'rotated-hub' } })?.hubAddress).toBe('rotated-hub');
  });
  it('preserves explicit backup removal when the network supplies backups', () => {
    expect(buildInitChainOverrides({ ...defaults, rpcUrls: [] }, defaults, undefined)).toEqual({ type: 'evm', rpcUrls: [] });
  });
  it('writes full answers when no network defaults exist', () => {
    expect(buildInitChainOverrides(defaults, undefined, undefined)).toEqual(defaults);
  });
  it('preserves backup ordering while inheriting undefined or empty defaults', () => {
    const twoBackups = { ...defaults, rpcUrls: ['https://first.invalid', 'https://second.invalid'] };
    expect(buildInitChainOverrides({ ...twoBackups, rpcUrls: [...twoBackups.rpcUrls].reverse() }, twoBackups, undefined))
      .toEqual({ type: 'evm', rpcUrls: ['https://second.invalid', 'https://first.invalid'] });
    expect(buildInitChainOverrides({ ...defaults, rpcUrls: undefined }, defaults, defaults)).toBeUndefined();
    expect(buildInitChainOverrides({ ...defaults, rpcUrls: [] }, { ...defaults, rpcUrls: undefined }, defaults)).toBeUndefined();
  });
  it('removes old prompted values when switching networks and preserves advanced settings', () => {
    const nextNetwork = { ...defaults, rpcUrl: 'https://next.invalid', hubAddress: 'next-hub', chainId: 'base:8453', rpcUrls: [] };
    expect(buildInitChainOverrides(nextNetwork, nextNetwork, { ...defaults, cgRegistryScanPageSize: 500 }))
      .toEqual({ type: 'evm', cgRegistryScanPageSize: 500 });
  });
  it('treats empty scalar answers as inheritance and persists each custom scalar', () => {
    expect(buildInitChainOverrides({ rpcUrl: '', hubAddress: '', chainId: '', rpcUrls: undefined }, defaults, defaults)).toBeUndefined();
    expect(buildInitChainOverrides({ ...defaults, hubAddress: 'operator-hub', chainId: 'operator:1' }, defaults, undefined))
      .toEqual({ type: 'evm', hubAddress: 'operator-hub', chainId: 'operator:1' });
  });
});
