// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, assertionLifecycleUri, contextGraphMetaUri, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { storeKnowledgeAssetWorkspaceHead } from '../src/workspace-resolution.js';
import { knowledgeAssetWorkspaceHeadRows } from '../src/workspace-head-rows.js';

const CG = 'publication-owner', NAME = 'notes', AUTHOR = '0x1111111111111111111111111111111111111111';
const DKG = 'http://dkg.io/ontology/';
const stores: OxigraphStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close(); });

async function fixture() {
  const store = new OxigraphStore(); stores.push(store);
  const publisher = new DKGPublisher({ store, chain: new NoChainAdapter(), eventBus: new TypedEventBus(), keypair: await generateEd25519Keypair() });
  await publisher.assertionCreate(CG, NAME, AUTHOR);
  const graph = contextGraphMetaUri(CG), subject = assertionLifecycleUri(CG, AUTHOR, NAME);
  // Ownership rejection must be the deciding guard, independent of layer eligibility.
  await store.deleteByPattern({ graph, subject, predicate: `${DKG}memoryLayer` });
  await store.insert([{ graph, subject, predicate: `${DKG}memoryLayer`, object: '"SWM"' }]);
  await publisher.markSwmShareComplete(CG, NAME, AUTHOR);
  return { store, publisher, graph, subject };
}

describe('publication lifecycle owner boundary', () => {
  it('consumes completion for the matching owner on an eligible SWM lifecycle', async () => {
    const f = await fixture();
    await f.store.insert([{ graph: f.graph, subject: f.subject, predicate: `${DKG}shareOperationId`, object: '"original"' }]);
    expect(await f.publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(true);
    await f.publisher.consumePublishedSwmShareComplete(CG, NAME, AUTHOR, 'original');
    expect(await f.publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(false);
  });

  it.each([['"different"'], ['urn:invalid:owner'], ['""'], ['"original"', '"other"']])(
    'does not consume completion with corrupt or replaced owner rows %j', async (...objects) => {
      const f = await fixture();
      await f.store.insert(objects.map(object => ({ graph: f.graph, subject: f.subject, predicate: `${DKG}shareOperationId`, object })));
      await f.publisher.consumePublishedSwmShareComplete(CG, NAME, AUTHOR, 'original');
      expect(await f.publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(true);
    });

  it.each(['WM', 'SWM', 'VM'])('fences explicit legacy absence against the current %s layer', async layer => {
    const f = await fixture();
    await f.store.deleteByPattern({ graph: f.graph, subject: f.subject, predicate: `${DKG}memoryLayer` });
    await f.store.insert([{ graph: f.graph, subject: f.subject, predicate: `${DKG}memoryLayer`, object: JSON.stringify(layer) }]);
    await f.publisher.consumePublishedSwmShareComplete(CG, NAME, AUTHOR, null);
    expect(await f.publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(layer === 'WM');
  });

  it.each(['missing', 'conflicting'])('retains legacy completion with %s lifecycle layer evidence', async shape => {
    const f = await fixture();
    await f.store.deleteByPattern({ graph: f.graph, subject: f.subject, predicate: `${DKG}memoryLayer` });
    if (shape === 'conflicting') await f.store.insert(['SWM', 'VM'].map(layer => ({ graph: f.graph, subject: f.subject,
      predicate: `${DKG}memoryLayer`, object: JSON.stringify(layer) })));
    await f.publisher.consumePublishedSwmShareComplete(CG, NAME, AUTHOR, null);
    expect(await f.publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(true);
  });

  it('does not consume completion when its bounded ownership query is unavailable', async () => {
    const f = await fixture();
    vi.spyOn(f.store, 'query').mockResolvedValueOnce({ type: 'quads', quads: [] });
    await f.publisher.consumePublishedSwmShareComplete(CG, NAME, AUTHOR, null);
    expect(await f.publisher.hasSwmShareComplete(CG, NAME, AUTHOR)).toBe(true);
  });

  it('round trips the canonical head rows with escaped operation identity and normalized subgraph', async () => {
    const f = await fixture(), graphManager = new GraphManager(f.store);
    const params = { store: f.store, graphManager, contextGraphId: CG, kaUal: `did:dkg:31337/${AUTHOR}/7`,
      assertionVersion: 3n, shareOperationId: 'op-"quoted"-\\-tail', subGraphName: ' notes ' };
    const rows = knowledgeAssetWorkspaceHeadRows(params);
    await storeKnowledgeAssetWorkspaceHead(params);
    const actual = await f.store.query(`CONSTRUCT { <${rows[0]!.subject}> ?p ?o } WHERE { GRAPH <${rows[0]!.graph}> { <${rows[0]!.subject}> ?p ?o } }`);
    expect(actual.type === 'quads' ? actual.quads.map(row => ({ ...row, graph: rows[0]!.graph })).sort((a,b) => a.predicate.localeCompare(b.predicate)) : [])
      .toEqual(rows.sort((a,b) => a.predicate.localeCompare(b.predicate)));
    await expect(storeKnowledgeAssetWorkspaceHead({ ...params, subGraphName: 'bad/graph' })).rejects.toThrow('invalid subGraphName');
    expect(await f.store.countQuads(rows[0]!.graph)).toBe(rows.length);
  });
});
