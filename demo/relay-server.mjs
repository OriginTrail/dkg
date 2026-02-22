/**
 * DKG V9 — Relay Server
 *
 * A lightweight relay node that helps agents behind NATs connect to each other.
 * Runs as a full DKG node (DHT, GossipSub, etc.) so it can participate in
 * the network — not just forward bytes.
 *
 * The relay forwards encrypted bytes between peers. It cannot read message
 * content (double-encrypted: libp2p Noise + XChaCha20-Poly1305).
 *
 * Usage:
 *   node demo/relay-server.mjs [port]
 *
 * Deploy on any machine with a public IP (VPS, cloud VM, port-forwarded host).
 * Agents connect to this relay using --relay flag:
 *   node demo/agent-a.mjs --relay /ip4/<PUBLIC_IP>/tcp/<PORT>/p2p/<RELAY_PEER_ID>
 */

import { DKGNode } from '@dkg/core';

const PORT = parseInt(process.argv[2] || '9090', 10);

async function main() {
  console.log('=== DKG Relay Server ===\n');

  const node = new DKGNode({
    listenAddresses: [
      `/ip4/0.0.0.0/tcp/${PORT}`,
      `/ip4/0.0.0.0/tcp/${PORT + 1}/ws`,
    ],
    enableMdns: false,
    enableRelayServer: true,
  });

  await node.start();

  console.log(`Relay PeerId: ${node.peerId}`);
  console.log('Listening on:');
  for (const addr of node.multiaddrs) {
    console.log(`  ${addr}`);
  }

  console.log('\n--- Relay is running ---');
  console.log('Agents can connect using:');
  const tcpAddr = node.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/ws'));
  if (tcpAddr) {
    console.log(`  --relay ${tcpAddr}`);
  }
  console.log('\nThe relay cannot read any message content (encrypted transport).');
  console.log('Press Ctrl+C to stop.\n');

  let connections = 0;
  node.libp2p.addEventListener('peer:connect', () => {
    connections++;
    console.log(`[relay] Peer connected (${connections} active)`);
  });
  node.libp2p.addEventListener('peer:disconnect', () => {
    connections = Math.max(0, connections - 1);
    console.log(`[relay] Peer disconnected (${connections} active)`);
  });

  process.on('SIGINT', async () => {
    console.log('\nShutting down relay...');
    await node.stop();
    process.exit(0);
  });
}

main().catch(err => { console.error(err); process.exit(1); });
