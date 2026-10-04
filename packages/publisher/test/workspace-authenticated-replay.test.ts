import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import { authenticateWorkspaceOperationReplay } from '../src/workspace-authenticated-replay.js';
import { RECOVERED_OPERATION_CHRONOLOGY } from '../src/workspace-operation-alias.js';
import { workspaceOperationSubject } from '../src/workspace-metadata-subjects.js';
import { resolveKnowledgeAssetWorkspaceHead, storeKnowledgeAssetOperationPublicQuads, storeKnowledgeAssetWorkspaceHead } from '../src/workspace-resolution.js';

const CG = 'authenticated-replay';
const UAL = 'did:dkg:31337/0x1111111111111111111111111111111111111111/1';
const stores: OxigraphStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });

async function recoveredHead() {
  const store = new OxigraphStore(); stores.push(store);
  const graphManager = new GraphManager(store);
  const operationId = 'recovered-B';
  const subject = workspaceOperationSubject(CG, operationId);
  const graph = graphManager.sharedMemoryMetaUri(CG);
  await storeKnowledgeAssetOperationPublicQuads({ store, graphManager, contextGraphId: CG,
    kaUal: UAL, assertionVersion: 1, shareOperationId: operationId, publisherPeerId: 'publisher',
    timestamp: new Date('2099-01-01'), quads: [{ subject: 'urn:entity', predicate: 'urn:value', object: '"B"', graph: '' }] });
  await storeKnowledgeAssetWorkspaceHead({ store, graphManager, contextGraphId: CG,
    kaUal: UAL, assertionVersion: 1, shareOperationId: operationId });
  // Model a pre-upgrade/cold provider operation, with no reserved local proof.
  await store.deleteByPattern({ graph: 'urn:dkg:publisher:authenticated-operation-evidence', subject });
  await store.insert([{ subject, predicate: RECOVERED_OPERATION_CHRONOLOGY, object: '"true"', graph }]);
  const head = (await resolveKnowledgeAssetWorkspaceHead({ store, graphManager, contextGraphId: CG, kaUal: UAL }))!;
  expect(head.operationAliases[0]?.publisherChronologyAuthenticated).toBe(false);
  return { store, graphManager, contextGraphId: CG, shareOperationId: operationId, head, graph, subject };
}

describe('authenticated exact replay evidence acquisition', () => {
  it('certifies the wire clock, removes recovery control metadata, and retains snapshot identity', async () => {
    const input = await recoveredHead();
    await authenticateWorkspaceOperationReplay({ ...input, timestamp: new Date(2000) });
    const authenticated = (await resolveKnowledgeAssetWorkspaceHead({ store: input.store, graphManager: input.graphManager, contextGraphId: CG, kaUal: UAL }))!;
    expect(authenticated.operationAliases[0]).toMatchObject({ publishedAt: '2000', snapshotLocator: input.head.operationAliases[0]!.snapshotLocator });
    expect(authenticated.operationAliases[0]?.publisherChronologyAuthenticated).toBe(true);
    expect(await input.store.query(`ASK { GRAPH <${input.graph}> { <${input.subject}> <${RECOVERED_OPERATION_CHRONOLOGY}> ?marker } }`))
      .toEqual({ type: 'boolean', value: false });
    await authenticateWorkspaceOperationReplay({ ...input, head: authenticated, timestamp: new Date(1000) });
    expect((await resolveKnowledgeAssetWorkspaceHead({ store: input.store, graphManager: input.graphManager, contextGraphId: CG, kaUal: UAL }))?.operationAliases[0]?.publishedAt).toBe('2000');
  });

  it.each(['unavailable', 'empty'] as const)('leaves provider chronology untrusted when operation acquisition is %s', async mode => {
    const input = await recoveredHead();
    const query = input.store.query.bind(input.store);
    const before = await query('CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ?g { ?s ?p ?o } }');
    vi.spyOn(input.store, 'query').mockImplementation((text, options) => options?.source === 'publisher.workspace.authenticatedReplay'
      ? Promise.resolve(mode === 'unavailable' ? { type: 'boolean' as const, value: false } : { type: 'quads' as const, quads: [] }) : query(text, options));
    await expect(authenticateWorkspaceOperationReplay({ ...input, timestamp: new Date(2000) })).rejects.toThrow('operation is unavailable');
    expect(await query('CONSTRUCT { ?s ?p ?o } WHERE { GRAPH ?g { ?s ?p ?o } }')).toEqual(before);
  });

  it('rejects a replay without the exact head alias before acquiring operation rows', async () => {
    const input = await recoveredHead();
    const query = vi.spyOn(input.store, 'query');
    await expect(authenticateWorkspaceOperationReplay({ ...input, shareOperationId: 'different', timestamp: new Date(2000) })).rejects.toThrow('no matching head alias');
    expect(query).not.toHaveBeenCalled();
  });
});
