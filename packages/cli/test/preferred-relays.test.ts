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
  it('uses network relay IDs as ACK allowlist when relays are enabled', () => {
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
  it('filters daemon async ACK fallback to active-network candidates when an allowlist is configured', () => {
    const base = ['base-core-1', 'base-core-2', 'base-core-3', 'base-core-4'];
    const testnet = ['testnet-core-1', 'testnet-core-2', 'testnet-core-3'];

    expect(orderACKCandidatePeerIds({
      connectedPeerIds: ['self', base[2], ...testnet, base[0], base[1], base[3]],
      selfPeerId: 'self',
      knownCorePeerIds: new Set([base[2], testnet[0]]),
      ackCandidatePeerIds: base,
    })).toEqual([base[2], base[0], base[1], base[3]]);
  });

  it('preserves legacy all-connected fallback when no ACK allowlist is configured', () => {
    expect(orderACKCandidatePeerIds({
      connectedPeerIds: ['self', 'edge-1', 'edge-2'],
      selfPeerId: 'self',
      knownCorePeerIds: new Set(),
    })).toEqual(['edge-1', 'edge-2']);
  });
});
