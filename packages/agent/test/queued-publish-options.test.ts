import { describe, expect, it, vi } from 'vitest';
import {
  prepareQueuedKnowledgeAssetVmPublishOptions,
  queuedKnowledgeAssetAccessEnvelope,
} from '../src/dkg-agent-publish.js';

describe('prepareQueuedKnowledgeAssetVmPublishOptions', () => {
  const snapshotQuads = [{
    subject: 'urn:test:asset',
    predicate: 'http://schema.org/name',
    object: '"public"',
    graph: '',
  }];

  it('treats a live public policy result as authoritative over queued fail-closed callbacks', () => {
    const queuedInline = vi.fn();
    const queuedChunked = vi.fn();

    const prepared = prepareQueuedKnowledgeAssetVmPublishOptions({
      contextGraphId: 'public-cg',
      snapshotQuads,
      onChainContextGraphId: '7',
      resolvedEncryptInlinePayload: undefined,
      resolvedEncryptInlineChunked: undefined,
      queuedEncryptInlinePayload: queuedInline,
      queuedEncryptInlineChunked: queuedChunked,
    });

    expect(prepared.quads).toEqual(snapshotQuads);
    expect(prepared.encryptInlinePayload).toBeUndefined();
    expect(prepared.encryptInlineChunked).toBeUndefined();
    expect(prepared.trustedNonManifestCatalogTriples).toBeUndefined();
  });

  it('retains queued fail-closed callbacks only when no live on-chain policy was resolved', () => {
    const queuedInline = vi.fn();
    const queuedChunked = vi.fn();

    const prepared = prepareQueuedKnowledgeAssetVmPublishOptions({
      contextGraphId: 'chainless-cg',
      snapshotQuads,
      resolvedEncryptInlinePayload: undefined,
      resolvedEncryptInlineChunked: undefined,
      queuedEncryptInlinePayload: queuedInline,
      queuedEncryptInlineChunked: queuedChunked,
    });

    expect(prepared.encryptInlinePayload).toBe(queuedInline);
    expect(prepared.encryptInlineChunked).toBe(queuedChunked);
  });

  it('preserves an owner-only envelope for the queued update entrypoint', () => {
    expect(queuedKnowledgeAssetAccessEnvelope({ accessPolicy: 'ownerOnly' })).toEqual({
      accessPolicy: 'ownerOnly',
      allowedPeers: undefined,
    });
  });

  it('copies the immutable allow-list for the queued update entrypoint', () => {
    const allowedPeers = ['peer-a', 'peer-b'];
    const envelope = queuedKnowledgeAssetAccessEnvelope({
      accessPolicy: 'allowList',
      allowedPeers,
    });

    expect(envelope).toEqual({ accessPolicy: 'allowList', allowedPeers });
    expect(envelope.allowedPeers).not.toBe(allowedPeers);
  });
});
