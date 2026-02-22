/**
 * DKG V9 Agent Demo — Agent B (Discoverer & Skill Consumer)
 *
 * Run from repo root:
 *   node demo/agent-b.mjs <agent-a-multiaddr>
 *
 * This agent:
 *  1. Starts a DKG node
 *  2. Publishes its own profile (TextBot)
 *  3. Connects to Agent A
 *  4. Waits for Agent A's profile to arrive via GossipSub
 *  5. Discovers agents and skill offerings
 *  6. Invokes Agent A's ImageAnalysis skill
 */

import { DKGAgent } from '@dkg/agent';

const AGENT_A_ADDR = process.argv[2];
if (!AGENT_A_ADDR) {
  console.error('Usage: node demo/agent-b.mjs <agent-a-multiaddr>');
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('=== DKG Agent B — TextBot (Discoverer & Consumer) ===\n');

  const agent = await DKGAgent.create({
    name: 'TextBot',
    framework: 'ElizaOS',
    description: 'AI agent providing text analysis capabilities',
    listenPort: 0,
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
              sentiment: 'positive',
              wordCount: text.split(' ').length,
            })),
          };
        },
      },
    ],
  });

  await agent.start();
  console.log(`Node started. PeerId: ${agent.peerId.slice(0, 16)}...`);

  // Publish our own profile
  console.log('\nPublishing TextBot profile...');
  const myProfile = await agent.publishProfile();
  console.log(`Profile published: KC #${myProfile.kcId}`);

  // Subscribe to agent-skills paranet
  agent.subscribeToParanet('agent-skills');

  // Connect to Agent A
  console.log(`\nConnecting to Agent A at ${AGENT_A_ADDR}...`);
  await agent.connectTo(AGENT_A_ADDR);
  console.log('Connected!');

  // Wait for GossipSub to propagate Agent A's profile
  console.log('\nWaiting for Agent A profile to arrive via GossipSub...');
  let attempts = 0;
  let agents = [];
  while (attempts < 20) {
    await sleep(1000);
    agents = await agent.findAgents();
    if (agents.length > 1) break;
    attempts++;
    process.stdout.write('.');
  }
  console.log('');

  console.log(`\n=== DISCOVERED AGENTS ===`);
  for (const a of agents) {
    console.log(`  ${a.name} (${a.agentUri}) [${a.framework ?? 'unknown'}]`);
  }

  // Search for image analysis skills
  console.log('\n=== SEARCHING: ImageAnalysis skills ===');
  const offerings = await agent.findSkills({ skillType: 'ImageAnalysis' });
  if (offerings.length === 0) {
    console.log('No ImageAnalysis offerings found.');
    console.log('(Agent A profile may not have arrived via GossipSub yet.)');
  } else {
    for (const o of offerings) {
      console.log(`  ${o.agentName} offers ${o.skillType} @ ${o.pricePerCall ?? 'free'} ${o.currency ?? 'TRAC'}/call`);
    }
  }

  // Query local knowledge
  console.log('\n=== LOCAL SPARQL QUERY ===');
  const qr = await agent.query(
    'SELECT ?agent ?name WHERE { ?agent a <https://dkg.origintrail.io/skill#Agent> ; <http://schema.org/name> ?name }',
    'agent-registry',
  );
  console.log(`Found ${qr.bindings.length} agent(s) in local store:`);
  for (const row of qr.bindings) {
    const name = row['name']?.replace(/^"|"$/g, '') ?? '?';
    console.log(`  - ${name} (${row['agent']})`);
  }

  console.log('\n=== DEMO COMPLETE ===');
  console.log('Both agents are running. Press Ctrl+C to stop.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
