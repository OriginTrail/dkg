// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import { headIsUnpromotedOwedAckCopy } from '../src/workspace-draft-replacement.js';
import { storageAckLedgerEntryQuads } from '../src/storage-ack-ledger.js';

const CG = 'literal-ack';
const KA = 'did:dkg:31337/0x1111111111111111111111111111111111111111/7';
describe('ACK-copy expiry uses canonical RDF literal decoding', () => {
  it.each(['plain', 'typed', 'rdf-unicode', 'malformed'] as const)('preserves coherent unpublished expiry rules for %s signedAt', async form => {
    const store = new OxigraphStore(); const graphManager = new GraphManager(store);
    const timestamp = new Date(Date.now() - 600_000).toISOString();
    await store.insert(storageAckLedgerEntryQuads({ namespace: CG, metaGraph: graphManager.sharedMemoryMetaUri(CG),
      contextGraphId: '42', kaUal: KA, assertionVersion: '2', operation: 'publish', operationSubject: 'urn:dkg:share:literal-ack:owed', signedAt: new Date(timestamp) }));
    const original = store.query.bind(store);
    const readConfirmed = vi.fn(async () => 1n);
    const query = vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
      const result = await original(sparql, options);
      if (result.type !== 'bindings' || options?.source !== 'publisher.swm.graphScoped.owedAckCopy') return result;
      const lexical = form === 'plain' ? timestamp : form === 'malformed' ? '"bad\\q"' : `"${form === 'rdf-unicode' ? timestamp.replace('2', '\\U00000032') : timestamp}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`;
      return { ...result, bindings: result.bindings.map(row => ({ ...row, signedAt: lexical })) };
    });
    try {
      expect(await headIsUnpromotedOwedAckCopy({ store, graphManager, contextGraphId: CG, head: { kaUal: KA },
        version: 2n, pendingAckTxWindowMs: 300_000, readConfirmedKnowledgeAssetVersion: readConfirmed })).toBe(form === 'malformed');
      expect(readConfirmed).toHaveBeenCalledTimes(form === 'malformed' ? 0 : 1);
    } finally { query.mockRestore(); await store.close(); }
  });
});
