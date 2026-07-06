/**
 * ACK candidate isolation - devnet regression.
 *
 * Preconditions:
 *   pnpm run build
 *   ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
 *
 * This suite is intentionally read-only. It uses the running local devnet's
 * generated edge-node config to get the active core peer IDs, then injects the
 * known public Base testnet relay IDs as stale connected peers. That pins the
 * exact 4 active cores + 3 stale testnet peers pollution shape seen on Base
 * mainnet without mutating the shared devnet.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEVNET_DIR,
  REPO_ROOT,
  detectDevnet,
  fetchRetry,
  type DevnetNode,
  type DevnetState,
} from '../_bootstrap/harness.js';
import {
  extractPeerIdsFromMultiaddrs,
  orderACKCandidatePeerIds,
} from '../../packages/cli/src/daemon/lifecycle.js';

interface RuntimeConfig {
  nodeRole?: string;
  relay?: unknown;
  bootstrapPeers?: unknown;
}

interface StatusResponse {
  peerId?: string;
  nodeRole?: string;
  networkId?: string;
  genesisId?: string;
}

const UNEXPECTED_TESTNET_SUFFIXES = ['aijsNrWw', 'nWcpzsge', 'Ce8Q82bZ'];

let state: DevnetState;
let edge: DevnetNode;
let edgeStatus: StatusResponse;
let edgeConfig: RuntimeConfig;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function loadPublicTestnetPeerIds(): string[] {
  const cfg = readJson<{ relays?: string[] }>(join(REPO_ROOT, 'network/testnet.json'));
  return extractPeerIdsFromMultiaddrs(cfg.relays);
}

function activeDevnetCoreIds(): string[] {
  const ids = extractPeerIdsFromMultiaddrs(stringArray(edgeConfig.bootstrapPeers));
  expect(ids, 'node5 bootstrapPeers should be the four local devnet cores').toHaveLength(4);
  return ids;
}

async function fetchNodeStatus(node: DevnetNode): Promise<StatusResponse> {
  const res = await fetchRetry(`http://127.0.0.1:${node.apiPort}/api/status`);
  if (!res.ok) throw new Error(`node${node.num} /api/status failed: ${res.status}`);
  return (await res.json()) as StatusResponse;
}

beforeAll(async () => {
  const detected = await detectDevnet(6);
  if (!detected) {
    throw new Error('Live 6-node devnet not detected. Run ./scripts/devnet.sh start 6 first.');
  }

  state = detected;
  edge = state.nodes[5]!;
  edgeConfig = readJson<RuntimeConfig>(join(DEVNET_DIR, 'node5', 'config.json'));
  edgeStatus = await fetchNodeStatus(edge);
}, 60_000);

describe('ACK candidate isolation on devnet', () => {
  it('devnet edge bootstraps to local cores, not public testnet relay IDs', () => {
    const bootstrapIds = activeDevnetCoreIds();
    const publicTestnetIds = loadPublicTestnetPeerIds();
    const peerBearingConfiguredAddrs = [
      ...(typeof edgeConfig.relay === 'string' && edgeConfig.relay !== 'none' ? [edgeConfig.relay] : []),
      ...stringArray(edgeConfig.bootstrapPeers),
    ];
    const configuredPeerIds = extractPeerIdsFromMultiaddrs(peerBearingConfiguredAddrs);

    expect(edgeConfig.nodeRole).toBe('edge');
    expect(edgeStatus.nodeRole).toBe('edge');
    expect(edgeStatus.peerId, 'node5 status must expose a peerId').toEqual(expect.any(String));
    expect(bootstrapIds).not.toContain(edgeStatus.peerId);
    expect(configuredPeerIds.filter((id) => publicTestnetIds.includes(id))).toEqual([]);
  });

  it('does not install the default public testnet ACK allowlist in the local devnet relay topology', () => {
    const node1LogPath = join(DEVNET_DIR, 'node1', 'daemon.log');
    const node5LogPath = join(DEVNET_DIR, 'node5', 'daemon.log');
    const node1Config = readJson<RuntimeConfig>(join(DEVNET_DIR, 'node1', 'config.json'));
    expect(existsSync(node1LogPath), 'node1 daemon.log should exist').toBe(true);
    expect(existsSync(node5LogPath), 'node5 daemon.log should exist').toBe(true);
    const node1Log = readFileSync(node1LogPath, 'utf8');
    const node5Log = readFileSync(node5LogPath, 'utf8');

    expect(node1Config.relay).toBe('none');
    expect(typeof edgeConfig.relay).toBe('string');
    expect(edgeConfig.relay).toMatch(/^\/ip4\/127\.0\.0\.1\/tcp\//);
    expect(node1Log).toContain('Relay disabled (config.relay = "none")');
    for (const log of [node1Log, node5Log]) {
      expect(log).not.toMatch(/ACK candidate peer allowlist: .*network config/);
      for (const suffix of UNEXPECTED_TESTNET_SUFFIXES) {
        expect(log).not.toContain(suffix);
      }
    }
  });

  it('filters the 4 devnet cores + 3 stale testnet peers ACK fallback back to devnet cores', () => {
    const devnetCoreIds = activeDevnetCoreIds();
    const publicTestnetIds = loadPublicTestnetPeerIds();
    const staleTestnetIds = UNEXPECTED_TESTNET_SUFFIXES.map((suffix) => {
      const peerId = publicTestnetIds.find((id) => id.endsWith(suffix));
      expect(peerId, `network/testnet.json should still contain ${suffix}`).toBeTruthy();
      return peerId!;
    });
    const selfPeerId = edgeStatus.peerId!;

    const connectedPeerIds = [
      selfPeerId,
      devnetCoreIds[2]!,
      staleTestnetIds[0]!,
      staleTestnetIds[1]!,
      devnetCoreIds[0]!,
      staleTestnetIds[2]!,
      devnetCoreIds[1]!,
      devnetCoreIds[3]!,
    ];

    const nonSelfConnectedPeers = connectedPeerIds.filter((id) => id !== selfPeerId);
    expect(nonSelfConnectedPeers).toHaveLength(7);
    expect(nonSelfConnectedPeers.filter((id) => staleTestnetIds.includes(id))).toHaveLength(3);

    const filtered = orderACKCandidatePeerIds({
      connectedPeerIds,
      selfPeerId,
      knownCorePeerIds: new Set([devnetCoreIds[2]!, staleTestnetIds[0]!]),
      ackCandidatePeerIds: devnetCoreIds,
    });

    expect(filtered).toEqual([
      devnetCoreIds[2],
      devnetCoreIds[0],
      devnetCoreIds[1],
      devnetCoreIds[3],
    ]);
    expect(filtered.filter((id) => staleTestnetIds.includes(id))).toEqual([]);
  });
});
