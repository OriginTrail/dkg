import { describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { GRAPH_KA_CONTENT_SCOPE_VERSION, assertionLifecycleUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import type { KnowledgeAssetVmPublishRequest } from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../src/dkg-agent.js';

const author = '0x1111111111111111111111111111111111111111';
const root = `0x${'ab'.repeat(32)}` as `0x${string}`;
const request: KnowledgeAssetVmPublishRequest = {
  contextGraphId: 'urn:test:lifecycle-construction', agentAddress: author, name: 'asset',
  subGraphName: 'scope', shareOperationId: 'share', roots: [],
  contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
  kaUal: 'did:test:queued', assertionVersion: '1', publicTripleCount: 1, privateTripleCount: 0,
  seal: { merkleRoot: root, authorAddress: author, schemeVersion: 1, reservedKaId: '42',
    signature: { r: `0x${'34'.repeat(32)}`, vs: `0x${'56'.repeat(32)}` } },
  sealChainId: '31337', sealKav10Address: author,
  sealFinalizedAtIso: '2026-01-01T00:00:00.000Z', sealMerkleRoot: root,
  intentKey: `sha256:${'ab'.repeat(32)}`,
};

describe('agent construction wires the queued lifecycle writer', () => {
  it.each([false, true])('uses its configured store and propagates failure (fail=%s)', async fail => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter();
    const agent = await DKGAgent.create({ name: 'lifecycle-construction', store,
      chainAdapter: chain, rfc64CatalogActivation: { enabled: false } });
    try {
      const failure = new Error('lifecycle update rejected');
      const update = vi.spyOn(store, 'atomicUpdate');
      vi.spyOn(chain, 'getKnowledgeAssetsLifecycleAddress').mockResolvedValue(author);
      vi.spyOn(chain, 'readKnowledgeAssetVersionSnapshot').mockResolvedValue({ latestRoot: `0x${'cd'.repeat(32)}`, rootCount: 1n });
      vi.spyOn(agent, '_resolveRecoveredKnowledgeAssetVmLifecycleAuthor').mockResolvedValue({ author, incomplete: false });
      if (fail) update.mockRejectedValueOnce(failure);
      const insert = vi.spyOn(store, 'insert');
      const remove = vi.spyOn(store, 'deleteByPatternWithoutCount');
      const currentRoot = `0x${'cd'.repeat(32)}`;
      const operation = agent._stampQueuedKnowledgeAssetVmPublishedLifecycle(request, 'did:test:published', 42n, currentRoot);
      if (fail) await expect(operation).rejects.toBe(failure);
      else await operation;
      expect(update).toHaveBeenCalledOnce();
      expect(update.mock.calls[0]![1]).toEqual({ touchedGraphs: [contextGraphMetaUri(request.contextGraphId)], source: 'agent.publish.confirmedLifecycleCommit' });
      expect(remove).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled();
      if (!fail) {
        const lifecycle = assertionLifecycleUri(request.contextGraphId, author, request.name, request.subGraphName);
        const result = await store.query(`SELECT ?p ?o WHERE { GRAPH <${contextGraphMetaUri(request.contextGraphId)}> { <${lifecycle}> ?p ?o } }`);
        expect(result.type).toBe('bindings');
        if (result.type !== 'bindings') throw new Error('Expected bindings');
        expect(result.bindings.some(row => row.o === '"did:test:published"')).toBe(true);
        expect(result.bindings.some(row => row.o === `"${'cd'.repeat(32)}"`)).toBe(true);
      }
    } finally { await agent.stop(); }
  });
});
