// preferred-relays.test.ts
//
// rc.9 PR-7 — unit tests for the operator-preferred-relay merge
// helper. The lifecycle.ts call site is non-trivial to integration
// test (it lives inside `runDaemonInner`'s full daemon boot), so we
// pin the merge contract here.

import { describe, it, expect } from 'vitest';
import {
  extractPeerIdFromMultiaddr,
  extractPeerIdsFromMultiaddrs,
  mergePreferredRelays,
  orderACKCandidatePeerIds,
  resolveACKCandidatePeerIds,
} from '../src/daemon/lifecycle.js';
import { networkRelaysForNode, orderNetworkRelaysForNode } from '../src/daemon/relay-order.js';

const RELAY_PUB_A = '/ip4/10.0.0.1/tcp/4001/p2p/12D3KooWPubA...';
const RELAY_PUB_B = '/ip4/10.0.0.2/tcp/4001/p2p/12D3KooWPubB...';
const RELAY_OP_A = '/ip4/203.0.113.10/tcp/4001/p2p/12D3KooWOpA...';
const RELAY_OP_B = '/dns4/relay.example.com/tcp/4001/p2p/12D3KooWOpB...';

describe('mergePreferredRelays (rc.9 PR-7)', () => {
  it('returns the baseline unchanged when neither env nor config supplies preferreds', () => {
    const result = mergePreferredRelays({
      envValue: undefined,
      configPreferred: undefined,
      networkAndConfigRelays: [RELAY_PUB_A, RELAY_PUB_B],
    });

    expect(result.relayPeers).toEqual([RELAY_PUB_A, RELAY_PUB_B]);
    expect(result.envCount).toBe(0);
    expect(result.configCount).toBe(0);
    expect(result.preferredCount).toBe(0);
  });

  it('prepends env-supplied preferreds before the baseline', () => {
    const result = mergePreferredRelays({
      envValue: RELAY_OP_A,
      configPreferred: undefined,
      networkAndConfigRelays: [RELAY_PUB_A, RELAY_PUB_B],
    });

    expect(result.relayPeers).toEqual([RELAY_OP_A, RELAY_PUB_A, RELAY_PUB_B]);
    expect(result.envCount).toBe(1);
    expect(result.preferredCount).toBe(1);
  });

  it('prepends config-supplied preferreds before the baseline', () => {
    const result = mergePreferredRelays({
      envValue: undefined,
      configPreferred: [RELAY_OP_A, RELAY_OP_B],
      networkAndConfigRelays: [RELAY_PUB_A],
    });

    expect(result.relayPeers).toEqual([RELAY_OP_A, RELAY_OP_B, RELAY_PUB_A]);
    expect(result.configCount).toBe(2);
    expect(result.preferredCount).toBe(2);
  });

  it('env entries take precedence over config entries in declaration order', () => {
    const result = mergePreferredRelays({
      envValue: RELAY_OP_B,
      configPreferred: [RELAY_OP_A],
      networkAndConfigRelays: [RELAY_PUB_A],
    });

    // env first (op-B), then config (op-A), then baseline.
    expect(result.relayPeers).toEqual([RELAY_OP_B, RELAY_OP_A, RELAY_PUB_A]);
    expect(result.envCount).toBe(1);
    expect(result.configCount).toBe(1);
  });

  it('parses the env value as comma-separated list with trimmed entries', () => {
    const result = mergePreferredRelays({
      envValue: `  ${RELAY_OP_A}  ,  ${RELAY_OP_B}  `,
      configPreferred: undefined,
      networkAndConfigRelays: [RELAY_PUB_A],
    });

    expect(result.relayPeers).toEqual([RELAY_OP_A, RELAY_OP_B, RELAY_PUB_A]);
    expect(result.envCount).toBe(2);
  });

  it('drops empty/whitespace-only env entries silently', () => {
    const result = mergePreferredRelays({
      envValue: `,,${RELAY_OP_A},   ,,`,
      configPreferred: undefined,
      networkAndConfigRelays: [],
    });

    expect(result.relayPeers).toEqual([RELAY_OP_A]);
    expect(result.envCount).toBe(1);
  });

  it('dedupes when a preferred multiaddr already appears in the baseline (preferred wins position)', () => {
    const result = mergePreferredRelays({
      envValue: RELAY_PUB_A, // happens to match a baseline entry
      configPreferred: undefined,
      networkAndConfigRelays: [RELAY_PUB_A, RELAY_PUB_B],
    });

    // RELAY_PUB_A appears once, at position 0 (preferred slot).
    expect(result.relayPeers).toEqual([RELAY_PUB_A, RELAY_PUB_B]);
    expect(result.envCount).toBe(1);
    expect(result.preferredCount).toBe(1);
  });

  it('dedupes duplicates WITHIN the preferred list (first wins)', () => {
    const result = mergePreferredRelays({
      envValue: `${RELAY_OP_A},${RELAY_OP_A}`,
      configPreferred: [RELAY_OP_A],
      networkAndConfigRelays: [RELAY_PUB_A],
    });

    expect(result.relayPeers).toEqual([RELAY_OP_A, RELAY_PUB_A]);
    expect(result.envCount).toBe(2); // raw env count BEFORE dedupe
    expect(result.configCount).toBe(1);
    // preferredCount reflects what's in the result, not the raw inputs.
    expect(result.preferredCount).toBe(1);
  });

  it('handles undefined baseline (no relays configured upstream)', () => {
    const result = mergePreferredRelays({
      envValue: RELAY_OP_A,
      configPreferred: undefined,
      networkAndConfigRelays: undefined,
    });

    expect(result.relayPeers).toEqual([RELAY_OP_A]);
  });

  it('filters non-string config entries defensively (config-source guard)', () => {
    const result = mergePreferredRelays({
      envValue: undefined,
      // Simulate a malformed config (number/null bleed through json5 etc.)
      configPreferred: [
        RELAY_OP_A,
        '   ',
        null,
        42,
        RELAY_OP_B,
      ],
      networkAndConfigRelays: [],
    });

    expect(result.relayPeers).toEqual([RELAY_OP_A, RELAY_OP_B]);
    expect(result.configCount).toBe(2);
  });

  it('ignores malformed non-array configPreferred values defensively', () => {
    const result = mergePreferredRelays({
      envValue: undefined,
      configPreferred: { preferredRelays: [RELAY_OP_A] },
      networkAndConfigRelays: [RELAY_PUB_A],
    });

    expect(result.relayPeers).toEqual([RELAY_PUB_A]);
    expect(result.configCount).toBe(0);
    expect(result.preferredCount).toBe(0);
  });
});

