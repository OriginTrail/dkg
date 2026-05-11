/**
 * V10 invite redemption: DHT-resolved peer dial.
 *
 * The legacy invite carried a hand-picked multiaddr — fragile because it
 * silently breaks whenever the curator's relay rotates or the curator's
 * public IP changes. V10 invites carry only a libp2p peer id; the
 * joiner's daemon resolves the peer's *current* multiaddrs at dial time
 * via libp2p Kademlia (`peerRouting.findPeer`) and then dials them.
 *
 * This test exercises the daemon-facing API surface (`agent.connectToPeerId`)
 * and the failure modes that the daemon route maps to HTTP statuses
 * (PEER_NOT_FOUND -> 404, INVALID_PEER_ID -> 400, SELF_DIAL -> 400).
 *
 * It does NOT validate cross-DHT walk in a multi-hop topology — that
 * requires a wider net of bootstrap peers and is flaky in CI. The
 * single-pair shape here covers the peerStore cache path that
 * `peerRouting.findPeer` falls back to when the DHT walk yields nothing
 * locally, which is the scenario hit on a fresh node that just
 * exchanged identify with the curator.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { DKGAgent } from '../src/index.js';
import { createEVMAdapter, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

describe('DHT-resolved peer dial (V10 invite redemption)', () => {
  let nodeA: DKGAgent | null = null;
  let nodeB: DKGAgent | null = null;

  afterAll(async () => {
    for (const n of [nodeA, nodeB]) {
      try { await n?.stop(); } catch { /* best-effort */ }
    }
  });

  it('connectToPeerId resolves and dials a peer known via peerStore', async () => {
    nodeA = await DKGAgent.create({
      name: 'CuratorA',
      framework: 'DKG',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });
    nodeB = await DKGAgent.create({
      name: 'JoinerB',
      framework: 'DKG',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.REC1_OP),
    });
    await nodeA.start();
    await nodeB.start();

    // Bootstrap: B dials A once via direct multiaddr to seed B's
    // peerStore with A's addresses. In real invite redemption the
    // bootstrap is the libp2p DHT; here it's a single direct dial,
    // which is sufficient to populate `peerRouting.findPeer`'s lookup
    // table.
    const addrA = nodeA.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'));
    expect(addrA).toBeDefined();
    await nodeB.connectTo(addrA!);
    await sleep(500);

    // Sanity: connectToPeerId is idempotent — fast-paths when already connected.
    await nodeB.connectToPeerId(nodeA.peerId);

    // Disconnect, then redial via peer id only — the peer's addresses
    // must be resolved via peerRouting (peerStore-cached) without the
    // caller passing a multiaddr.
    for (const conn of nodeB.node.libp2p.getConnections()) {
      try { await conn.close(); } catch { /* best-effort */ }
    }
    await sleep(200);

    await nodeB.connectToPeerId(nodeA.peerId);

    const reconnected = nodeB.node.libp2p.getConnections().some(
      (c: any) => c.remotePeer.toString() === nodeA!.peerId,
    );
    expect(reconnected).toBe(true);
  }, 30000);

  it('throws INVALID_PEER_ID for malformed input', async () => {
    expect(nodeA).not.toBeNull();
    await expect(nodeA!.connectToPeerId('not-a-peer-id')).rejects.toMatchObject({
      code: 'INVALID_PEER_ID',
    });
  });

  it('throws SELF_DIAL when asked to dial own peer id', async () => {
    expect(nodeA).not.toBeNull();
    await expect(nodeA!.connectToPeerId(nodeA!.peerId)).rejects.toMatchObject({
      code: 'SELF_DIAL',
    });
  });
});
