import { describe, expect, it, vi } from 'vitest';
import { DKGAgent } from '../../agent/src/index.js';
import { makeTestKaNumberAllocator } from '../../agent/test/_helpers/ka-allocator.js';
import { createEVMAdapter, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { GraphManager, PrivateContentStore } from '@origintrail-official/dkg-storage';
import {
  assertionLifecycleUri, contextGraphMetaUri, createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri, MemoryLayer, decodeSwmSenderKeyMessage,
} from '@origintrail-official/dkg-core';
import { PROMOTE_OPERATION_INTENT_PRED, SHARE_OPERATION_ID_PRED } from '../../publisher/src/metadata.js';
import {
  PRIVATE_SHARE_AUTHORITY_RETRY_ERROR,
  retryPrivateShareAuthority,
} from './helpers/private-share-authority-retry.js';

describe('private share authority churn (real agent, signed chain seal and store)', () => {
  it('refuses before intent/SWM writes and retries the identical sealed private assertion', async () => {
    const agent = await DKGAgent.create({
      name: 'private-share-authority-churn', listenPort: 0, nodeRole: 'edge',
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      kaNumberAllocator: makeTestKaNumberAllocator(),
      rfc64CatalogActivation: { enabled: false },
    });
    const cg = `private-share-churn-${Date.now()}`;
    const name = 'same-sealed-private-assertion';
    let churn = true;
    let mutations = 0;
    const observedRevisions: number[] = [];
    try {
      await agent.start();
      await agent.createContextGraph({ id: cg, name: cg, accessPolicy: 1 });
      await agent.registerContextGraph(cg);
      await agent.assertion.create(cg, name);
      await agent.assertion.write(cg, name, [{
        subject: 'urn:share:entity', predicate: 'urn:share:public', object: '"original public"',
      }]);
      const author = agent.defaultAgentAddress ?? agent.peerId;
      await agent.publisher.assertionWritePrivate(cg, name, author, [{
        subject: 'urn:share:entity', predicate: 'urn:share:private', object: '"original private"', graph: '',
      }]);
      const seal = await agent.assertion.finalize(cg, name);
      expect(seal).toMatchObject({ publicTripleCount: 1, privateTripleCount: 1 });
      expect(seal.privateMerkleRoot).toHaveLength(32);
      const publicDraft = await agent.assertion.query(cg, name);
      const privateDraft = await agent.assertion.queryPrivate(cg, name);
      const swmGraph = knowledgeAssetLayerGraphUri(cg, MemoryLayer.SharedMemory,
        createGraphKnowledgeAssetScope(seal.kaUal, seal.assertionVersion));
      const lifecycle = assertionLifecycleUri(cg, author, name);
      const readIntent = () => agent.store.query(`SELECT ?p ?o WHERE {
        GRAPH <${contextGraphMetaUri(cg)}> { <${lifecycle}> ?p ?o }
        VALUES ?p { <${SHARE_OPERATION_ID_PRED}> <${PROMOTE_OPERATION_INTENT_PRED}> }
      }`);
      const readSwm = () => agent.store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${swmGraph}> { ?s ?p ?o } }`);
      const projection = (agent as unknown as {
        contextGraphMetaProjection: { readAuthorityFactsRevision: number };
      }).contextGraphMetaProjection;
      const query = agent.store.query.bind(agent.store);
      let interleaving = false;
      const queries = vi.spyOn(agent.store, 'query').mockImplementation(async (...args) => {
        const result = await query(...args);
        if (churn && !interleaving && args[0].includes('SELECT DISTINCT ?key')
          && args[0].includes('publicEncryptionKey')
          && result.type === 'bindings' && result.bindings.length > 0) {
          interleaving = true;
          try {
            const before = projection.readAuthorityFactsRevision;
            // Interleave an actual authority metadata write after the real key
            // read. Neither the resolver, chain roster nor its error is stubbed.
            const other = `${cg}-concurrent-${++mutations}`;
            await agent.createContextGraph({ id: other, name: other, accessPolicy: 1 });
            expect(projection.readAuthorityFactsRevision).toBeGreaterThan(before);
            observedRevisions.push(projection.readAuthorityFactsRevision);
          } finally { interleaving = false; }
        }
        return result;
      });
      const encrypted = vi.spyOn(agent, 'encryptWorkspacePayloadWithSenderKey');
      let submissions = 0;
      const result = await retryPrivateShareAuthority(async () => {
        submissions += 1;
        let failure: unknown;
        let promoted;
        try { promoted = await agent.assertion.promote(cg, name, { accessPolicy: 'ownerOnly' }); }
        catch (error) { failure = error; }
        if (failure === undefined) return { status: 200, body: { promoted } };
        expect(failure).toMatchObject({
          code: 'PROMOTE_RETRYABLE_FAILURE', message: PRIVATE_SHARE_AUTHORITY_RETRY_ERROR,
          cause: { message: expect.stringContaining('private authority changed while recipient keys were resolving') },
        });
        expect(mutations).toBeGreaterThanOrEqual(3);
        expect(new Set(observedRevisions).size).toBe(mutations);
        expect(await readIntent()).toMatchObject({ type: 'bindings', bindings: [] });
        expect(await readSwm()).toMatchObject({ type: 'quads', quads: [] });
        expect(await agent.assertion.query(cg, name)).toEqual(publicDraft);
        expect(await agent.assertion.queryPrivate(cg, name)).toEqual(privateDraft);
        expect(await agent.assertion.finalize(cg, name)).toEqual(seal);
        expect(encrypted).not.toHaveBeenCalled();
        return { status: 500, body: { error: (failure as Error).message } };
      }, async () => { churn = false; });
      queries.mockRestore();
      expect(submissions).toBe(2);
      expect(result.status).toBe(200);
      expect(result.body.promoted).toMatchObject({ sealed: true, publishReady: true, promotedCount: 2 });
      const intent = await agent.resolveFinalizedAssertionVmPublishIntent(cg, name);
      expect(intent).toMatchObject({
        kaUal: seal.kaUal, assertionVersion: seal.assertionVersion,
        sealMerkleRoot: `0x${Buffer.from(seal.merkleRoot).toString('hex')}`,
        privateMerkleRoot: `0x${Buffer.from(seal.privateMerkleRoot!).toString('hex')}`,
        publicTripleCount: 1, privateTripleCount: 1, accessPolicy: 'ownerOnly',
      });
      const privateContent = await new PrivateContentStore(agent.store, new GraphManager(agent.store)).getKnowledgeAssetPrivateTriples(
        cg, createGraphKnowledgeAssetScope(seal.kaUal, seal.assertionVersion),
        undefined, { expectedQuadCount: seal.privateTripleCount });
      expect(privateContent.map(quad => quad.object)).toEqual(['"original private"']);
      expect(encrypted).toHaveBeenCalledOnce();
      const message = decodeSwmSenderKeyMessage(await encrypted.mock.results[0]!.value);
      expect(message.contextGraphId).toBe(cg);
      expect(message.ciphertext.length).toBeGreaterThan(0);
      expect(Buffer.from(message.ciphertext).includes(Buffer.from('original public'))).toBe(false);
      encrypted.mockRestore();
    } finally {
      vi.restoreAllMocks();
      await agent.stop();
    }
  });
});