describe('ACK peer-id extraction from network relays', () => {
  it('extracts and dedupes relay peer IDs in declaration order', () => {
    expect(extractPeerIdsFromMultiaddrs([
      '/ip4/10.0.0.1/tcp/4001/p2p/12D3KooWBaseA',
      '/dns4/relay.example.com/tcp/9090/ws/p2p/12D3KooWBaseB',
      '/ip4/10.0.0.1/tcp/4001/p2p/12D3KooWBaseA',
      '/ip4/10.0.0.3/tcp/4001',
    ])).toEqual(['12D3KooWBaseA', '12D3KooWBaseB']);
  });

  it('returns the first p2p component for circuit relay addresses', () => {
    expect(
      extractPeerIdFromMultiaddr(
        '/ip4/10.0.0.1/tcp/4001/p2p/12D3KooWRelay/p2p-circuit/p2p/12D3KooWTarget',
      ),
    ).toBe('12D3KooWRelay');
  });
});

describe('resolveACKCandidatePeerIds', () => {
  it('uses network relay IDs as ACK preference list when relays are enabled', () => {
    expect(resolveACKCandidatePeerIds({
      usingNetworkRelays: true,
      networkRelays: [
        '/ip4/10.0.0.1/tcp/4001/p2p/base-core-1',
        '/ip4/10.0.0.2/tcp/4001/p2p/base-core-2',
      ],
    })).toEqual(['base-core-1', 'base-core-2']);
  });

  it('does not inherit public network relays when config.relay disables relays', () => {
    expect(resolveACKCandidatePeerIds({
      usingNetworkRelays: false,
      networkRelays: [
        '/ip4/157.180.37.169/tcp/9090/p2p/12D3KooWAbLiM6Xy2TfXtFpUrXqttnTSuctW8Lo1mkauaijsNrWw',
        '/ip4/178.156.252.147/tcp/9090/p2p/12D3KooWPyTpqBBtU1AvzSsd5rWXCQzFcGtG44qDmeYenWcpzsge',
        '/ip4/49.12.4.64/tcp/9090/p2p/12D3KooWJqhnnfouiNRUyJBEREpuKtV4A448LUbS6JiVCe8Q82bZ',
      ],
    })).toEqual([]);
  });

  it('does not inherit public network relays when config.relay is an explicit local relay', () => {
    expect(resolveACKCandidatePeerIds({
      usingNetworkRelays: false,
      networkRelays: [
        '/ip4/157.180.37.169/tcp/9090/p2p/12D3KooWAbLiM6Xy2TfXtFpUrXqttnTSuctW8Lo1mkauaijsNrWw',
      ],
    })).toEqual([]);
  });
});

