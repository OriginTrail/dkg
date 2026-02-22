/**
 * DKG V9 Agent Demo — Agent B (TextBot + Interactive Chat)
 *
 * Run from repo root:
 *   node demo/agent-b.mjs <agent-a-multiaddr>
 *   node demo/agent-b.mjs --relay /ip4/<RELAY_IP>/tcp/9090/p2p/<RELAY_ID> --peer <AGENT_A_PEER_ID>
 *
 * When using --relay + --peer, Agent B dials Agent A through the relay circuit.
 * Agent A prints the exact command to run.
 *
 * Commands:
 *   /peers           — list connected peers
 *   /agents          — list discovered agents
 *   /skills          — list discovered skill offerings
 *   /invoke <text>   — invoke Agent A's ImageAnalysis skill with <text>
 *   /quit            — stop the agent
 *   anything else    — send as a chat message to all connected peers
 */

import { DKGAgent } from '@dkg/agent';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const relayIdx = args.indexOf('--relay');
const relayPeers = [];
if (relayIdx !== -1 && args[relayIdx + 1]) {
  relayPeers.push(args[relayIdx + 1]);
  args.splice(relayIdx, 2);
}
const peerIdx = args.indexOf('--peer');
let targetPeerId = null;
if (peerIdx !== -1 && args[peerIdx + 1]) {
  targetPeerId = args[peerIdx + 1];
  args.splice(peerIdx, 2);
}
const AGENT_A_ADDR = args[0]; // optional when using relay
if (!AGENT_A_ADDR && !relayPeers.length) {
  console.error('Usage: node demo/agent-b.mjs <agent-a-multiaddr>');
  console.error('   or: node demo/agent-b.mjs --relay <relay-multiaddr> --peer <agent-a-peer-id>');
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('=== DKG Agent B — TextBot ===\n');

  const agent = await DKGAgent.create({
    name: 'TextBot',
    framework: 'ElizaOS',
    description: 'AI agent providing text analysis capabilities',
    listenPort: 0,
    relayPeers: relayPeers.length ? relayPeers : undefined,
    skills: [
      {
        skillType: 'TextAnalysis',
        pricePerCall: 0.1,
        currency: 'TRAC',
        handler: async (request) => {
          const text = new TextDecoder().decode(request.inputData);
          return {
            success: true,
            outputData: new TextEncoder().encode(JSON.stringify({
              sentiment: 'positive', wordCount: text.split(' ').length,
            })),
          };
        },
      },
    ],
  });

  const connectedPeers = new Set();
  let prompt = () => {};

  agent.onChat((text, senderPeerId) => {
    console.log(`\n  [${short(senderPeerId)}]: ${text}`);
    prompt();
  });

  await agent.start();
  console.log(`PeerId: ${short(agent.peerId)}`);

  // Publish profile
  console.log('Publishing profile...');
  await agent.publishProfile();

  // Subscribe to paranets
  agent.subscribeToParanet('agent-skills');

  let agentAPeerId = null;

  if (AGENT_A_ADDR) {
    // Direct connection to Agent A
    console.log(`Connecting to ${AGENT_A_ADDR.slice(0, 50)}...`);
    await agent.connectTo(AGENT_A_ADDR);
    agentAPeerId = AGENT_A_ADDR.split('/p2p/').pop();
    if (agentAPeerId) connectedPeers.add(agentAPeerId);
    console.log('Connected!\n');
  } else if (relayPeers.length) {
    console.log('Connected to relay.');
    await sleep(1000);

    if (targetPeerId) {
      // Dial Agent A through the relay circuit
      const circuitAddr = `${relayPeers[0]}/p2p-circuit/p2p/${targetPeerId}`;
      console.log(`Dialing ${short(targetPeerId)} via relay circuit...`);
      try {
        await agent.connectTo(circuitAddr);
        agentAPeerId = targetPeerId;
        connectedPeers.add(targetPeerId);
        console.log('Connected through relay!\n');
      } catch (err) {
        console.log(`Failed to reach peer via relay: ${err.message}`);
        console.log('Will wait for DHT discovery...\n');
      }
    } else {
      console.log('No --peer specified. Waiting for peers to connect...');
      console.log('Tip: use --peer <AGENT_A_PEER_ID> to dial through the relay.\n');
      await sleep(2000);
    }
  }

  // Track peers
  agent.node.libp2p.addEventListener('peer:connect', (evt) => {
    const pid = evt.detail.toString();
    connectedPeers.add(pid);
  });
  agent.node.libp2p.addEventListener('peer:disconnect', (evt) => {
    const pid = evt.detail.toString();
    connectedPeers.delete(pid);
    console.log(`\n  [-] Peer disconnected: ${short(pid)}`);
    prompt();
  });

  // Wait for Agent A's profile to arrive
  console.log('Waiting for Agent A profile via GossipSub...');
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    const agents = await agent.findAgents();
    if (agents.length > 1) {
      console.log(`Discovered ${agents.length} agent(s):`);
      for (const a of agents) console.log(`  ${a.name} [${a.framework ?? '?'}] — ${short(a.peerId)}`);
      break;
    }
    process.stdout.write('.');
  }
  console.log('');

  const offerings = await agent.findSkills({ skillType: 'ImageAnalysis' });
  if (offerings.length > 0) {
    console.log(`Found: ${offerings[0].agentName} offers ${offerings[0].skillType} @ ${offerings[0].pricePerCall} TRAC/call`);
  }

  console.log('\nReady. Type a message to chat, or /help for commands.\n');

  // Interactive REPL
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  prompt = () => rl.prompt();
  rl.setPrompt('TextBot> ');
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { prompt(); return; }

    if (input === '/help') {
      console.log('Commands:');
      console.log('  /peers           — list connected peers');
      console.log('  /agents          — list discovered agents');
      console.log('  /skills          — list discovered skill offerings');
      console.log('  /invoke <text>   — invoke Agent A ImageAnalysis skill');
      console.log('  /quit            — stop');
      console.log('  <anything else>  — send as chat to all peers');
    } else if (input === '/peers') {
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
    } else if (input.startsWith('/invoke ')) {
      const text = input.slice(8).trim();
      if (!text) { console.log('Usage: /invoke <text>'); prompt(); return; }
      if (!agentAPeerId) { console.log('Agent A peerId unknown'); prompt(); return; }
      console.log(`Invoking ImageAnalysis on Agent A with: "${text}"...`);
      try {
        const resp = await agent.invokeSkill(
          agentAPeerId,
          'https://dkg.origintrail.io/skill#ImageAnalysis',
          new TextEncoder().encode(text),
        );
        if (resp.success && resp.outputData) {
          console.log(`  Result: ${new TextDecoder().decode(resp.outputData)}`);
        } else {
          console.log(`  Error: ${resp.error ?? 'unknown'}`);
        }
      } catch (err) {
        console.log(`  Failed: ${err.message}`);
      }
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
