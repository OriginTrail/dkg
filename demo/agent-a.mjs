/**
 * DKG V9 Agent Demo — Agent A (ImageBot Skill Provider)
 *
 * Run from repo root:
 *   node demo/agent-a.mjs [port]
 *
 * This agent:
 *  1. Starts a DKG node
 *  2. Publishes its profile (ImageBot offering ImageAnalysis skills)
 *  3. Waits for incoming skill requests
 *  4. Responds with a mock image analysis result
 */

import { DKGAgent } from '@dkg/agent';

const PORT = parseInt(process.argv[2] || '9100', 10);

async function main() {
  console.log('=== DKG Agent A — ImageBot Skill Provider ===\n');

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
          console.log(`\n[SKILL] Received ImageAnalysis request from ${senderPeerId.slice(0, 12)}...`);
          const inputText = new TextDecoder().decode(request.inputData);
          console.log(`[SKILL] Input: ${inputText}`);

          // Simulate analysis
          const result = JSON.stringify({
            label: 'cat',
            confidence: 0.97,
            description: `Analysis of: ${inputText}`,
          });
          console.log(`[SKILL] Result: ${result}`);

          return {
            success: true,
            outputData: new TextEncoder().encode(result),
          };
        },
      },
    ],
  });

  await agent.start();

  const addrs = agent.multiaddrs;
  console.log(`Node started. PeerId: ${agent.peerId}`);
  console.log(`Listening on:`);
  for (const a of addrs) {
    console.log(`  ${a}`);
  }

  // Publish profile as a Knowledge Asset
  console.log('\nPublishing agent profile to Agent Registry paranet...');
  const result = await agent.publishProfile();
  console.log(`Profile published: KC #${result.kcId}, ${result.kaManifest.length} KA(s)`);

  // Self-discover to verify
  const agents = await agent.findAgents();
  console.log(`\nDiscoverable agents in registry: ${agents.length}`);
  for (const a of agents) {
    console.log(`  - ${a.name} (${a.peerId.slice(0, 12)}...) [${a.framework ?? 'unknown'}]`);
  }

  // Also publish to a custom paranet for non-profile data
  const publicQuads = [
    { subject: 'did:dkg:agent:' + agent.peerId, predicate: 'http://schema.org/knows', object: '"deep learning"', graph: '' },
    { subject: 'did:dkg:agent:' + agent.peerId, predicate: 'http://schema.org/knows', object: '"computer vision"', graph: '' },
  ];
  await agent.publish('agent-skills', publicQuads);
  console.log('\nAlso published domain knowledge to agent-skills paranet');

  // Re-broadcast profile when a new peer connects (they may have missed the initial publish)
  agent.node.libp2p.addEventListener('peer:connect', async () => {
    await new Promise(r => setTimeout(r, 2000));
    console.log('[GossipSub] New peer connected — re-broadcasting profile...');
    try {
      await agent.publishProfile();
      console.log('[GossipSub] Profile re-broadcast complete.');
    } catch (err) {
      console.error('[GossipSub] Re-broadcast failed:', err.message);
    }
  });

  console.log('\n--- Waiting for Agent B to connect ---');
  console.log('(connect with: node demo/agent-b.mjs ' + addrs.find(a => a.includes('/tcp/')) + ')');
  console.log('\nPress Ctrl+C to stop.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
