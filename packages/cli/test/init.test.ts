import { describe, it, expect } from 'vitest';
import { resolveSetupNetworkName } from '@origintrail-official/dkg-core';
import { buildInitAutoUpdate, isInitNetworkSwitch } from '../src/commands/init.js';
import {
  loadNetworkConfig,
  resolveChainConfig,
  resolveKnownNetworkConfigName,
  resolveNetworkConfigName,
} from '../src/config.js';

// Guards the network-SWITCH decision that drives whether `dkg init` discards
// the existing chain block (new-network/old-chain Frankenstein prevention) or
// preserves it (operator RPC override). The prior effective network may be
// explicit or inferred from a legacy chain ID.
describe('isInitNetworkSwitch', () => {
  it('is NOT a switch for a fresh node (no networkConfig)', () => {
    expect(isInitNetworkSwitch(undefined, 'mainnet-gnosis')).toBe(false);
    expect(isInitNetworkSwitch('', 'mainnet-base')).toBe(false);
    expect(isInitNetworkSwitch('   ', 'testnet')).toBe(false);
  });

  it('is NOT a switch when the selected network equals the persisted one (preserve overrides)', () => {
    expect(isInitNetworkSwitch('mainnet-base', 'mainnet-base')).toBe(false);
    expect(isInitNetworkSwitch('  mainnet-base  ', 'mainnet-base')).toBe(false);
  });

  it('IS a switch when the effective prior network differs from the selection', () => {
    expect(isInitNetworkSwitch('mainnet-base', 'testnet')).toBe(true);
    expect(isInitNetworkSwitch('testnet', 'mainnet-gnosis')).toBe(true);
  });

  it('does not treat the fallback as switch evidence for an unknown legacy chain', async () => {
    const existing = {
      chain: {
        type: 'evm' as const,
        chainId: 'evm:100',
        rpcUrl: 'https://operator-rpc.invalid',
        hubAddress: '0x0000000000000000000000000000000000000042',
      },
    };
    const knownExistingNetwork = resolveKnownNetworkConfigName(existing);
    const selectedNetwork = 'mainnet-gnosis';
    const network = await loadNetworkConfig(selectedNetwork);
    const switching = isInitNetworkSwitch(knownExistingNetwork, selectedNetwork);
    const persistedChain = resolveChainConfig(switching ? undefined : existing, network);

    expect(knownExistingNetwork).toBeUndefined();
    expect(switching).toBe(false);
    expect(persistedChain?.chainId).toBe('evm:100');
    expect(persistedChain?.rpcUrl).toBe('https://operator-rpc.invalid');
    expect(persistedChain?.hubAddress).toBe('0x0000000000000000000000000000000000000042');
  });

  it('keeps legacy Base/Gnosis setup defaults and persisted chain fields consistent', async () => {
    for (const [chainId, expectedNetwork] of [
      ['base:8453', 'mainnet-base'],
      ['gnosis:100', 'mainnet-gnosis'],
    ] as const) {
      const existing = {
        chain: {
          type: 'evm' as const,
          chainId,
          rpcUrl: `https://operator-${expectedNetwork}.invalid`,
          hubAddress: '0x0000000000000000000000000000000000000042',
        },
      };
      const existingNetwork = resolveNetworkConfigName(existing);
      const selectedNetwork = resolveSetupNetworkName({
        existingNetworkConfig: existingNetwork,
        configExisted: true,
      });
      const network = await loadNetworkConfig(selectedNetwork);
      const switching = isInitNetworkSwitch(existingNetwork, selectedNetwork);
      const persisted = {
        ...existing,
        networkConfig: selectedNetwork,
        chain: resolveChainConfig(switching ? undefined : existing, network),
      };

      expect(persisted.networkConfig).toBe(expectedNetwork);
      expect(persisted.chain?.chainId).toBe(chainId);
      expect(persisted.chain?.rpcUrl).toBe(`https://operator-${expectedNetwork}.invalid`);
      expect(switching).toBe(false);
    }
  });
});

