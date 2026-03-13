/**
 * DKG V9 Agent Demo — Agent A (ImageBot + Interactive Chat)
 *
 * Run from repo root:
 *   node demo/agent-a.mjs [port] [--relay <multiaddr>]
 *
 * Examples:
 *   node demo/agent-a.mjs 9100
 *   node demo/agent-a.mjs 9100 --relay /ip4/1.2.3.4/tcp/9090/p2p/16Uiu2HAm...
 *   node demo/agent-a.mjs --relay /ip4/1.2.3.4/tcp/9090/p2p/16Uiu2HAm...
 *
 * After Agent B connects, type messages in this terminal to send them.
 * Commands:
 *   /peers           — list connected peers
 *   /agents          — list discovered agents
 *   /skills          — list discovered skill offerings
 *   /quit            — stop the agent
 *   anything else    — send as a chat message to all connected peers
 */

import { DKGAgent } from '@origintrail-official/dkg-agent';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const relayIdx = args.indexOf('--relay');
const relayPeers = [];
if (relayIdx !== -1 && args[relayIdx + 1]) {
  relayPeers.push(args[relayIdx + 1]);
  args.splice(relayIdx, 2);
}
const dataDirIdx = args.indexOf('--data-dir');
let dataDir = null;
if (dataDirIdx !== -1 && args[dataDirIdx + 1]) {
  dataDir = args[dataDirIdx + 1];
  args.splice(dataDirIdx, 2);
}
const PORT = parseInt(args[0] || '9100', 10);
if (!dataDir) dataDir = `.dkg/agent-a`;

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function short(peerId) {
  if (peerId.length > 16) return peerId.slice(0, 8) + '...' + peerId.slice(-4);
  return peerId;
}

async function main() {
  console.log('=== DKG Agent A — ImageBot ===\n');

  const agent = await DKGAgent.create({
    name: 'ImageBot',
    framework: 'OpenClaw',
    description: 'AI agent providing image analysis capabilities',
    listenPort: PORT,
    dataDir,
    relayPeers: relayPeers.length ? relayPeers : undefined,
    skills: [
      {
        skillType: 'ImageAnalysis',
        pricePerCall: 0.5,
        currency: 'TRAC',
        handler: async (request, senderPeerId) => {
          const inputText = new TextDecoder().decode(request.inputData);
          console.log(`\n  [${ts()}] [SKILL] ImageAnalysis from ${short(senderPeerId)}: "${inputText}"`);
          const result = JSON.stringify({ label: 'cat', confidence: 0.97 });
          prompt();
          return { success: true, outputData: new TextEncoder().encode(result) };
        },
      },
    ],
  });

  const connectedPeers = new Set();
  let prompt = () => {};

  agent.onChat((text, senderPeerId) => {
    console.log(`\n  [${ts()}] [${short(senderPeerId)}]: ${text}`);
    prompt();
  });

  await agent.start();

  const addrs = agent.multiaddrs;
  console.log(`PeerId: ${agent.peerId}`);
  console.log(`Listening on:`);
  for (const a of addrs) console.log(`  ${a}`);

  console.log('\nPublishing profile...');
  await agent.publishProfile();
  console.log('Profile published.\n');

  // Track peers with detailed logging
  agent.node.libp2p.addEventListener('peer:connect', async (evt) => {
    const pid = evt.detail.toString();
    connectedPeers.add(pid);
    console.log(`\n  [${ts()}] [+] Peer connected: ${short(pid)} (${pid})`);

    await new Promise(r => setTimeout(r, 2000));
    try { await agent.publishProfile(); } catch {}
    prompt();
  });

  agent.node.libp2p.addEventListener('peer:disconnect', (evt) => {
    const pid = evt.detail.toString();
    connectedPeers.delete(pid);
    console.log(`\n  [${ts()}] [-] Peer disconnected: ${short(pid)} (${pid})`);
    prompt();
  });

  if (relayPeers.length) {
    console.log(`Relay: ${relayPeers[0]}`);
    let gotCircuit = false;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const circuitAddrs = agent.multiaddrs.filter(a => a.includes('/p2p-circuit/'));
      if (circuitAddrs.length) {
        gotCircuit = true;
        const publicCircuit = circuitAddrs.find(a => !a.includes('/127.0.0.1/') && !a.includes('/10.') && !a.includes('/192.168.'));
        console.log(`\n  [${ts()}] Circuit reservation granted (${circuitAddrs.length} addresses)`);
        if (publicCircuit) {
          console.log(`  Public circuit: ${publicCircuit}`);
        }
        break;
      }
      if (i < 9) process.stdout.write('.');
      else console.log(`\n  [${ts()}] WARNING: no circuit addresses — relay may not have granted a reservation`);
    }
  }

  console.log('\n--- Waiting for peers ---');
  if (relayPeers.length) {
    console.log('Your friend can connect with:');
    console.log(`  node demo/agent-b.mjs --relay ${relayPeers[0]} --peer ${agent.peerId}\n`);
  } else {
    console.log('Direct connect (same LAN):');
    console.log(`  node demo/agent-b.mjs ${addrs.find(a => a.includes('/tcp/'))}\n`);
  }

  // Interactive REPL
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  prompt = () => rl.prompt();
  rl.setPrompt('ImageBot> ');
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { prompt(); return; }

    if (input === '/peers') {
      console.log(`Connected peers (${connectedPeers.size}):`);
      for (const p of connectedPeers) console.log(`  ${p}`);
    } else if (input === '/agents') {
      const agents = await agent.findAgents();
      console.log(`Discovered agents (${agents.length}):`);
      for (const a of agents) console.log(`  ${a.name} [${a.framework ?? '?'}] — ${short(a.peerId)}`);
    } else if (input === '/skills') {
      const offerings = await agent.findSkills();
      if (offerings.length === 0) console.log('No skill offerings found.');
      else for (const o of offerings) console.log(`  ${o.agentName}: ${o.skillType} @ ${o.pricePerCall ?? 'free'} ${o.currency ?? 'TRAC'}`);
    } else if (input === '/quit') {
      console.log('Stopping...');
      await agent.stop();
      process.exit(0);
    } else {
      if (connectedPeers.size === 0) {
        console.log('  (no peers connected)');
      } else {
        for (const pid of connectedPeers) {
          const result = await agent.sendChat(pid, input);
          if (!result.delivered) {
            console.log(`  [!] Failed to send to ${short(pid)}: ${result.error}`);
          }
        }
      }
    }
    prompt();
  });

  rl.on('close', async () => {
    console.log('\nStopping...');
    await agent.stop();
    process.exit(0);
  });
}

main().catch(err => { console.error(err); process.exit(1); });
