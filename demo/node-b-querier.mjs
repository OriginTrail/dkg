/**
 * DKG V9 Demo — Node B (Querier)
 *
 * Run from repo root:
 *   node demo/node-b-querier.mjs <node-a-multiaddr>
 *
 * This node:
 *  1. Connects to Node A and subscribes to the paranet GossipSub topic
 *  2. Receives public triples broadcast by Node A over GossipSub
 *  3. Stores them in its own Oxigraph instance
 *  4. Queries the local knowledge graph with SPARQL
 *  5. Requests private triples from Node A via /dkg/access/1.0.0
 */

import {
  DKGNode, ProtocolRouter, GossipSubManager, TypedEventBus,
  generateEd25519Keypair, decodePublishRequest, paranetPublishTopic,
} from '@dkg/core';
import { OxigraphStore, GraphManager } from '@dkg/storage';
import { DKGQueryEngine } from '@dkg/query';
import { AccessClient } from '@dkg/publisher';
import { multiaddr } from '@multiformats/multiaddr';

const PARANET = 'agent-skills';
const TOPIC = paranetPublishTopic(PARANET);

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const nodeAAddr = process.argv[2];
  if (!nodeAAddr) {
    console.error('Usage: node demo/node-b-querier.mjs <node-a-multiaddr>');
    console.error('  Run node-a-publisher.mjs first, then copy the multiaddr here.');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════');
  console.log('  DKG V9 — Node B (Querier)');
  console.log('═══════════════════════════════════════════\n');

  // 1. Start node
  const node = new DKGNode({
    listenAddresses: ['/ip4/127.0.0.1/tcp/9001'],
    enableMdns: false,
  });
  await node.start();
  console.log(`Peer ID:   ${node.peerId}`);
  console.log(`Multiaddr: ${node.multiaddrs[0]}\n`);

  const store = new OxigraphStore();
  const graphManager = new GraphManager(store);
  const eventBus = new TypedEventBus();
  const keypair = await generateEd25519Keypair();
  const router = new ProtocolRouter(node);

  // 2. Subscribe to the paranet GossipSub topic BEFORE connecting
  const gossip = new GossipSubManager(node, eventBus);
  gossip.subscribe(TOPIC);
  console.log(`Subscribed to GossipSub topic: "${TOPIC}"`);

  // Set up a promise that resolves when we receive the publish broadcast
  let resolvePublish;
  const publishReceived = new Promise(r => { resolvePublish = r; });

  gossip.onMessage(TOPIC, async (_topic, data, from) => {
    console.log(`\n  [GossipSub] Received broadcast from ${from.slice(0, 20)}...`);

    try {
      const request = decodePublishRequest(data);
      const nquadsStr = new TextDecoder().decode(request.nquads);
      const quads = parseSimpleNQuads(nquadsStr);

      console.log(`  [GossipSub] Decoded PublishRequest:`);
      console.log(`    UAL:       ${request.ual}`);
      console.log(`    Paranet:   ${request.paranetId}`);
      console.log(`    Triples:   ${quads.length}`);
      console.log(`    KAs:       ${request.kas.length}`);

      // Store the received triples in our local Oxigraph
      await graphManager.ensureParanet(request.paranetId);
      const dataGraph = graphManager.dataGraphUri(request.paranetId);
      const normalized = quads.map(q => ({ ...q, graph: dataGraph }));
      await store.insert(normalized);

      console.log(`  [GossipSub] Stored ${quads.length} triples in local graph <${dataGraph}>\n`);
      resolvePublish({ request, quads });
    } catch (err) {
      console.error('  [GossipSub] Failed to process broadcast:', err.message);
    }
  });

  // 3. Connect to Node A
  console.log(`\nConnecting to Node A...`);
  await node.libp2p.dial(multiaddr(nodeAAddr));
  await sleep(500);
  console.log('Connected!\n');

  const nodeAPeerId = nodeAAddr.split('/p2p/')[1];

  // 4. Wait for the GossipSub broadcast from Node A
  console.log('─────────────────────────────────────────');
  console.log(' Step 1: Waiting for GossipSub broadcast');
  console.log('─────────────────────────────────────────\n');

  console.log('  Listening on GossipSub... (Node A will broadcast shortly)\n');

  const { request, quads } = await Promise.race([
    publishReceived,
    sleep(15000).then(() => { throw new Error('Timed out waiting for GossipSub broadcast (15s)'); }),
  ]);

  // 5. Query the local store
  console.log('─────────────────────────────────────────');
  console.log(' Step 2: Query the local knowledge graph');
  console.log('─────────────────────────────────────────\n');

  const engine = new DKGQueryEngine(store);

  console.log('  SPARQL: "Find all agents and their names"\n');
  const agents = await engine.query(
    `SELECT ?agent ?name WHERE {
      ?agent <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dkg.io/ontology/Agent> .
      ?agent <http://schema.org/name> ?name .
    }`,
    { paranetId: PARANET },
  );

  if (agents.bindings.length === 0) {
    console.log('  No agents found!\n');
  }
  for (const row of agents.bindings) {
    console.log(`  Agent: ${row['agent']}`);
    console.log(`  Name:  ${row['name']}\n`);
  }

  console.log('  SPARQL: "Find all service offerings"\n');
  const skills = await engine.query(
    `SELECT ?offering ?skill ?price WHERE {
      ?agent <http://dkg.io/ontology/offers> ?offering .
      ?offering <http://dkg.io/ontology/skillType> ?skill .
      ?offering <http://schema.org/price> ?price .
    }`,
    { paranetId: PARANET },
  );

  for (const row of skills.bindings) {
    console.log(`  Offering: ${row['offering']}`);
    console.log(`  Skill:    ${row['skill']}`);
    console.log(`  Price:    ${row['price']} TRAC\n`);
  }

  // 6. Request private triples from Node A
  console.log('─────────────────────────────────────────');
  console.log(' Step 3: Request PRIVATE triples from Node A');
  console.log('─────────────────────────────────────────\n');

  console.log(`  Sending AccessRequest to Node A (${nodeAPeerId.slice(0, 20)}...)...\n`);

  const accessClient = new AccessClient(router, keypair, node.peerId);
  const kaUal = `${request.ual}/${request.kas[0].tokenId}`;
  const accessResult = await accessClient.requestAccess(
    nodeAPeerId,
    kaUal,
  );

  if (accessResult.granted) {
    console.log(`  ACCESS GRANTED — received ${accessResult.quads.length} private triple(s):\n`);
    for (const quad of accessResult.quads) {
      const pred = quad.predicate.split('/').pop() || quad.predicate;
      const obj = quad.object.length > 60 ? quad.object.slice(0, 60) + '...' : quad.object;
      console.log(`    ${pred}: ${obj}`);
    }
  } else {
    console.log(`  ACCESS DENIED: ${accessResult.rejectionReason}`);
  }

  console.log('\n═══════════════════════════════════════════');
  console.log('  Demo complete!');
  console.log('═══════════════════════════════════════════\n');

  await node.stop();
  process.exit(0);
}

