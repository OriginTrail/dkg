/**
 * DKG V9 — Relay Server
 *
 * A full DKG node that also acts as a circuit relay for NAT-traversal.
 * Participates in DHT, GossipSub, etc. like any other DKG node.
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

import { DKGNode } from '@origintrail-official/dkg-core';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const PORT = parseInt(process.argv[2] || '9090', 10);
const DATA_DIR = process.argv.includes('--data-dir')
  ? process.argv[process.argv.indexOf('--data-dir') + 1]
  : './data/relay';

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function log(...args) {
  console.log(`[${ts()}]`, ...args);
}

function short(peerId) {
  if (peerId.length > 16) return peerId.slice(0, 8) + '...' + peerId.slice(-4);
  return peerId;
}

async function loadOrCreateKey(dir) {
  const keyPath = join(dir, 'relay-key.bin');
  try {
    const data = await readFile(keyPath);
    log(`Identity loaded from ${keyPath}`);
    return new Uint8Array(data);
  } catch {
    const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
    await mkdir(dir, { recursive: true });
    await writeFile(keyPath, key, { mode: 0o600 });
    log(`New identity generated, saved to ${keyPath}`);
    return key;
  }
}

async function main() {
  log('=== DKG Relay Server ===');

  const privateKey = await loadOrCreateKey(DATA_DIR);

  const node = new DKGNode({
    listenAddresses: [
      `/ip4/0.0.0.0/tcp/${PORT}`,
      `/ip4/0.0.0.0/tcp/${PORT + 1}/ws`,
    ],
    enableMdns: false,
    enableRelayServer: true,
    privateKey,
  });

  await node.start();

  log(`Relay PeerId: ${node.peerId}`);
  log('Listening on:');
  for (const addr of node.multiaddrs) {
    log(`  ${addr}`);
  }

  log('--- Relay is running ---');
  log('Agents can connect using:');
  const tcpAddr = node.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/ws'));
  if (tcpAddr) {
    log(`  --relay ${tcpAddr}`);
  }
  log('The relay cannot read any message content (encrypted transport).');
  log('Press Ctrl+C to stop.');

  const libp2p = node.libp2p;
  const connectedPeers = new Map(); // peerId -> { connectedAt, addr, direction }

  libp2p.addEventListener('connection:open', (evt) => {
    const conn = evt.detail;
    const pid = conn.remotePeer.toString();
    connectedPeers.set(pid, {
      connectedAt: new Date(),
      addr: conn.remoteAddr?.toString() ?? 'unknown',
      direction: conn.direction,
    });
    log(`CONNECT   ${short(pid)} (${pid}) dir=${conn.direction} addr=${conn.remoteAddr} — ${connectedPeers.size} peers`);
  });

  libp2p.addEventListener('connection:close', (evt) => {
    const conn = evt.detail;
    const pid = conn.remotePeer.toString();
    const info = connectedPeers.get(pid);
    const durationMs = conn.timeline.close
      ? conn.timeline.close - conn.timeline.open
      : '?';
    connectedPeers.delete(pid);
    log(`DISCONN   ${short(pid)} (${pid}) duration=${durationMs}ms — ${connectedPeers.size} peers`);
  });

  libp2p.addEventListener('connection:prune', (evt) => {
    const pruned = evt.detail;
    log(`PRUNE     ${pruned.length} connection(s) pruned`);
    for (const conn of pruned) {
      log(`  pruned: ${short(conn.remotePeer.toString())} dir=${conn.direction}`);
    }
  });

  // Periodic status report every 60 seconds
  setInterval(() => {
    const count = connectedPeers.size;
    log(`STATUS    ${count} peer(s) connected`);
    if (count > 0) {
      for (const [pid, info] of connectedPeers) {
        const uptime = Math.round((Date.now() - info.connectedAt.getTime()) / 1000);
        log(`  ${short(pid)} (${pid}) dir=${info.direction} uptime=${uptime}s`);
      }
    }
  }, 60_000);

  process.on('SIGINT', async () => {
    log('Shutting down relay...');
    await node.stop();
    process.exit(0);
  });
}

main().catch(err => { console.error(err); process.exit(1); });
