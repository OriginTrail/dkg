// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { GraphManager, type Quad } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher, storeKnowledgeAssetOperationPublicQuads, storeKnowledgeAssetWorkspaceHead, workspaceOperationSubject, resolveKnowledgeAssetWorkspaceHead } from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../src/index.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import { kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';

const DKG = 'http://dkg.io/ontology/';
const CG = 'ttl-equivalent-aliases';
const KA = 'did:dkg:31337/0x1111111111111111111111111111111111111111/7';
const TTL = 30 * 24 * 60 * 60_000;
const nodes: DKGAgent[] = [];
afterEach(async () => { await Promise.all(nodes.splice(0).map(node => node.stop())); });

describe('TTL retirement of complete equivalent alias classes', () => {
  it.each(['live', 'queued', 'unledgered-ack'] as const)('keeps expired P while equivalent Q is %s, then collects after Q is no longer retained', async mode => {
    const ttl = mode === 'unledgered-ack' ? 60 * 60_000 : TTL;
    const qId = mode === 'unledgered-ack' ? 'storage-ack-Q' : 'Q';
    const node = await DKGAgent.create({ name: 'ttl-aliases', listenPort: 0, chainAdapter: new NoChainAdapter(), kaNumberAllocator: makeTestKaNumberAllocator(), sharedMemoryTtlMs: ttl });
    nodes.push(node);
    const store = node.store;
    const manager = new GraphManager(store);
    await manager.ensureContextGraph(CG);
    const meta = manager.sharedMemoryMetaUri(CG);
    const data: Quad[] = [{ subject: 'urn:alias:payload', predicate: 'urn:title', object: '"retained"', graph: '' }];
    const seed = async (id: string, age: number) => storeKnowledgeAssetOperationPublicQuads({ store, graphManager: manager, contextGraphId: CG, shareOperationId: id, kaUal: KA, assertionVersion: 1, quads: data, publisherPeerId: 'publisher', timestamp: new Date(Date.now() - age) });
    await seed('P', ttl + 24 * 60 * 60_000);
    await seed(qId, mode === 'queued' ? ttl + 24 * 60 * 60_000 : ttl / 2);
    await storeKnowledgeAssetWorkspaceHead({ store, graphManager: manager, contextGraphId: CG, kaUal: KA, assertionVersion: 1, shareOperationId: 'P' });
    const head = `${KA}#dkg-swm-head`;
    await store.insert([{ subject: head, predicate: `${DKG}shareOperationId`, object: JSON.stringify(qId), graph: meta }]);
    const headRows = await store.query(`SELECT ?g WHERE { GRAPH <${meta}> { <${head}> <${DKG}assertionGraph> ?g } }`);
    if (headRows.type !== 'bindings') throw new Error('expected head graph');
    const assertionGraph = headRows.bindings[0]!['g']!;
    await store.insert(data.map(row => ({ ...row, graph: assertionGraph })));
    const queue = new TripleStoreAsyncLiftPublisher(store, { knowledgeAssetVmPublishHandler: { preflight: async () => { throw new Error('held queue'); }, execute: async () => { throw new Error('must not execute'); } } });
    const job = mode === 'queued' ? await queue.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ contextGraphId: CG, shareOperationId: 'Q', assertionVersion: '1', kaUal: KA })) : undefined;
    expect(await node.cleanupExpiredSharedMemory()).toBe(0);
    const exists = async (graph: string, subject?: string) => { const result = await store.query(`ASK { GRAPH <${graph}> { ${subject ? `<${subject}>` : '?s'} ?p ?o } }`); return result.type === 'boolean' && result.value; };
    for (const id of ['P', qId]) expect(await exists(meta, workspaceOperationSubject(CG, id))).toBe(true);
    expect(await exists(meta, head)).toBe(true);
    expect(await exists(assertionGraph)).toBe(true);
    const resolved = await resolveKnowledgeAssetWorkspaceHead({ store, graphManager: manager, contextGraphId: CG, kaUal: KA });
    expect(resolved?.operationAliases.map(alias => alias.shareOperationId).sort()).toEqual(['P', qId].sort());
    expect(resolved?.operationAliases.find(alias => alias.shareOperationId === 'P')?.publisherChronologyAuthenticated).not.toBe(false);
    if (mode === 'unledgered-ack') {
      // No ledger row and one-hour TTL: Q still protects both aliases and data.
      // Removing Q's reference and operation demonstrates P becomes collectible.
      await store.deleteByPattern({ graph: meta, subject: head, predicate: `${DKG}shareOperationId`, object: JSON.stringify(qId) });
      await store.deleteByPattern({ graph: meta, subject: workspaceOperationSubject(CG, qId) });
    }
    // Remove the sole retention reason, without changing the production TTL.
    if (job) { await queue.processNext('wallet'); expect((await queue.clearTerminalJob(job)).outcome).toBe('cleared'); }
    else if (mode !== 'unledgered-ack') {
      await store.deleteByPattern({ graph: meta, subject: workspaceOperationSubject(CG, qId), predicate: `${DKG}publishedAt` });
      await store.insert([{ subject: workspaceOperationSubject(CG, qId), predicate: `${DKG}publishedAt`, object: `"${new Date(Date.now() - TTL - 24 * 60 * 60_000).toISOString()}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`, graph: meta }]);
    }
    expect(await node.cleanupExpiredSharedMemory()).toBeGreaterThan(0);
    expect(await exists(meta, head)).toBe(false);
    expect(await exists(assertionGraph)).toBe(false);
  });
});
