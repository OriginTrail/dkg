import { describe, it, expect } from 'vitest';
import { buildInitChainOverrides } from '../src/init-chain-config.js';
import { resolveChainConfig } from '../src/config.js';

const sameNetwork = { isNetworkSwitch: false };
const defaults = { type: 'evm' as const, rpcUrl: 'https://network.invalid', rpcUrls: ['https://backup.invalid'], hubAddress: '0x1111111111111111111111111111111111111111', chainId: 'base:84532' };
const answers = { ...defaults, rpcUrlsInput: defaults.rpcUrls.join(', ') };
describe('init chain overrides (#1307)', () => {
  it('inherits defaults on new installs and removes previously pinned defaults', () => {
    expect(buildInitChainOverrides(answers, defaults, undefined, sameNetwork)).toBeUndefined();
    expect(buildInitChainOverrides(answers, defaults, defaults, sameNetwork)).toBeUndefined();
  });
  it('persists an operator RPC without pinning the default hub and preserves advanced overrides', () => {
    const chain = buildInitChainOverrides({ ...answers, rpcUrl: 'https://operator.invalid' }, defaults, { tokenAddress: 'custom-token' }, sameNetwork);
    expect(chain).toEqual({ type: 'evm', rpcUrl: 'https://operator.invalid', tokenAddress: 'custom-token' });
    expect(resolveChainConfig({ chain }, { chain: { ...defaults, hubAddress: 'rotated-hub' } })?.hubAddress).toBe('rotated-hub');
  });
  it('preserves explicit backup removal when the network supplies backups', () => {
    expect(buildInitChainOverrides({ ...answers, rpcUrlsInput: 'none' }, defaults, undefined, sameNetwork)).toEqual({ type: 'evm', rpcUrls: [] });
  });
  it('writes full answers when no network defaults exist', () => {
    expect(buildInitChainOverrides(answers, undefined, undefined, sameNetwork)).toEqual(defaults);
  });
  it('preserves backup ordering while inheriting undefined or empty defaults', () => {
    const twoBackups = { ...defaults, rpcUrls: ['https://first.invalid', 'https://second.invalid'] };
    expect(buildInitChainOverrides({ ...answers, rpcUrlsInput: [...twoBackups.rpcUrls].reverse().join(', ') }, twoBackups, undefined, sameNetwork))
      .toEqual({ type: 'evm', rpcUrls: ['https://second.invalid', 'https://first.invalid'] });
    expect(buildInitChainOverrides({ ...answers, rpcUrlsInput: '' }, defaults, defaults, sameNetwork)).toBeUndefined();
    expect(buildInitChainOverrides({ ...answers, rpcUrlsInput: '' }, { ...defaults, rpcUrls: undefined }, defaults, sameNetwork)).toBeUndefined();
  });
  it('removes old prompted values when switching networks and preserves portable tuning', () => {
    const nextNetwork = { ...defaults, rpcUrl: 'https://next.invalid', hubAddress: 'next-hub', chainId: 'base:8453', rpcUrls: [] };
    expect(buildInitChainOverrides({ ...nextNetwork, rpcUrlsInput: '' }, nextNetwork, { ...defaults, cgRegistryScanPageSize: 500 }, { isNetworkSwitch: true }))
      .toEqual({ type: 'evm', cgRegistryScanPageSize: 500 });
  });
  it('treats empty scalar answers as inheritance and persists each custom scalar', () => {
    expect(buildInitChainOverrides({ rpcUrl: '', hubAddress: '', chainId: '', rpcUrlsInput: '' }, defaults, defaults, sameNetwork)).toBeUndefined();
    expect(buildInitChainOverrides({ ...answers, hubAddress: 'operator-hub', chainId: 'operator:1' }, defaults, undefined, sameNetwork))
      .toEqual({ type: 'evm', hubAddress: 'operator-hub', chainId: 'operator:1' });
  });
});
