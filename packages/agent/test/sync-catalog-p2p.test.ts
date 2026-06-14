/**
 * facet open-serve, end-to-end over P2P (no chain/devnet).
 * An OUTSIDER (non-member) fetches a private CG's public _catalog facet from a
 * peer and receives the DCAT catalog entry — but never any gated data.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { DKGAgent, MockChainAdapter } from './agent.shared';
import {
  DKG_ONTOLOGY, contextGraphCatalogUri, contextGraphDataUri,
} from '@origintrail-official/dkg-core';

const agents: DKGAgent[] = [];
afterEach(async () => { for (const a of agents) { try { await a.stop(); } catch {} } agents.length = 0; });

async function mkAgent(name: string, addr: string) {
  const chain = new MockChainAdapter('mock:31337', addr);
  const agent = await DKGAgent.create({ name, listenPort: 0, skills: [], chainAdapter: chain });
  agents.push(agent);
  await agent.start();
  return agent;
}

describe('outsider fetches the _catalog facet over P2P (no membership)', () => {
  it('serves the catalog to a non-member and never the gated data', async () => {
    const publisher = await mkAgent('PublisherNode', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    const outsider = await mkAgent('OutsiderNode', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');

    const CG = 'p2p-catalog-cg';
    const cgUal = contextGraphDataUri(CG);
    const catalogGraph = contextGraphCatalogUri(CG);
    const privateGraph = `did:dkg:context-graph:${CG}/_private`;

    // Publisher holds a public catalog entry + gated private data.
    await (publisher as any).store.insert([
      { subject: cgUal, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DCAT_DATASET, graph: catalogGraph },
      { subject: cgUal, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_PRIVATE_CONTEXT_GRAPH, graph: catalogGraph },
      { subject: cgUal, predicate: DKG_ONTOLOGY.DCT_ACCESS_RIGHTS, object: DKG_ONTOLOGY.ACCESS_RIGHT_RESTRICTED, graph: catalogGraph },
      { subject: 'urn:acme:shipment/SH-42', predicate: 'urn:acme:product', object: '"SECRET-P9"', graph: privateGraph },
    ]);

    await outsider.connectTo(publisher.multiaddrs[0]);
    await new Promise((r) => setTimeout(r, 600));

    const quads = await outsider.fetchPublicCatalog(CG, publisher.peerId);

    // The outsider received the DCAT catalog entry...
    const objs = quads.map((q) => String(q.object));
    expect(objs).toContain(DKG_ONTOLOGY.DCAT_DATASET);
    expect(objs).toContain(DKG_ONTOLOGY.ACCESS_RIGHT_RESTRICTED);
    // ...and NONE of the gated private data.
    expect(objs.some((o) => o.includes('SECRET'))).toBe(false);
  }, 60_000);
});
