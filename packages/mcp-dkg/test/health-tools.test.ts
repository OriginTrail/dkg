/**
 * Tests for the health-tool surface: `dkg_status`, `dkg_wallet_balances`,
 * and `dkg_peer_info`. The first two are trivial GET wrappers and have
 * lightweight wiring coverage here; `dkg_peer_info` is the substantive
 * surface and gets full assertion coverage including the Window D
 * diagnostic field (`getConnectionsReturnsForPeer`) introduced after
 * the May 2026 soak postmortem.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { registerHealthTools } from '../src/tools/health.js';
import { FakeServer, FakeClient, makeConfig } from './harness.js';

const PEER_A = '12D3KooWFq5KMnSMyYr8Z8t8a6Vh1Y6N6KkF5UZjLpCqUkBJsAaa';

describe('health tools', () => {
  let server: FakeServer;
  let client: FakeClient;

  beforeEach(() => {
    server = new FakeServer();
    client = new FakeClient();
    registerHealthTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
  });

  it('registers dkg_status + dkg_wallet_balances + dkg_peer_info', () => {
    expect(server.tools.has('dkg_status')).toBe(true);
    expect(server.tools.has('dkg_wallet_balances')).toBe(true);
    expect(server.tools.has('dkg_peer_info')).toBe(true);
  });

  describe('dkg_peer_info', () => {
    it('requires peerId in the input schema', async () => {
      // Empty input — zod must reject because `peerId` is required.
      await expect(server.call('dkg_peer_info', {})).rejects.toThrow();
    });

    it('returns JSON dump of the peer info payload on success', async () => {
      client.peerInfoByPeerId.set(PEER_A, {
        peerId: PEER_A,
        connected: true,
        rawConnectionCount: 1,
        getConnectionsReturnsForPeer: 1,
        connections: [
          {
            direction: 'inbound',
            transport: 'direct',
            remoteAddr: '/ip4/1.2.3.4/tcp/4001',
            limited: false,
            streams: 2,
            openedAt: 1715670000000,
          },
        ],
        peerStore: { knownMultiaddrCount: 1, multiaddrs: ['/ip4/1.2.3.4/tcp/4001'], protocols: ['/dkg/10.0.1/sync'] },
        outbox: { pendingCount: 0, oldestFirstFailureAt: null, attempts: [], byProtocol: {} },
        protocols: ['/dkg/10.0.1/sync'],
        syncCapable: true,
        lastSeen: 1715670010000,
        latencyMs: 42,
        health: null,
        connectionCount: 1,
        transports: ['direct'],
        directions: ['inbound'],
        remoteAddrs: ['/ip4/1.2.3.4/tcp/4001'],
      });

      const result = await server.call('dkg_peer_info', { peerId: PEER_A });
      expect(result.isError).toBeFalsy();
      const body = result.content[0].text;
      expect(body).toContain(PEER_A);
      expect(body).toContain('"connected": true');
      expect(body).toContain('"getConnectionsReturnsForPeer": 1');
      // rc.9 PR-E: protocol bump to /dkg/10.0.1/sync.
      expect(body).toContain('/dkg/10.0.1/sync');
    });

    // The Window D bug surface — when the two counts diverge, an
    // operator using `dkg_peer_info` should see the divergence
    // verbatim in the JSON dump so they can identify the pattern
    // without grepping `daemon.log`.
    it('preserves rawConnectionCount vs getConnectionsReturnsForPeer divergence in the rendered output', async () => {
      client.peerInfoByPeerId.set(PEER_A, {
        peerId: PEER_A,
        connected: true,
        rawConnectionCount: 1,
        // libp2p's peerId-keyed lookup returns 0 even though raw walk
        // found a matching connection — Window D signature.
        getConnectionsReturnsForPeer: 0,
        connections: [
          {
            direction: 'inbound',
            transport: 'relayed',
            remoteAddr: `/ip4/9.9.9.9/tcp/4001/p2p-circuit/p2p/${PEER_A}`,
            limited: true,
            streams: 0,
            openedAt: 1715670000000,
          },
        ],
        peerStore: null,
        outbox: {
          pendingCount: 1,
          oldestFirstFailureAt: 1715669999000,
          attempts: [3],
          byProtocol: {
            '/dkg/10.0.1/message': {
              pendingCount: 1,
              oldestFirstFailureAt: 1715669999000,
              attempts: [3],
            },
          },
        },
        protocols: [],
        syncCapable: false,
        lastSeen: null,
        latencyMs: null,
        health: null,
        connectionCount: 1,
        transports: ['relayed'],
        directions: ['inbound'],
        remoteAddrs: [`/ip4/9.9.9.9/tcp/4001/p2p-circuit/p2p/${PEER_A}`],
      });

      const result = await server.call('dkg_peer_info', { peerId: PEER_A });
      expect(result.isError).toBeFalsy();
      const body = result.content[0].text;
      expect(body).toContain('"rawConnectionCount": 1');
      expect(body).toContain('"getConnectionsReturnsForPeer": 0');
      expect(body).toContain('"limited": true');
      expect(body).toContain('"pendingCount": 1');
    });

    it('surfaces client errors as an isError result rather than throwing', async () => {
      const failingClient = new FakeClient({
        getPeerInfo: async () => {
          throw new Error('daemon offline');
        },
      });
      const localServer = new FakeServer();
      registerHealthTools(localServer.asMcpServer(), failingClient.asDkgClient(), makeConfig());
      const result = await localServer.call('dkg_peer_info', { peerId: PEER_A });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Failed to fetch peer info/);
      expect(result.content[0].text).toMatch(/daemon offline/);
    });

    // User review on PR #533: `PeerInfo.remoteAddrs` was typed as
    // `string[]` but the runtime JSON contains `null` entries when
    // libp2p doesn't expose a multiaddr for a given connection.
    // The contract is `Array<string | null>`; surface the null case
    // end-to-end so consumers (incl. the MCP tool serializer) don't
    // crash on a `addr.includes(...)` dereference and so any future
    // tightening of the type back to `string[]` fails this test.
    it('round-trips remoteAddr=null through the MCP tool serializer', async () => {
      const client = new FakeClient({
        getPeerInfo: async () => ({
          peerId: PEER_A,
          connected: true,
          rawConnectionCount: 1,
          getConnectionsReturnsForPeer: 1,
          connections: [
            {
              direction: 'inbound',
              transport: 'direct',
              remoteAddr: null,
              limited: false,
              streams: 0,
              openedAt: 1715670000000,
            },
          ],
          peerStore: null,
          outbox: { pendingCount: 0, oldestFirstFailureAt: null, attempts: [], byProtocol: {} },
          protocols: [],
          syncCapable: false,
          lastSeen: null,
          latencyMs: null,
          health: null,
          connectionCount: 1,
          transports: ['direct'],
          directions: ['inbound'],
          remoteAddrs: [null],
        }),
      });
      const localServer = new FakeServer();
      registerHealthTools(localServer.asMcpServer(), client.asDkgClient(), makeConfig());
      const result = await localServer.call('dkg_peer_info', { peerId: PEER_A });
      expect(result.isError).toBeFalsy();
      const body = result.content[0].text;
      // `null` lands in the serialized JSON for both the rich `connections[]`
      // snapshot AND the legacy flat `remoteAddrs` array — proving the type
      // contract holds end-to-end (FakeClient → tool → JSON.stringify).
      expect(body).toContain('"remoteAddr": null');
      expect(body).toContain('"remoteAddrs": [\n    null\n  ]');
    });
  });
});