// Guards the `dkg init` auto-update persistence decision. Both the decline
// path (PR #1295 round 3: must persist { enabled: false }, not fall through to
// the enabled network default) and channel/advanced-field preservation across
// reruns (round 1) have regressed before — these pin the behavior.
describe('buildInitAutoUpdate', () => {
  const proj = { projRepo: 'OriginTrail/dkg', projDefaultBranch: 'main' };
  const net = {
    repo: 'OriginTrail/dkg',
    branch: 'main',
    allowPrerelease: true,
    checkIntervalMinutes: 5,
  };

  it('decline on a fresh config persists { enabled: false } (so the daemon does NOT re-enable via the network default)', () => {
    const r = buildInitAutoUpdate({
      enableAutoUpdate: false,
      existingAutoUpdate: undefined,
      networkAutoUpdate: net,
      ...proj,
    });
    expect(r).toEqual({ enabled: false });
  });

  it('decline disables but preserves existing advanced fields (channel, intervals)', () => {
    const r = buildInitAutoUpdate({
      enableAutoUpdate: false,
      existingAutoUpdate: { enabled: true, channel: 'staging', checkIntervalMinutes: 10 },
      networkAutoUpdate: net,
      ...proj,
    });
    expect(r.enabled).toBe(false);
    expect(r.channel).toBe('staging');
    expect(r.checkIntervalMinutes).toBe(10);
  });

  it('enable preserves an explicit updateJitterMinutes override across reruns (incl. 0 = disabled)', () => {
    const r = buildInitAutoUpdate({
      enableAutoUpdate: true,
      // Operator disabled rollout jitter on this node; a rerun must not drop it.
      existingAutoUpdate: { enabled: true, source: 'npm', updateJitterMinutes: 0 },
      networkAutoUpdate: net,
      ...proj,
      answers: { allowPrerelease: true, interval: 5 },
    });
    expect(r.updateJitterMinutes).toBe(0);
  });

  it('enable preserves npm fields but drops git-only fields when forcing npm mode', () => {
    const r = buildInitAutoUpdate({
      enableAutoUpdate: true,
      existingAutoUpdate: {
        enabled: true,
        source: 'git',
        channel: 'staging',
        repo: 'https://github.com/OriginTrail/dkg.git',
        branch: 'canary',
        ref: 'refs/heads/canary',
        sshKeyPath: '/tmp/git-key',
        sshCommand: 'ssh -i /tmp/git-key',
        buildTimeoutMs: { install: 600_000 },
      },
      networkAutoUpdate: net,
      ...proj,
      answers: { allowPrerelease: true, interval: 5 },
    });
    expect(r.enabled).toBe(true);
    expect(r.source).toBe('npm');
    expect(r.channel).toBe('staging');
    expect(r.repo).toBeUndefined();
    expect(r.branch).toBeUndefined();
    expect(r.ref).toBeUndefined();
    expect(r.sshKeyPath).toBeUndefined();
    expect(r.sshCommand).toBeUndefined();
    expect(r.buildTimeoutMs).toBeUndefined();
  });

  it('enable persists only fields that differ from the network/project defaults', () => {
    const r = buildInitAutoUpdate({
      enableAutoUpdate: true,
      existingAutoUpdate: undefined,
      networkAutoUpdate: net,
      ...proj,
      // Every answer equals the effective default → nothing extra is pinned.
      answers: { allowPrerelease: true, interval: 5 },
    });
    expect(r).toEqual({ enabled: true, source: 'npm' });
  });

  it('enable persists a field that DOES differ from the default (e.g. allowPrerelease)', () => {
    const r = buildInitAutoUpdate({
      enableAutoUpdate: true,
      existingAutoUpdate: undefined,
      networkAutoUpdate: net, // allowPrerelease default = true
      ...proj,
      answers: { allowPrerelease: false, interval: 5 },
    });
    expect(r).toEqual({ enabled: true, source: 'npm', allowPrerelease: false });
  });
});
