import { describe, expect, it, vi } from 'vitest';
import {
  prepareQueuedKnowledgeAssetVmPublishOptions,
  queuedKnowledgeAssetAccessEnvelope,
} from '../src/dkg-agent-publish.js';
import {
  computeKnowledgeAssetVmPublishIntentKey,
  type KnowledgeAssetVmPublishIntent,
} from '../src/knowledge-asset-vm-publish-intent.js';

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

describe('computeKnowledgeAssetVmPublishIntentKey', () => {
  const hex = (byte: string, count: number) => `0x${byte.repeat(count)}` as `0x${string}`;
  const base: KnowledgeAssetVmPublishIntent = {
    contextGraphId: 'cg-a',
    name: 'asset-a',
    agentAddress: '0x1111111111111111111111111111111111111111',
    subGraphName: 'research',
    shareOperationId: 'share-a',
    roots: [],
    contentScopeVersion: 2,
    kaUal: 'did:dkg:mock:31337/0x1111111111111111111111111111111111111111/7',
    assertionVersion: '1',
    publicTripleCount: 2,
    privateMerkleRoot: hex('11', 32),
    privateTripleCount: 1,
    accessPolicy: 'allowList',
    allowedPeers: ['peer-a'],
    entityProofs: false,
    seal: {
      merkleRoot: hex('22', 32),
      authorAddress: hex('11', 20),
      signature: { r: hex('33', 32), vs: hex('44', 32) },
      schemeVersion: 1,
      reservedKaId: '7',
    },
    sealChainId: '31337',
    sealKav10Address: hex('55', 20),
    sealFinalizedAtIso: '2026-07-15T00:00:00.000Z',
    sealMerkleRoot: hex('22', 32),
    wmCurrentAssertion: 'wm-a',
    swmCurrentAssertion: 'swm-a',
    vmCurrentAssertion: 'vm-a',
    kaNumber: '7',
    reservedUal: 'did:dkg:mock:31337/0x1111111111111111111111111111111111111111/7',
    publishEpochs: 2,
    clearSharedMemoryAfter: true,
    publisherNodeIdentityIdOverride: '9',
  };

  it('binds every executable request field and ignores object insertion order', () => {
    const baseKey = computeKnowledgeAssetVmPublishIntentKey(base);
    const mutations: Array<[
      string,
      (request: KnowledgeAssetVmPublishIntent) => KnowledgeAssetVmPublishIntent,
    ]> = [
      ['contextGraphId', (v) => ({ ...v, contextGraphId: 'cg-b' })],
      ['name', (v) => ({ ...v, name: 'asset-b' })],
      ['agentAddress', (v) => ({ ...v, agentAddress: '0x2222222222222222222222222222222222222222' })],
      ['subGraphName', (v) => ({ ...v, subGraphName: 'archive' })],
      ['shareOperationId', (v) => ({ ...v, shareOperationId: 'share-b' })],
      ['roots', (v) => ({ ...v, roots: ['urn:legacy:root'] })],
      ['contentScopeVersion', (v) => ({ ...v, contentScopeVersion: 3 })],
      ['kaUal', (v) => ({ ...v, kaUal: 'did:dkg:mock:31337/0x1111111111111111111111111111111111111111/8' })],
      ['assertionVersion', (v) => ({ ...v, assertionVersion: '2' })],
      ['publicTripleCount', (v) => ({ ...v, publicTripleCount: 3 })],
      ['privateMerkleRoot', (v) => ({ ...v, privateMerkleRoot: hex('66', 32) })],
      ['privateTripleCount', (v) => ({ ...v, privateTripleCount: 2 })],
      ['accessPolicy', (v) => ({ ...v, accessPolicy: 'ownerOnly' })],
      ['allowedPeers', (v) => ({ ...v, allowedPeers: ['peer-b'] })],
      ['entityProofs', (v) => ({ ...v, entityProofs: true })],
      ['seal.merkleRoot', (v) => ({ ...v, seal: { ...v.seal, merkleRoot: hex('77', 32) } })],
      ['seal.authorAddress', (v) => ({ ...v, seal: { ...v.seal, authorAddress: hex('22', 20) } })],
      ['seal.signature.r', (v) => ({ ...v, seal: { ...v.seal, signature: { ...v.seal.signature, r: hex('88', 32) } } })],
      ['seal.signature.vs', (v) => ({ ...v, seal: { ...v.seal, signature: { ...v.seal.signature, vs: hex('99', 32) } } })],
      ['seal.schemeVersion', (v) => ({ ...v, seal: { ...v.seal, schemeVersion: 2 } })],
      ['seal.reservedKaId', (v) => ({ ...v, seal: { ...v.seal, reservedKaId: '8' } })],
      ['sealChainId', (v) => ({ ...v, sealChainId: '1' })],
      ['sealKav10Address', (v) => ({ ...v, sealKav10Address: hex('aa', 20) })],
      ['sealFinalizedAtIso', (v) => ({ ...v, sealFinalizedAtIso: '2026-07-16T00:00:00.000Z' })],
      ['sealMerkleRoot', (v) => ({ ...v, sealMerkleRoot: hex('bb', 32) })],
      ['wmCurrentAssertion', (v) => ({ ...v, wmCurrentAssertion: 'wm-b' })],
      ['swmCurrentAssertion', (v) => ({ ...v, swmCurrentAssertion: 'swm-b' })],
      ['vmCurrentAssertion', (v) => ({ ...v, vmCurrentAssertion: 'vm-b' })],
      ['kaNumber', (v) => ({ ...v, kaNumber: '8' })],
      ['reservedUal', (v) => ({ ...v, reservedUal: 'did:dkg:mock:31337/0x1111111111111111111111111111111111111111/8' })],
      ['publishEpochs', (v) => ({ ...v, publishEpochs: 3 })],
      ['clearSharedMemoryAfter', (v) => ({ ...v, clearSharedMemoryAfter: false })],
      ['publisherNodeIdentityIdOverride', (v) => ({ ...v, publisherNodeIdentityIdOverride: '10' })],
    ];

    for (const [field, mutate] of mutations) {
      expect(computeKnowledgeAssetVmPublishIntentKey(mutate(base)), field).not.toBe(baseKey);
    }

    const reordered = Object.fromEntries(
      Object.entries(base).reverse(),
    ) as unknown as KnowledgeAssetVmPublishIntent;
    expect(computeKnowledgeAssetVmPublishIntentKey(reordered)).toBe(baseKey);
  });
});
