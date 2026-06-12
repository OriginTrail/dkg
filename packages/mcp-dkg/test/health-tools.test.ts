/**
 * Tests for the health-tool surface: `dkg_status`, `dkg_wallet_balances`,
 * and `dkg_peer_info`.
 *
 * NO MOCKS. The retired version fed canned `peerInfoByPeerId` / failing
 * `getPeerInfo` doubles to exercise the JSON serializer. But all three
 * tools are verbatim pass-throughs (`JSON.stringify(await client.get…())`),
 * so the only things worth guarding are: (1) the schema/registration
 * surface, (2) real failure handling, and (3) that the REAL daemon returns
 * the documented diagnostic fields. We prove those here:
 *   • PURE tests (registration, required peerId) — real client, parse-only.
 *   • daemon-offline — a REAL dead-port client (genuine ECONNREFUSED).
 *   • live peer-info / status / wallet — against the real daemon, with a
 *     connected peer discovered dynamically from /api/agents.
 *
 * Edge SHAPES the retired mocks fabricated — the Window-D
 * rawConnectionCount≠getConnectionsReturnsForPeer divergence, remoteAddr
 * =null, a payload missing syncStatus — describe transient/pathological
 * libp2p states a healthy node won't emit on demand. Since the tool dumps
 * the payload verbatim (no field access that could crash), the real
 * contract worth pinning is "the daemon returns these fields", which the
 * live success test asserts. The TS type (PeerInfo) guards the null case
 * at compile time.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { registerHealthTools } from '../src/tools/health.js';
import { FakeServer } from './harness.js';
import { LIVE, API, TOKEN, liveClient, liveConfig } from './live.js';

// A syntactically valid but (almost certainly) unconnected peer id.
const UNKNOWN_PEER = '12D3KooWFq5KMnSMyYr8Z8t8a6Vh1Y6N6KkF5UZjLpCqUkBJsAaa';

describe('health tools — pure surface + real failure handling (no node)', () => {
  let server: FakeServer;

  beforeEach(() => {
    server = new FakeServer();
    registerHealthTools(server.asMcpServer(), liveClient(), liveConfig());
  });

  it('registers dkg_status + dkg_wallet_balances + dkg_peer_info', () => {
    expect(server.tools.has('dkg_status')).toBe(true);
    expect(server.tools.has('dkg_wallet_balances')).toBe(true);
    expect(server.tools.has('dkg_peer_info')).toBe(true);
  });

  it('dkg_peer_info requires peerId in the input schema (parse rejects empty)', () => {
    expect(() => server.parse('dkg_peer_info', {})).toThrow();
  });

  it('dkg_peer_info surfaces client errors as an isError result rather than throwing', async () => {
    // REAL dead-port client → genuine connection refusal → the tool's
    // catch turns it into an isError result. No mock.
    const dead = new FakeServer();
    registerHealthTools(dead.asMcpServer(), liveClient({ api: 'http://127.0.0.1:1' }), liveConfig({ api: 'http://127.0.0.1:1' }));
    const result = await dead.call('dkg_peer_info', { peerId: UNKNOWN_PEER });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Failed to fetch peer info/);
  });

  it('dkg_status surfaces client errors as an isError result', async () => {
    const dead = new FakeServer();
    registerHealthTools(dead.asMcpServer(), liveClient({ api: 'http://127.0.0.1:1' }), liveConfig({ api: 'http://127.0.0.1:1' }));
    const result = await dead.call('dkg_status', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Failed to fetch node status/);
  });
});

describe.skipIf(!LIVE)('health tools — live diagnostics against a real daemon', () => {
  let server: FakeServer;

  beforeEach(() => {
    server = new FakeServer();
    registerHealthTools(server.asMcpServer(), liveClient(), liveConfig());
  });

  async function firstConnectedPeerId(): Promise<string | null> {
    const res = await fetch(`${API}/api/agents`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!res.ok) return null;
    const body = (await res.json()) as { agents?: Array<{ peerId?: string; connectionStatus?: string }> } | Array<{ peerId?: string; connectionStatus?: string }>;
    const agents = Array.isArray(body) ? body : body.agents ?? [];
    const hit = agents.find((a) => a.connectionStatus === 'connected' && a.peerId);
    return hit?.peerId ?? null;
  }

  it('dkg_peer_info returns the documented diagnostic fields for a connected peer', async () => {
    const peerId = await firstConnectedPeerId();
    expect(peerId, 'no connected peer found on the devnet mesh').toBeTruthy();

    const result = await server.call('dkg_peer_info', { peerId: peerId! });
    expect(result.isError).toBeFalsy();
    const body = result.content[0].text;
    expect(body).toContain(peerId!);
    expect(body).toContain('"connected": true');
    // The Window-D divergence diagnostic field MUST be present (real
    // daemon contract — its absence would re-open the May 2026 soak blind
    // spot the field was added to close).
    expect(body).toContain('"getConnectionsReturnsForPeer"');
    expect(body).toContain('"rawConnectionCount"');
    expect(body).toContain('"syncStatus"');
    // Sync runs on a /dkg/.../sync protocol (off the messenger substrate).
    expect(body).toMatch(/\/dkg\/[\d.]+\/sync/);
  });

  it('dkg_peer_info reports connected:false for an unconnected peer (real daemon)', async () => {
    const result = await server.call('dkg_peer_info', { peerId: UNKNOWN_PEER });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('"connected": false');
  });

  it('dkg_status renders this node\'s real status payload', async () => {
    const result = await server.call('dkg_status', {});
    expect(result.isError).toBeFalsy();
    const body = result.content[0].text;
    expect(body).toMatch(/DKG node status/);
    expect(body).toMatch(/"peerId"/);
    expect(body).toMatch(/"connectedPeers"/);
  });

  it('dkg_wallet_balances renders the real wallet probe', async () => {
    const result = await server.call('dkg_wallet_balances', {});
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/Wallet balances/);
    // Either per-wallet rows (with TRAC/ETH) or the explicit empty marker.
    expect(result.content[0].text).toMatch(/TRAC|ETH|no operational wallets/);
  });
});
