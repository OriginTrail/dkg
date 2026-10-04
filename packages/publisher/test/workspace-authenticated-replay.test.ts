import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphManager, OxigraphStore, UnsupportedTripleStoreCapabilityError } from '@origintrail-official/dkg-storage';
import { authenticateWorkspaceOperationReplay } from '../src/workspace-authenticated-replay.js';
import { RECOVERED_OPERATION_CHRONOLOGY, readAuthenticatedWorkspaceOperations } from '../src/workspace-operation-alias.js';
import { workspaceOperationSubject } from '../src/workspace-metadata-subjects.js';
import { resolveKnowledgeAssetWorkspaceHead, storeKnowledgeAssetOperationPublicQuads, storeKnowledgeAssetWorkspaceHead } from '../src/workspace-resolution.js';

const CG = 'authenticated-replay';
const DKG = 'http://dkg.io/ontology/';
const UAL = 'did:dkg:31337/0x1111111111111111111111111111111111111111/1';
const stores: OxigraphStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close(); });

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
    const metadata = `CONSTRUCT { <${input.subject}> ?p ?o } WHERE { GRAPH <${input.graph}> { <${input.subject}> ?p ?o } }`;
    const before = await input.store.query(metadata);
    const replace = vi.spyOn(input.store, 'replaceSubject');
    await authenticateWorkspaceOperationReplay({ ...input, timestamp: new Date(2000) });
    expect(replace).toHaveBeenCalledTimes(2);
    expect(replace.mock.calls.map(([graph]) => graph)).toEqual([input.graph, 'urn:dkg:publisher:authenticated-operation-evidence']);
    const after = await input.store.query(metadata);
    const unchanged = (result: typeof before) => result.type === 'quads' ? result.quads
      .filter(row => row.predicate !== `${DKG}publishedAt` && row.predicate !== RECOVERED_OPERATION_CHRONOLOGY) : [];
    expect(unchanged(after)).toEqual(unchanged(before));
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

  it.each(['absent', 'refused'] as const)('uses the canonical bounded %s-capability fallback and authenticates its exact final rows', async mode => {
    const input = await recoveredHead();
    const sibling = 'urn:test:co-located-operation';
    await input.store.insert([{ subject: sibling, predicate: 'urn:test:identity', object: '"sibling"', graph: input.graph }]);
    const refusal = vi.fn(async () => { throw new UnsupportedTripleStoreCapabilityError('replaceSubject', 'ReplayTestStore'); });
    const store = new Proxy(input.store, { get(target, property) {
      if (property === 'replaceSubject') return mode === 'absent' ? undefined : refusal;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await authenticateWorkspaceOperationReplay({ ...input, store, timestamp: new Date(2000) });
    const final = await store.query(`CONSTRUCT { <${input.subject}> ?p ?o } WHERE { GRAPH <${input.graph}> { <${input.subject}> ?p ?o } }`);
    expect(await readAuthenticatedWorkspaceOperations(store, final.type === 'quads' ? final.quads : [])).toEqual(new Set([input.subject]));
    expect(await store.query(`ASK { GRAPH <${input.graph}> { <${sibling}> <urn:test:identity> "sibling" } }`)).toEqual({ type: 'boolean', value: true });
    expect(refusal).toHaveBeenCalledTimes(mode === 'refused' ? 2 : 0);
    const head = await resolveKnowledgeAssetWorkspaceHead({ store, graphManager: input.graphManager, contextGraphId: CG, kaUal: UAL });
    expect(head?.operationAliases[0]).toMatchObject({ publishedAt: '2000', publisherChronologyAuthenticated: true,
      snapshotLocator: input.head.operationAliases[0]?.snapshotLocator });
  });

  it('retains the complete prior native operation subject when atomic replay replacement fails', async () => {
    const input = await recoveredHead();
    const query = `CONSTRUCT { <${input.subject}> ?p ?o } WHERE { GRAPH <${input.graph}> { <${input.subject}> ?p ?o } }`;
    const before = await input.store.query(query);
    const embedded = (input.store as unknown as { store: { update: (text: string) => void } }).store;
    const nativeUpdate = embedded.update.bind(embedded);
    // Native LOAD failure rolls back the entire DELETE/INSERT transaction.
    const update = vi.spyOn(embedded, 'update').mockImplementationOnce(text => nativeUpdate(`${text}; LOAD <urn:test:unavailable-replay>`));
    const insert = vi.spyOn(input.store, 'insert').mockRejectedValueOnce(new Error('Replay clock insertion unavailable'));
    await expect(authenticateWorkspaceOperationReplay({ ...input, timestamp: new Date(2000) })).rejects.toThrow();
    expect(await input.store.query(query)).toEqual(before);
    expect(update).toHaveBeenCalledOnce(); expect(insert).not.toHaveBeenCalled();
    expect(await readAuthenticatedWorkspaceOperations(input.store, before.type === 'quads' ? before.quads : [])).toEqual(new Set());
  });

  it('keeps a fully replaced subject untrusted if the subsequent authentication evidence fails, then retries successfully', async () => {
    const input = await recoveredHead(), replace = input.store.replaceSubject.bind(input.store);
    vi.spyOn(input.store, 'replaceSubject').mockImplementation(async (...args) => {
      if (args[0] === 'urn:dkg:publisher:authenticated-operation-evidence') throw new Error('Evidence unavailable');
      return replace(...args);
    });
    await expect(authenticateWorkspaceOperationReplay({ ...input, timestamp: new Date(2000) })).rejects.toThrow('Evidence unavailable');
    const current = (await resolveKnowledgeAssetWorkspaceHead({ store: input.store, graphManager: input.graphManager, contextGraphId: CG, kaUal: UAL }))!;
    expect(current.operationAliases[0]).toMatchObject({ publishedAt: '2000', publisherChronologyAuthenticated: false,
      snapshotLocator: input.head.operationAliases[0]?.snapshotLocator });
    vi.restoreAllMocks();
    await authenticateWorkspaceOperationReplay({ ...input, head: current, timestamp: new Date(2000) });
    expect((await resolveKnowledgeAssetWorkspaceHead({ store: input.store, graphManager: input.graphManager, contextGraphId: CG, kaUal: UAL }))?.operationAliases[0])
      .toMatchObject({ publishedAt: '2000', publisherChronologyAuthenticated: true });
  });
});
