import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DKGNode, MemoryLayer, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri } from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { GraphManager, PrivateContentStore } from '@origintrail-official/dkg-storage';
import { computePrivateRootV10, generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
import { multiaddr } from '@multiformats/multiaddr';
import { DKGAgent } from '../src/dkg-agent.js';

const CG = 'manual-private-access';
const UAL = 'did:dkg:evm:31337/0x1111111111111111111111111111111111111111/0';
const agents: DKGAgent[] = [];
// Owned loopback bootstrap disables mDNS, so this test cannot discover other local agents.
const bootstrap = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
const payload = [{ subject: 'urn:secret', predicate: 'urn:value', object: '"private"', graph: '' }];

async function create(name: string) {
  const agent = await DKGAgent.create({ name, listenHost: '127.0.0.1', listenPort: 0,
    bootstrapPeers: bootstrap.multiaddrs, chainAdapter: new MockChainAdapter(), rfc64CatalogActivation: { enabled: false },
    syncOnConnectEnabled: false, syncReconcilerEnabled: false, vmReconcilerEnabled: false,
  });
  agents.push(agent);
  await agent.start();
  return agent;
}

describe('manual private access over real local peers', () => {
  let publisher: DKGAgent;
  let allowed: DKGAgent;
  let denied: DKGAgent;
  beforeAll(async () => {
    await bootstrap.start();
    publisher = await create('manual-access-publisher');
    allowed = await create('manual-access-allowed');
    denied = await create('manual-access-denied');
    const manager = new GraphManager(publisher.store);
    await manager.ensureContextGraph(CG);
    const scope = createGraphKnowledgeAssetScope(UAL, '1');
    await new PrivateContentStore(publisher.store, manager)
      .replaceKnowledgeAssetPrivateTriples(CG, scope, payload);
    await publisher.store.insert(generateGraphKnowledgeAssetMetadata({
      ual: UAL, contextGraphId: CG, merkleRoot: new Uint8Array(32).fill(7),
      publisherPeerId: publisher.peerId, accessPolicy: 'allowList', allowedPeers: [allowed.peerId],
      timestamp: new Date(0), assertionVersion: '1', publicTripleCount: 0, privateTripleCount: 1,
      privateMerkleRoot: computePrivateRootV10(payload)!,
      assertionGraph: knowledgeAssetLayerGraphUri(CG, MemoryLayer.VerifiableMemory, scope),
    }, { status: 'tentative' }));
    await publisher.store.insert([{ subject: `did:dkg:context-graph:${CG}`,
      predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
      object: 'https://dkg.network/ontology#ContextGraph', graph: `did:dkg:context-graph:${CG}/_meta`,
    }]);
    await allowed.node.libp2p.dial(multiaddr(publisher.multiaddrs[0]));
    await denied.node.libp2p.dial(multiaddr(publisher.multiaddrs[0]));
  }, 60_000);
  afterAll(async () => {
    for (const agent of agents.reverse()) await agent.stop();
    await bootstrap.stop();
  }, 30_000);

  it('lets the allowed peer explicitly fetch without claiming chain verification or inserting into its graph', async () => {
    const result = await allowed.requestPrivateAccess({ publisherPeerId: publisher.peerId, kaUal: UAL });
    expect(result).toMatchObject({ granted: true, storedInGraph: false,
      verification: { kind: 'peer-root-self-check', matches: true, chainAnchored: false },
      quads: payload,
    });
    const rows = await allowed.store.query('SELECT ?s WHERE { GRAPH ?g { ?s <urn:value> "private" } }');
    expect(rows).toMatchObject({ type: 'bindings', bindings: [] });
    expect(allowed.getMessengerOutboxStats()).toMatchObject({ queuedEntries: 0 });
  });

  it('preserves the physical-peer allow-list gate', async () => {
    const result = await denied.requestPrivateAccess({ publisherPeerId: publisher.peerId, kaUal: UAL });
    expect(result).toMatchObject({ granted: false, quads: [], storedInGraph: false });
    expect(result).not.toHaveProperty('privateMerkleRoot');
  });
});
