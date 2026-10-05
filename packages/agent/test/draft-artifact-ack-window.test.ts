// SPDX-License-Identifier: Apache-2.0
import { afterAll, expect, it, vi } from 'vitest';
const previousWindow = vi.hoisted(() => {
  const previous = process.env['DKG_STORAGE_ACK_PENDING_TX_WINDOW_MS'];
  process.env['DKG_STORAGE_ACK_PENDING_TX_WINDOW_MS'] = '600000';
  return previous;
});
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { GraphManager } from '@origintrail-official/dkg-storage';
import { storeKnowledgeAssetOperationPublicQuads, storeKnowledgeAssetWorkspaceHead, workspaceOperationSubject } from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../src/index.js';
import { DKGAgentBase } from '../src/dkg-agent-base.js';

afterAll(() => {
  if (previousWindow === undefined) delete process.env['DKG_STORAGE_ACK_PENDING_TX_WINDOW_MS'];
  else process.env['DKG_STORAGE_ACK_PENDING_TX_WINDOW_MS'] = previousWindow;
});

it('passes the configured ten-minute ACK window through real cleanup without collecting a seven-minute abandoned operation', async () => {
  expect(DKGAgentBase.STORAGE_ACK_PENDING_TX_WINDOW_MS).toBe(600_000);
  const now = Date.parse('2026-10-04T06:00:00Z');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const agent = await DKGAgent.create({ name: 'configured-draft-window', chainAdapter: new NoChainAdapter(), sharedMemoryTtlMs: 30 * 24 * 60 * 60_000 });
  const store = agent.store, manager = new GraphManager(store), cg = 'configured-draft-window';
  const ka = 'did:dkg:31337/0x1111111111111111111111111111111111111111/7';
  const dkg = 'http://dkg.io/ontology/';
  try {
    await manager.ensureContextGraph(cg);
    const seed = (id: string, age: number, version: number) => storeKnowledgeAssetOperationPublicQuads({ store, graphManager: manager, contextGraphId: cg, shareOperationId: id, kaUal: ka, assertionVersion: version,
      quads: [{ subject: 'urn:configured:payload', predicate: 'urn:title', object: '"retained"', graph: '' }], timestamp: new Date(now - age) });
    await seed('within-window', 7 * 60_000, 3);
    await seed('past-window', 20 * 60_000, 3);
    await seed('current', 0, 2);
    await storeKnowledgeAssetWorkspaceHead({ store, graphManager: manager, contextGraphId: cg, kaUal: ka, assertionVersion: 2, shareOperationId: 'current' });
    const meta = manager.sharedMemoryMetaUri(cg);
    const operation = (id: string) => workspaceOperationSubject(cg, id);
    const snapshot = async (id: string) => {
      const rows = await store.query(`SELECT ?g WHERE { GRAPH <${meta}> { <${operation(id)}> <${dkg}publicSnapshotGraph> ?g } }`);
      if (rows.type !== 'bindings' || !rows.bindings[0]?.['g']) throw new Error('Missing actual immutable snapshot');
      return rows.bindings[0]['g'];
    };
    const youngSnapshot = await snapshot('within-window'), oldSnapshot = await snapshot('past-window');
    const query = vi.spyOn(store, 'query');
    await agent.cleanupExpiredSharedMemory();
    for (const [id, present] of [['within-window', true], ['past-window', false], ['current', true]] as const) {
      expect(await store.query(`ASK { GRAPH <${meta}> { <${operation(id)}> ?p ?o } }`)).toEqual({ type: 'boolean', value: present });
    }
    expect(await store.query(`ASK { GRAPH <${youngSnapshot}> { ?s ?p ?o } }`)).toEqual({ type: 'boolean', value: true });
    expect(await store.query(`ASK { GRAPH <${oldSnapshot}> { ?s ?p ?o } }`)).toEqual({ type: 'boolean', value: false });
    const selected = query.mock.calls.find(([sparql, options]) => options?.source === 'agent.draftArtifacts.supersededOperations' && sparql.includes(`did:dkg:context-graph:${cg}/`));
    expect(selected?.[0]).toContain(new Date(now - 600_000).toISOString());
  } finally { clock.mockRestore(); await agent.stop(); await store.close(); }
});