/**
 * Minimal N-Quads parser (same as PublishHandler's).
 */
function parseSimpleNQuads(text) {
  const quads = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const body = trimmed.endsWith(' .') ? trimmed.slice(0, -2).trim() : trimmed;
    const parts = splitNQuadLine(body);
    if (parts.length >= 3) {
      quads.push({
        subject: strip(parts[0]),
        predicate: strip(parts[1]),
        object: parts[2].startsWith('"') ? parts[2] : strip(parts[2]),
        graph: parts[3] ? strip(parts[3]) : '',
      });
    }
  }
  return quads;
}

function splitNQuadLine(line) {
  const parts = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && line[i] === ' ') i++;
    if (i >= line.length) break;
    if (line[i] === '<') {
      const end = line.indexOf('>', i);
      if (end === -1) break;
      parts.push(line.slice(i, end + 1));
      i = end + 1;
    } else if (line[i] === '"') {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue; }
        if (line[j] === '"') {
          j++;
          if (line[j] === '@') { while (j < line.length && line[j] !== ' ') j++; }
          else if (line[j] === '^' && line[j+1] === '^') {
            j += 2;
            if (line[j] === '<') { const end = line.indexOf('>', j); j = end + 1; }
          }
          break;
        }
        j++;
      }
      parts.push(line.slice(i, j));
      i = j;
    } else if (line[i] === '_') {
      let j = i;
      while (j < line.length && line[j] !== ' ') j++;
      parts.push(line.slice(i, j));
      i = j;
    } else break;
  }
  return parts;
}

function strip(s) {
  if (s.startsWith('<') && s.endsWith('>')) return s.slice(1, -1);
  return s;
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
