/**
 * OT-RFC-49 §7 — facet open-serve bounding. readCatalogPage MUST release only
 * the public `_catalog` named graph and never any gated quad (private payload,
 * VM data, or _meta). This is the safety boundary of the open-serve path.
 */
import { describe, it, expect } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  contextGraphCatalogUri,
  contextGraphDataUri,
  contextGraphPrivateGraphUri,
  contextGraphMetaGraphUri,
  DKG_ONTOLOGY,
} from '@origintrail-official/dkg-core';
import { readCatalogPage } from '../src/sync/responder/graph-plan.js';

describe('OT-RFC-49 §7 — readCatalogPage releases ONLY the _catalog graph', () => {
  it('serves the public DCAT catalog entry and leaks nothing gated', async () => {
    const store = new OxigraphStore();
    const CG = 'cat-serve-test';
    const cgUal = contextGraphDataUri(CG);                 // did:dkg:context-graph:cat-serve-test
    const catalogGraph = contextGraphCatalogUri(CG);       // …/_catalog
    const privateGraph = contextGraphPrivateGraphUri(CG);  // …/_private
    const metaGraph = contextGraphMetaGraphUri(CG);        // …/_meta
    const vmDataGraph = `did:dkg:context-graph:${CG}/_verifiable_memory/0xabc/0`;

    await store.insert([
      // public catalog entry (the only thing that may be served)
      { subject: cgUal, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DCAT_DATASET, graph: catalogGraph },
      { subject: cgUal, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_PRIVATE_CONTEXT_GRAPH, graph: catalogGraph },
      { subject: cgUal, predicate: DKG_ONTOLOGY.DCT_ACCESS_RIGHTS, object: DKG_ONTOLOGY.ACCESS_RIGHT_RESTRICTED, graph: catalogGraph },
      // gated content — MUST NOT be served by the open path
      { subject: 'urn:acme:shipment/SH-42', predicate: 'urn:acme:product', object: '"SECRET-P9"', graph: privateGraph },
      { subject: 'urn:acme:shipment/SH-42', predicate: 'urn:acme:product', object: '"SECRET-P9"', graph: vmDataGraph },
      { subject: cgUal, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: 'did:dkg:agent:0xsecret', graph: metaGraph },
    ]);

    const rows = await readCatalogPage({ store, contextGraphId: CG, offset: 0, limit: 100 });

    expect(rows.length).toBeGreaterThan(0);
    // EVERY served row is from the _catalog graph
    expect(rows.every((r) => r.g === catalogGraph)).toBe(true);
    // the catalog entry IS served
    expect(rows.some((r) => r.o === DKG_ONTOLOGY.DCAT_DATASET)).toBe(true);
    expect(rows.some((r) => r.o === DKG_ONTOLOGY.ACCESS_RIGHT_RESTRICTED)).toBe(true);
    // NOTHING gated leaks — not private, not VM data, not _meta/curator
    expect(rows.some((r) => String(r.o).includes('SECRET'))).toBe(false);
    expect(rows.some((r) => r.g === privateGraph || r.g === vmDataGraph || r.g === metaGraph)).toBe(false);
    expect(rows.some((r) => r.p === DKG_ONTOLOGY.DKG_CURATOR)).toBe(false);
  });

  it('returns nothing for a CG with no catalog entry', async () => {
    const store = new OxigraphStore();
    const CG = 'no-catalog';
    await store.insert([
      { subject: 'urn:x', predicate: 'urn:p', object: '"v"', graph: `did:dkg:context-graph:${CG}/_private` },
    ]);
    const rows = await readCatalogPage({ store, contextGraphId: CG, offset: 0, limit: 100 });
    expect(rows).toHaveLength(0);
  });
});
