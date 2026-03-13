/**
 * DKG V9 Demo — Node A (Publisher)
 *
 * Run from repo root:
 *   node demo/node-a-publisher.mjs [port]
 *
 * This node publishes an ImageBot agent to the "agent-skills" paranet,
 * then waits for Node B to connect. Once a peer joins the paranet topic,
 * it broadcasts the public triples via GossipSub and serves private
 * triple requests over /dkg/access/1.0.0.
 */

import {
  DKGNode, ProtocolRouter, GossipSubManager, TypedEventBus,
  generateEd25519Keypair, encodePublishRequest,
  PROTOCOL_ACCESS, DKGEvent, paranetPublishTopic,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGPublisher, AccessHandler } from '@origintrail-official/dkg-publisher';

const PARANET = 'agent-skills';
const TOPIC = paranetPublishTopic(PARANET);
const ENTITY = 'did:dkg:agent:QmImageBot';
const SKOLEM = `${ENTITY}/.well-known/genid/offering1`;
const GRAPH = `did:dkg:paranet:${PARANET}`;

function q(s, p, o) {
  return { subject: s, predicate: p, object: o, graph: GRAPH };
}

function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function quadsToNQuads(quads) {
  return quads.map(q => {
    const obj = q.object.startsWith('"') ? q.object : `<${q.object}>`;
    return `<${q.subject}> <${q.predicate}> ${obj} <${q.graph}> .`;
  }).join('\n');
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  DKG V9 — Node A (Publisher)');
  console.log('═══════════════════════════════════════════\n');

  const port = process.argv[2] || '9000';
  const node = new DKGNode({
    listenAddresses: [`/ip4/127.0.0.1/tcp/${port}`],
    enableMdns: false,
  });
  await node.start();

  console.log(`Peer ID:   ${node.peerId}`);
  console.log(`Multiaddr: ${node.multiaddrs[0]}\n`);

  const store = new OxigraphStore();
  const chain = new MockChainAdapter();
  const eventBus = new TypedEventBus();
  const keypair = await generateEd25519Keypair();
  const publisher = new DKGPublisher({ store, chain, eventBus, keypair });

  // --- Publish locally ---
  console.log('Publishing ImageBot agent to paranet "agent-skills"...\n');

  const publicQuads = [
    q(ENTITY, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'http://dkg.io/ontology/Agent'),
    q(ENTITY, 'http://schema.org/name', '"ImageBot"'),
    q(ENTITY, 'http://schema.org/description', '"AI agent specialized in image analysis and object detection"'),
    q(ENTITY, 'http://dkg.io/ontology/offers', SKOLEM),
    q(SKOLEM, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'http://dkg.io/ontology/ServiceOffering'),
    q(SKOLEM, 'http://dkg.io/ontology/skillType', '"ImageAnalysis"'),
    q(SKOLEM, 'http://schema.org/price', '"0.01"'),
  ];

  const privateQuads = [
    q(ENTITY, 'http://dkg.io/ontology/apiEndpoint', '"https://api.imagebot.internal/v2/analyze"'),
    q(ENTITY, 'http://dkg.io/ontology/apiKey', '"sk-img-7f3a9b2c1d4e5f6a8b9c0d1e2f3a4b5c"'),
    q(ENTITY, 'http://dkg.io/ontology/modelVersion', '"yolo-v9-2026-02"'),
  ];

  const result = await publisher.publish({ paranetId: PARANET, quads: publicQuads, privateQuads });

  console.log('Published successfully!');
  console.log(`  KC ID:       ${result.kcId}`);
  console.log(`  Merkle Root: ${toHex(result.merkleRoot).slice(0, 32)}...`);
  console.log(`  KA count:    ${result.kaManifest.length} Knowledge Asset(s)`);
  console.log(`    └─ ${result.kaManifest[0].rootEntity}`);
  console.log(`       Public triples:  ${publicQuads.length}`);
  console.log(`       Private triples: ${result.kaManifest[0].privateTripleCount}\n`);

  // --- Set up AccessHandler for private triple requests ---
  const accessHandler = new AccessHandler(store, eventBus);
  const router = new ProtocolRouter(node);
  router.register(PROTOCOL_ACCESS, accessHandler.handler);

  eventBus.on(DKGEvent.ACCESS_RESPONSE, (data) => {
    console.log(`  [Access Event] requester=${data.requester?.slice(0, 20)}... granted=${data.granted}`);
  });

  // --- Subscribe to paranet topic & prepare GossipSub broadcast ---
  const gossip = new GossipSubManager(node, eventBus);
  gossip.subscribe(TOPIC);

  // Build the protobuf message to broadcast when a peer subscribes
  const nquadsBytes = new TextEncoder().encode(quadsToNQuads(publicQuads));
  const publishMsg = encodePublishRequest({
    ual: `did:dkg:${chain.chainId}/${result.kcId}`,
    nquads: nquadsBytes,
    paranetId: PARANET,
    kas: result.kaManifest.map(ka => ({
      tokenId: Number(ka.tokenId),
      rootEntity: ka.rootEntity,
      privateMerkleRoot: ka.privateMerkleRoot ?? new Uint8Array(0),
      privateTripleCount: ka.privateTripleCount ?? 0,
    })),
    publisherIdentity: keypair.publicKey,
  });

  // When a new peer connects, wait briefly then broadcast
  node.libp2p.addEventListener('peer:connect', async (evt) => {
    const peerId = evt.detail.toString();
    console.log(`  [Peer Connected] ${peerId}`);
    // GossipSub needs a moment to exchange subscription info with the new peer
    console.log('  [GossipSub] Waiting for subscription sync...');
    await new Promise(r => setTimeout(r, 2000));
    console.log(`  [GossipSub] Broadcasting ${publicQuads.length} public triples on topic "${TOPIC}"`);
    try {
      await gossip.publish(TOPIC, publishMsg);
      console.log('  [GossipSub] Broadcast sent!\n');
    } catch (err) {
      console.error('  [GossipSub] Broadcast failed:', err.message);
    }
  });

  console.log('─────────────────────────────────────────');
  console.log(' Waiting for connections...');
  console.log(` Subscribed to GossipSub topic: "${TOPIC}"`);
  console.log(' Copy this command into Terminal 2:\n');
  console.log(`   node demo/node-b-querier.mjs ${node.multiaddrs[0]}`);
  console.log('\n─────────────────────────────────────────');
  console.log(' Press Ctrl+C to stop.\n');

  await new Promise(() => {});
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
