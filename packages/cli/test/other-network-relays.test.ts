import { describe, expect, it } from 'vitest';
import { peerIdFromRelayAddress } from '@origintrail-official/dkg-core';
import {
  loadNetworkConfig,
  resolveNetworkPeerIsolationEnabled,
  resolveOtherNetworkRelays,
  type NetworkConfig,
} from '../src/config.js';

async function bundled(name: string): Promise<NetworkConfig> {
  const network = await loadNetworkConfig(name);
  if (!network) throw new Error(`bundled network config ${name} is missing`);
  return network;
}

function peerIdsOf(addresses: readonly string[]): string[] {
  return addresses.map((address) => peerIdFromRelayAddress(address) ?? `unparseable:${address}`);
}

describe('resolveOtherNetworkRelays (bundled network configs)', () => {
  it('gives a Base-mainnet node every testnet and Gnosis relay, and none of its own', async () => {
    const base = await bundled('mainnet-base');
    const testnet = await bundled('testnet');
    const gnosis = await bundled('mainnet-gnosis');

    const other = resolveOtherNetworkRelays({
      activeNetworkName: 'mainnet-base',
      activeNetwork: base,
      localRelayPeers: base.relays,
    });
    const ids = peerIdsOf(other.relays);

    // The four testnet relays observed being dialed on 2026-09-23.
    expect(ids).toEqual(expect.arrayContaining([
      '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M',
      '12D3KooWAbLiM6Xy2TfXtFpUrXqttnTSuctW8Lo1mkauaijsNrWw',
      '12D3KooWPyTpqBBtU1AvzSsd5rWXCQzFcGtG44qDmeYenWcpzsge',
      '12D3KooWJqhnnfouiNRUyJBEREpuKtV4A448LUbS6JiVCe8Q82bZ',
    ]));
    expect(ids).toEqual(expect.arrayContaining(peerIdsOf(gnosis.relays)));
    expect(ids).toHaveLength(testnet.relays.length + gnosis.relays.length);
    for (const own of peerIdsOf(base.relays)) expect(ids).not.toContain(own);
    // NeuroWeb's pre-deployment PEER_ID_* placeholders are not peer ids.
    expect(other.relays.some((address) => address.includes('PEER_ID_'))).toBe(false);
    expect(other.networkNames).toEqual(['mainnet-gnosis', 'testnet']);
  });

  it('is symmetric: a testnet node refuses the mainnet relays', async () => {
    const testnet = await bundled('testnet');
    const base = await bundled('mainnet-base');
    const gnosis = await bundled('mainnet-gnosis');

    const other = resolveOtherNetworkRelays({
      activeNetworkName: 'testnet',
      activeNetwork: testnet,
      localRelayPeers: testnet.relays,
    });
    const ids = peerIdsOf(other.relays);

    expect(ids).toEqual(expect.arrayContaining([...peerIdsOf(base.relays), ...peerIdsOf(gnosis.relays)]));
    for (const own of peerIdsOf(testnet.relays)) expect(ids).not.toContain(own);
    expect(other.networkNames).toEqual(['mainnet-base', 'mainnet-gnosis']);
  });

  it('holds pairwise across every deployed bundled network', async () => {
    const names = ['mainnet-base', 'mainnet-gnosis', 'testnet'];
    for (const active of names) {
      const network = await bundled(active);
      const ids = peerIdsOf(resolveOtherNetworkRelays({
        activeNetworkName: active,
        activeNetwork: network,
        localRelayPeers: network.relays,
      }).relays);
      for (const other of names.filter((name) => name !== active)) {
        expect(ids).toEqual(expect.arrayContaining(peerIdsOf((await bundled(other)).relays)));
      }
    }
  });
});

describe('resolveOtherNetworkRelays (legitimate exemptions)', () => {
  const ACTIVE = {
    networkId: 'net-a',
    genesisId: 'genesis-a',
    relays: ['/ip4/10.0.0.1/tcp/9090/p2p/12D3KooWFWm8sg6dkitmdBd5Uxaqp3CDRL27mFcM7vEHK92Xapyy'],
  };
  const FOREIGN_RELAY = '/ip4/10.0.0.2/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
  const OPERATOR_RELAY = '/ip4/10.0.0.3/tcp/9090/p2p/12D3KooWAbLiM6Xy2TfXtFpUrXqttnTSuctW8Lo1mkauaijsNrWw';

  it('never lists the operator\'s own relays (config.relay / preferredRelays)', () => {
    const other = resolveOtherNetworkRelays({
      activeNetworkName: 'net-a',
      activeNetwork: ACTIVE,
      localRelayPeers: [OPERATOR_RELAY, ...ACTIVE.relays],
      registry: {
        'net-a': ACTIVE,
        'net-b': { networkId: 'net-b', genesisId: 'genesis-b', relays: [FOREIGN_RELAY, OPERATOR_RELAY] },
      },
    });

    expect(other.relays).toEqual([FOREIGN_RELAY]);
  });

  it('treats a renamed copy of the active network as the active network', () => {
    const other = resolveOtherNetworkRelays({
      activeNetworkName: 'net-a',
      activeNetwork: ACTIVE,
      registry: {
        'net-a-copy': { ...ACTIVE, relays: [FOREIGN_RELAY] },
        'net-a-regenesis': { networkId: 'net-a2', genesisId: 'genesis-a', relays: [OPERATOR_RELAY] },
      },
    });

    expect(other).toEqual({ relays: [], networkNames: [] });
  });

  it('lists nothing without an active network config', () => {
    expect(resolveOtherNetworkRelays({
      activeNetworkName: 'local',
      activeNetwork: null,
      registry: { 'net-b': { networkId: 'net-b', relays: [FOREIGN_RELAY] } },
    })).toEqual({ relays: [], networkNames: [] });
  });
});

describe('resolveNetworkPeerIsolationEnabled (operator kill switch)', () => {
  it('defaults on and follows the config flag', () => {
    expect(resolveNetworkPeerIsolationEnabled(undefined, undefined)).toBe(true);
    expect(resolveNetworkPeerIsolationEnabled(true, undefined)).toBe(true);
    expect(resolveNetworkPeerIsolationEnabled(false, undefined)).toBe(false);
  });

  it('lets the environment override the config in either direction', () => {
    for (const off of ['0', ' FALSE ', 'false']) {
      expect(resolveNetworkPeerIsolationEnabled(true, off)).toBe(false);
    }
    for (const on of ['1', 'true', ' TRUE ']) {
      expect(resolveNetworkPeerIsolationEnabled(false, on)).toBe(true);
    }
  });

  it('fails startup on a value it cannot read instead of guessing', () => {
    // Same token set and empty-value rule as the daemon's other env-overrides-
    // config flags: an empty or unknown value is a loud error, never a default.
    for (const invalid of ['disable', 'off', 'no', 'yes', 'on', '', '   ']) {
      expect(() => resolveNetworkPeerIsolationEnabled(false, invalid)).toThrow(
        `DKG_NETWORK_PEER_ISOLATION_ENABLED must be one of 1, 0, true, or false (received ${JSON.stringify(invalid)})`,
      );
    }
    expect(() => resolveNetworkPeerIsolationEnabled('false', undefined))
      .toThrow('networkPeerIsolationEnabled must be a boolean (received "false")');
  });
});
