/**
 * DKG V9 Agent Demo — Agent A (ImageBot + Interactive Chat)
 *
 * Run from repo root:
 *   node demo/agent-a.mjs [port]
 *
 * After Agent B connects, type messages in this terminal to send them.
 * Commands:
 *   /peers           — list connected peers
 *   /agents          — list discovered agents
 *   /skills          — list discovered skill offerings
 *   /quit            — stop the agent
 *   anything else    — send as a chat message to the most recently connected peer
 */

import { DKGAgent } from '@dkg/agent';
import { createInterface } from 'node:readline';

const PORT = parseInt(process.argv[2] || '9100', 10);

async function main() {
  console.log('=== DKG Agent A — ImageBot ===\n');

  const agent = await DKGAgent.create({
    name: 'ImageBot',
    framework: 'OpenClaw',
    description: 'AI agent providing image analysis capabilities',
    listenPort: PORT,
    skills: [
      {
        skillType: 'ImageAnalysis',
        pricePerCall: 0.5,
        currency: 'TRAC',
        handler: async (request, senderPeerId) => {
          const inputText = new TextDecoder().decode(request.inputData);
          console.log(`\n  [SKILL] ImageAnalysis from ${short(senderPeerId)}: "${inputText}"`);
          const result = JSON.stringify({ label: 'cat', confidence: 0.97 });
          prompt();
          return { success: true, outputData: new TextEncoder().encode(result) };
        },
      },
    ],
  });

  // Register chat handler before start
  const connectedPeers = new Set();

  agent.onChat((text, senderPeerId) => {
    console.log(`\n  [${short(senderPeerId)}]: ${text}`);
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

  // Track peers
  agent.node.libp2p.addEventListener('peer:connect', async (evt) => {
    const pid = evt.detail.toString();
    connectedPeers.add(pid);
    console.log(`\n  [+] Peer connected: ${short(pid)}`);

    // Re-broadcast profile after a delay so the new peer's GossipSub is ready
    await new Promise(r => setTimeout(r, 2000));
    try { await agent.publishProfile(); } catch {}
    prompt();
  });

  agent.node.libp2p.addEventListener('peer:disconnect', (evt) => {
    const pid = evt.detail.toString();
    connectedPeers.delete(pid);
    console.log(`\n  [-] Peer disconnected: ${short(pid)}`);
    prompt();
  });

  console.log('--- Waiting for peers. Connect with: ---');
  console.log(`node demo/agent-b.mjs ${addrs.find(a => a.includes('/tcp/'))}\n`);

  // Interactive REPL
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => rl.prompt();
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
      // Send chat to all connected peers
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

function short(peerId) {
  if (peerId.length > 16) return peerId.slice(0, 8) + '...' + peerId.slice(-4);
  return peerId;
}

main().catch(err => { console.error(err); process.exit(1); });
