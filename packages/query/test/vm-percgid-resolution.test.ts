/**
 * Regression test for GH #1098 (layer 2) — the `verifiable-memory` view must
 * resolve the per-cgId VM data graph `did:dkg:context-graph:<cg>/context/<id>`.
 *
 * Chain-driven VM reconcile (and any per-cgId-only materialisation, e.g. a peer
 * that subscribed BEFORE publish and recovered via the reconcile sweep) writes
 * confirmed data ONLY into the per-cgId graph, never the root content graph. The
 * base VM resolution reads only the root content graph + `_verifiable_memory/*`,
 * so that data was materialised yet INVISIBLE to a VM query (the observable half
 * of #1098). This pins that an unscoped VM read returns per-cgId data while still
 * excluding the per-cgId `_meta` and the CG's `_private` partition.
 *
 * Hermetic: in-memory OxigraphStore, zero mocks, zero chain.
 */
import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';

const CG = 'gh1098-percgid-cg';
const ONCHAIN = '7';
const NAME = 'http://schema.org/name';
const DATA_ENTITY = 'https://example.org/gh1098/data';
const META_ENTITY = 'https://example.org/gh1098/meta';
const PRIVATE_ENTITY = 'https://example.org/gh1098/private';

function q(subject: string, predicate: string, object: string, graph: string) {
  return { subject, predicate, object, graph };
}

describe('GH #1098 layer 2 — verifiable-memory view resolves per-cgId data graphs', () => {
  it('an unscoped VM read returns data that lives ONLY in <cg>/context/<onChainId>, excluding meta/private', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);

    const perCgIdData = `did:dkg:context-graph:${CG}/context/${ONCHAIN}`;
    const perCgIdMeta = `${perCgIdData}/_meta`;
    const privateGraph = `did:dkg:context-graph:${CG}/_private`;

    await store.insert([
      // Confirmed VM content — lives ONLY in the per-cgId data graph (where the
      // chain-reconcile path promotes it; NOT dual-written to the root graph).
      q(DATA_ENTITY, NAME, '"PerCgIdConfirmed"', perCgIdData),
      // A schema:name row in the per-cgId `_meta` — a content read must NOT pull
      // metadata-graph rows into the result set.
      q(META_ENTITY, NAME, '"PerCgIdMetaRow"', perCgIdMeta),
      // A schema:name row in the CG's private partition — never surfaced by a
      // VM content read (no includePrivate opt-in).
      q(PRIVATE_ENTITY, NAME, '"SecretPrivate"', privateGraph),
    ]);

    const result = await engine.query(
      `SELECT ?s ?o WHERE { ?s <${NAME}> ?o }`,
      { contextGraphId: CG, view: 'verifiable-memory' },
    );
    const objects = result.bindings.map((b) => b['o']);

    // The per-cgId confirmed data IS visible (the #1098 layer-2 fix).
    expect(objects).toContain('"PerCgIdConfirmed"');
    // The per-cgId `_meta` graph is NOT unioned into a content VM read.
    expect(objects).not.toContain('"PerCgIdMetaRow"');
    // The `_private` partition is NOT unioned into a VM read.
    expect(objects).not.toContain('"SecretPrivate"');
  });
});