describe('orderACKCandidatePeerIds', () => {
  it('orders daemon async ACK candidates preference-first without excluding connected peers (2026-07-07 incident)', () => {
    const base = ['base-core-1', 'base-core-2', 'base-core-3', 'base-core-4'];
    const testnet = ['testnet-core-1', 'testnet-core-2', 'testnet-core-3'];

    // Tiers: confirmed cores (listed first), then the rest (listed first).
    // Foreign-network peers rank last but stay dialable — the hard filter
    // this replaces capped the mainnet pool at the bundled relay list and
    // made ACK quorum unreachable when those relays were degraded.
    expect(orderACKCandidatePeerIds({
      connectedPeerIds: ['self', base[2], ...testnet, base[0], base[1], base[3]],
      selfPeerId: 'self',
      knownCorePeerIds: new Set([base[2], testnet[0]]),
      preferredACKPeerIds: base,
    })).toEqual([
      base[2], testnet[0],
      base[0], base[1], base[3],
      testnet[1], testnet[2],
    ]);
  });

  it('preserves legacy all-connected fallback when no ACK preference list is configured', () => {
    expect(orderACKCandidatePeerIds({
      connectedPeerIds: ['self', 'edge-1', 'edge-2'],
      selfPeerId: 'self',
      knownCorePeerIds: new Set(),
    })).toEqual(['edge-1', 'edge-2']);
  });

  it('filters daemon async ACK candidates to active-network admitted peers when provided', () => {
    const base = ['base-core-1', 'base-core-2'];
    const testnet = ['testnet-core-1', 'testnet-core-2'];

    expect(orderACKCandidatePeerIds({
      connectedPeerIds: ['self', testnet[0], base[0], testnet[1], base[1]],
      selfPeerId: 'self',
      knownCorePeerIds: new Set([...base, ...testnet]),
      preferredACKPeerIds: [testnet[0], base[0]],
      verifiedSameNetworkPeerIds: new Set(base),
    })).toEqual(base);
  });
});

// Synthetic relay peer ids (fixed seeds) on documentation addresses.
const NETWORK_RELAY_PEERS = [
  '12D3KooWCaFu7Rpww4fUfHnEZJCWHZMtWtp1vhpj6srQLQrvgwpc',
  '12D3KooWQD8xYxuQmB3r9xXiN3GV7sQKUyQ1YvjjmexbgmWJKKq4',
  '12D3KooWNhWRxEC5kvZpRVDnoDD3bonXuzTa5dgoPJoDYkdbMimG',
  '12D3KooWEWecLEFycStociTJkkoEmqDyinjxQwcMajaedGPC3rXD',
  '12D3KooWBN7q5cx7M7YbDfnjiF5RQvBRKtGf2oqwdjeyGUoBr9op',
  '12D3KooWHiGDunMUSBgrKdYzAEjvQUvh8sRkbzG3WeYFh1CFsRDq',
];
const NETWORK_RELAYS = NETWORK_RELAY_PEERS.map(
  (peerId, index) => `/ip4/203.0.113.${index + 1}/tcp/9090/p2p/${peerId}`,
);
const FOUR_RELAYS = NETWORK_RELAYS.slice(0, 4);
const nodeKeys = (count: number): string[] =>
  Array.from({ length: count }, (_unused, index) => `0x${(index + 1).toString(16).padStart(40, '0')}`);

