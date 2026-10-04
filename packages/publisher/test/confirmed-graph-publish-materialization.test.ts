// SPDX-License-Identifier: Apache-2.0
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { createGraphKnowledgeAssetScope, MemoryLayer, knowledgeAssetLayerGraphUri } from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore, PrivateContentStore, type Quad } from '@origintrail-official/dkg-storage';
import { materializeConfirmedGraphPublish } from '../src/confirmed-graph-publish-materialization.js';
import { generateGraphKnowledgeAssetMetadata, withMaterializationLock, writeMaterializedVersion } from '../src/metadata.js';

function fixture() {
  const store = new OxigraphStore();
  const contextGraphId = 'mint-materialization';
  const scope = createGraphKnowledgeAssetScope('did:dkg:31337/0x00000000000000000000000000000000000000ab/7', 1);
  const vmGraph = knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.VerifiableMemory, scope);
  const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
  const vmQuads: Quad[] = [{ subject: 'urn:data', predicate: 'urn:value', object: '"old"', graph: vmGraph }];
  const confirmedQuads = generateGraphKnowledgeAssetMetadata({ ual: scope.ual, contextGraphId,
    assertionVersion: 1, assertionGraph: vmGraph, publisherPeerId: 'owner', accessPolicy: 'public',
    merkleRoot: new Uint8Array(32).fill(7), timestamp: new Date(0), publicTripleCount: 1,
  }, { status: 'confirmed', confirmation: { kind: 'transaction', provenance: { batchId: 7n, txHash: `0x${'11'.repeat(32)}` } } });
  return { store, privateStore: new PrivateContentStore(store, new GraphManager(store)),
    scope, contextGraphId, metaGraph, vmGraph, vmQuads, privateQuads: [], confirmedQuads,
    version: { blockNumber: 10, txIndex: 2 }, persistCatalogEntry: vi.fn(async () => undefined) };
}

describe('confirmed graph publish materialization', () => {
  it.each([{ blockNumber: 11, txIndex: 0 }, { blockNumber: 10, txIndex: 3 }])(
    'retains the newer chain ordering %j even at the same assertion version', async newer => {
      const input = fixture();
      try {
        const replacement = input.vmQuads.map(q => ({ ...q, object: '"new"' }));
        await input.store.insert(replacement);
        await writeMaterializedVersion(input.store, input.metaGraph, input.scope.ual, newer);
        expect(await materializeConfirmedGraphPublish(input)).toBe(false);
        expect(await input.store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${input.vmGraph}> { ?s ?p ?o } }`))
          .toMatchObject({ type: 'quads', quads: [expect.objectContaining({ object: '"new"' })] });
        expect(input.persistCatalogEntry).not.toHaveBeenCalled();
      } finally { await input.store.close(); }
    },
  );

  it('waits for the existing per-KA lock before reading the version and writing any slice', async () => {
    const input = fixture();
    let release!: () => void;
    let entered!: () => void;
    const active = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const precedingUpdate = withMaterializationLock(input.metaGraph, input.scope.ual, async () => {
      entered();
      await held;
      await writeMaterializedVersion(input.store, input.metaGraph, input.scope.ual, { blockNumber: 11, txIndex: 0 });
    });
    await active;
    let settled = false;
    const publish = materializeConfirmedGraphPublish(input).finally(() => { settled = true; });
    try {
      await setImmediate();
      expect(settled).toBe(false);
      expect(await input.store.countQuads(input.vmGraph)).toBe(0);
      expect(input.persistCatalogEntry).not.toHaveBeenCalled();
    } finally { release(); }
    try {
      await precedingUpdate;
      expect(await publish).toBe(false);
      expect(await input.store.countQuads(input.vmGraph)).toBe(0);
    } finally { await input.store.close(); }
  });

  it('refuses a store without atomic complete-graph replacement', async () => {
    const input = fixture();
    try {
      await input.store.insert(input.vmQuads);
      Reflect.set(input.store, 'replaceGraph', undefined);
      await expect(materializeConfirmedGraphPublish(input))
        .rejects.toMatchObject({ code: 'ATOMIC_GRAPH_REPLACE_UNSUPPORTED', graphUri: input.vmGraph });
      expect(await input.store.countQuads(input.vmGraph)).toBe(1);
      expect(input.persistCatalogEntry).not.toHaveBeenCalled();
    } finally { await input.store.close(); }
  });

  it('does not stamp the materialized version or catalog after a failed public graph swap', async () => {
    const input = fixture();
    try {
      vi.spyOn(input.store, 'replaceGraph').mockRejectedValue(new Error('swap failed'));
      await expect(materializeConfirmedGraphPublish(input)).rejects.toThrow('swap failed');
      expect(input.persistCatalogEntry).not.toHaveBeenCalled();
      await expect(input.store.query(`ASK { GRAPH <${input.metaGraph}> {
        <${input.scope.ual}> <http://dkg.io/ontology/materializedVersion> ?v } }`))
        .resolves.toMatchObject({ type: 'boolean', value: false });
    } finally { await input.store.close(); }
  });
});
