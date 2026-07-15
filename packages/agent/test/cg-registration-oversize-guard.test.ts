/**
 * CG-registration oversize guard (OT-RFC-56 §4.6).
 *
 * `createContextGraph` / `ensureContextGraphLocal` write the CG registration
 * record (name + description) RAW into the network-replicated ONTOLOGY graph,
 * bypassing the guarded publish routes — the exact producer hole behind the
 * 2026-07-08 mainnet "skyocean" 177KB-description poison. The guard rejects an
 * oversized description BEFORE any store write, with a caller-correctable
 * `OVERSIZED_RDF_LITERAL` error.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DKGAgent } from '../src/index.js';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';

describe('createContextGraph oversize-description guard', () => {
  let agent: DKGAgent | undefined;
  afterEach(async () => { await agent?.stop().catch(() => {}); agent = undefined; });

  const makeAgent = async (store: OxigraphStore) => DKGAgent.create({
    name: 'CgGuardNode',
    listenPort: 0,
    listenHost: '127.0.0.1',
    store,
    chainAdapter: new NoChainAdapter(),
    nodeRole: 'core',
    skills: [],
  });

  it('rejects new context graph IDs that alias structural storage partitions', async () => {
    const store = new OxigraphStore();
    agent = await makeAgent(store);

    await expect(
      agent.createContextGraph({ id: 'victim/_meta', name: 'Namespace collision' }),
    ).rejects.toThrow(/reserved storage partition/);

    const result = await store.query(
      'SELECT ?p WHERE { GRAPH ?g { <did:dkg:context-graph:victim/_meta> ?p ?o } }',
    );
    expect(result.type === 'bindings' && result.bindings).toHaveLength(0);
  });

  it('rejects an oversized description with OVERSIZED_RDF_LITERAL, writing nothing', async () => {
    const store = new OxigraphStore();
    agent = await makeAgent(store);
    await agent.start();

    const oversized = 'D'.repeat(200_000);
    await expect(
      agent.createContextGraph({ id: 'skyocean-repro', name: 'Skyocean', description: oversized }),
    ).rejects.toMatchObject({ code: 'OVERSIZED_RDF_LITERAL' });

    // Fail-before-side-effect: no ontology triples for this CG landed.
    const r = await store.query(
      `SELECT ?p WHERE { GRAPH ?g { <did:dkg:context-graph:skyocean-repro> ?p ?o } }`,
    );
    expect(r.type === 'bindings' && r.bindings).toHaveLength(0);
  });

  it('accepts a normal-sized description', async () => {
    agent = await makeAgent(new OxigraphStore());
    await agent.start();
    await expect(
      agent.createContextGraph({ id: 'normal-cg', name: 'Normal', description: 'a reasonable description' }),
    ).resolves.toBeUndefined();
  });
});