describe('orderNetworkRelaysForNode', () => {
  it('returns every relay once, in an order fixed by the node key', () => {
    const key = nodeKeys(1)[0]!;
    const ordered = orderNetworkRelaysForNode(NETWORK_RELAYS, key);

    expect([...ordered].sort()).toEqual([...NETWORK_RELAYS].sort());
    expect(orderNetworkRelaysForNode(NETWORK_RELAYS, key)).toEqual(ordered);
    expect(orderNetworkRelaysForNode([...NETWORK_RELAYS].reverse(), key)).toEqual(ordered);
  });

  it('does not change the list it is given', () => {
    const relays = [...NETWORK_RELAYS];
    orderNetworkRelaysForNode(relays, 'node');
    expect(relays).toEqual(NETWORK_RELAYS);
  });

  it('puts each of four relays among the first three for about three quarters of the nodes', () => {
    const keys = nodeKeys(2_000);
    const firstThree = new Map<string, number>(FOUR_RELAYS.map((relay) => [relay, 0]));
    const first = new Map<string, number>(FOUR_RELAYS.map((relay) => [relay, 0]));
    for (const key of keys) {
      const ordered = orderNetworkRelaysForNode(FOUR_RELAYS, key);
      first.set(ordered[0]!, first.get(ordered[0]!)! + 1);
      for (const relay of ordered.slice(0, 3)) firstThree.set(relay, firstThree.get(relay)! + 1);
    }

    // With one order for every node the shares would be 1, 1, 1 and 0.
    for (const relay of FOUR_RELAYS) {
      expect(firstThree.get(relay)! / keys.length).toBeGreaterThan(0.70);
      expect(firstThree.get(relay)! / keys.length).toBeLessThan(0.80);
      expect(first.get(relay)! / keys.length).toBeGreaterThan(0.20);
      expect(first.get(relay)! / keys.length).toBeLessThan(0.30);
    }
  });

  it('keeps the order of the other relays when the list gains or loses one', () => {
    for (const key of nodeKeys(50)) {
      const five = orderNetworkRelaysForNode(NETWORK_RELAYS.slice(0, 5), key);
      const six = orderNetworkRelaysForNode(NETWORK_RELAYS, key);
      expect(six.filter((relay) => relay !== NETWORK_RELAYS[5])).toEqual(five);
    }
  });

  it('keeps the addresses of one relay together, in file order', () => {
    const tcp = NETWORK_RELAYS[0]!;
    const ws = `/ip4/203.0.113.1/tcp/9091/ws/p2p/${NETWORK_RELAY_PEERS[0]}`;
    for (const key of nodeKeys(20)) {
      const ordered = orderNetworkRelaysForNode([tcp, NETWORK_RELAYS[1]!, ws, NETWORK_RELAYS[2]!], key);
      expect(ordered.indexOf(ws)).toBe(ordered.indexOf(tcp) + 1);
    }
  });

  it('leaves entries without a usable peer id in file order after the rest', () => {
    const placeholderA = '/ip4/203.0.113.20/tcp/9090/p2p/PEER_ID_RELAY_A';
    const placeholderB = '/ip4/203.0.113.21/tcp/9090/p2p/PEER_ID_RELAY_B';
    const ordered = orderNetworkRelaysForNode(
      [placeholderA, ...FOUR_RELAYS, placeholderB, 42 as unknown as string],
      'node',
    );

    expect(ordered.slice(0, 4).sort()).toEqual([...FOUR_RELAYS].sort());
    expect(ordered.slice(4)).toEqual([placeholderA, placeholderB, 42]);
  });
});

describe('networkRelaysForNode', () => {
  const key = nodeKeys(7).at(-1)!;

  it('gives an edge its own order', () => {
    const ordered = networkRelaysForNode({ relays: NETWORK_RELAYS, role: 'edge', nodeKey: key });
    expect(ordered).toEqual(orderNetworkRelaysForNode(NETWORK_RELAYS, key));
    // Not every node key leaves the file order unchanged, and this one does not.
    expect(ordered).not.toEqual(NETWORK_RELAYS);
  });

  it('keeps file order for a Core and for a node without a key', () => {
    expect(networkRelaysForNode({ relays: NETWORK_RELAYS, role: 'core', nodeKey: key }))
      .toEqual(NETWORK_RELAYS);
    expect(networkRelaysForNode({ relays: NETWORK_RELAYS, role: 'edge', nodeKey: undefined }))
      .toEqual(NETWORK_RELAYS);
    expect(networkRelaysForNode({ relays: NETWORK_RELAYS, role: 'edge', nodeKey: '' }))
      .toEqual(NETWORK_RELAYS);
  });

  it('returns a copy, never the network file\'s own array', () => {
    for (const role of ['core', 'edge'] as const) {
      expect(networkRelaysForNode({ relays: NETWORK_RELAYS, role, nodeKey: key })).not.toBe(NETWORK_RELAYS);
    }
  });

  it('leaves operator-preferred relays ahead of the ordered network relays', () => {
    const preferred = '/ip4/198.51.100.7/tcp/9090/p2p/12D3KooWLa2BakyRVLJcAwgTbg6ibNZZMzccEkPiVFq5XiE867wN';
    const ordered = networkRelaysForNode({ relays: NETWORK_RELAYS, role: 'edge', nodeKey: key });
    const merged = mergePreferredRelays({
      envValue: undefined,
      configPreferred: [preferred, ordered[2]!],
      networkAndConfigRelays: ordered,
    });

    expect(merged.relayPeers).toEqual([preferred, ordered[2], ...ordered.filter((relay) => relay !== ordered[2])]);
  });
});
