import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION, LegacyKnowledgeAssetReadOnlyError, createOperationContext,
} from '@origintrail-official/dkg-core';
import type { KnowledgeAssetVmPublishRequest } from '@origintrail-official/dkg-publisher';
import type { DKGAgent } from '../src/dkg-agent.js';
import { PublishMethods } from '../src/dkg-agent-publish.js';
import {
  assertionSealFromQueuedKnowledgeAssetVmPublishRequest,
  isGraphScopedKnowledgeAssetVmPublishRequest,
} from '../src/internal/knowledge-asset-vm-publish-request.js';

const AUTHOR = `0x${'11'.repeat(20)}` as const;
const ROOT = `0x${'12'.repeat(32)}` as const;

function request(overrides: Partial<KnowledgeAssetVmPublishRequest> = {}): KnowledgeAssetVmPublishRequest {
  return {
    contextGraphId: '1', name: 'asset', shareOperationId: 'queued-share', roots: [],
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: `did:dkg:evm:31337/${AUTHOR}/7`, assertionVersion: '3',
    publicTripleCount: 1, privateTripleCount: 0,
    seal: {
      merkleRoot: ROOT, authorAddress: AUTHOR, schemeVersion: 1, reservedKaId: '7',
      signature: { r: `0x${'34'.repeat(32)}`, vs: `0x${'56'.repeat(32)}` },
    },
    sealChainId: '31337', sealKav10Address: `0x${'44'.repeat(20)}`,
    sealFinalizedAtIso: '2026-01-01T00:00:00.000Z', sealMerkleRoot: ROOT,
    intentKey: `sha256:${'ab'.repeat(32)}`,
    ...overrides,
  };
}

describe('validated queued KA seal envelope', () => {
  it('reconstructs the exact public and private seal after narrowing', () => {
    for (const privateRoot of [undefined, `0x${'22'.repeat(32)}` as const]) {
      const queued = request({ privateMerkleRoot: privateRoot, privateTripleCount: privateRoot ? 2 : 0 });
      if (!isGraphScopedKnowledgeAssetVmPublishRequest(queued)) throw new Error('Valid request rejected');
      expect(assertionSealFromQueuedKnowledgeAssetVmPublishRequest(queued)).toEqual({
        merkleRoot: ethers.getBytes(ROOT), authorAddress: ethers.getAddress(AUTHOR),
        authorAttestationR: new Uint8Array(32).fill(0x34),
        authorAttestationVS: new Uint8Array(32).fill(0x56), authorSchemeVersion: 1,
        chainId: 31337n, kav10Address: ethers.getAddress(queued.sealKav10Address),
        finalizedAtIso: queued.sealFinalizedAtIso, contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        kaUal: queued.kaUal, assertionVersion: '3', publicTripleCount: 1,
        ...(privateRoot ? { privateMerkleRoot: ethers.getBytes(privateRoot) } : {}),
        privateTripleCount: privateRoot ? 2 : 0, rootEntities: [], reservedKaId: 7n,
      });
    }
  });

  it.each([
    ['legacy version', { contentScopeVersion: 1 }],
    ['missing UAL', { kaUal: undefined }],
    ['missing version', { assertionVersion: undefined }],
    ['missing public count', { publicTripleCount: undefined }],
    ['missing private count', { privateTripleCount: undefined }],
    ['legacy entity roots', { roots: ['urn:legacy:entity'] }],
  ] as const)('rejects %s in execution, preflight and recovery before chain reads', async (_name, override) => {
    const queued = request(override);
    const readChain = vi.fn(() => { throw new Error('Invalid envelopes must not reach chain reads'); });
    const host = { publisher: {}, chain: { getChainId: readChain } } as unknown as DKGAgent;
    await expect(PublishMethods.prototype.preflightQueuedKnowledgeAssetVmPublishExecution.call(host, queued))
      .rejects.toBeInstanceOf(LegacyKnowledgeAssetReadOnlyError);
    // The envelope is checked before any persisted receipt/job fields are read.
    const recovery = { request: queued } as Parameters<DKGAgent['_finalizeRecoveredQueuedKnowledgeAssetVmPublish']>[0];
    await expect(PublishMethods.prototype._finalizeRecoveredQueuedKnowledgeAssetVmPublish.call(
      host, recovery, createOperationContext('publishFromSWM'),
    )).rejects.toBeInstanceOf(LegacyKnowledgeAssetReadOnlyError);
    const executing = PublishMethods.prototype.publishQueuedKnowledgeAssetVmPublish.call(host, queued, {});
    if (queued.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION) {
      await expect(executing).rejects.toBeInstanceOf(LegacyKnowledgeAssetReadOnlyError);
    } else {
      await expect(executing).rejects.toThrow('incomplete KA content envelope');
    }
    expect(readChain).not.toHaveBeenCalled();
  });

  it('keeps queued pricing disagreement ahead of legacy envelope rejection', async () => {
    const queued = request({ contentScopeVersion: 1 });
    await expect(PublishMethods.prototype.publishQueuedKnowledgeAssetVmPublish.call(
      { publisher: {} } as unknown as DKGAgent, queued, { pricingPolicy: 'full-content' },
    )).rejects.toMatchObject({ code: 'PUBLISH_INTENT_STALE' });
  });
});
