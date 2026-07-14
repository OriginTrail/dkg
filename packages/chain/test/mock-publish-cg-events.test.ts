/**
 * Regression — `MockChainAdapter.publishToContextGraph` must emit the
 * `KCCreated` / `KnowledgeBatchCreated` events that
 * `resolvePublishByTxHash` walks; the V9 publish helper that previously
 * fanned those events out was archived in issue 0004 and the inline
 * replacement initially dropped them. Without the events,
 * mock-backed event pollers never see the publish confirmation and
 * `resolvePublishByTxHash` returns `null` for a tx hash the adapter
 * just produced.
 */
import { describe, it, expect } from 'vitest';
import { MockChainAdapter } from '../src/mock-adapter.js';

describe('MockChainAdapter.publishToContextGraph — emits publish events', () => {
  async function createOpenCG(mock: MockChainAdapter): Promise<bigint> {
    const result = await mock.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1, // open
    });
    return result.contextGraphId;
  }

  it('resolvePublishByTxHash finds the publish by txHash after publishToContextGraph', async () => {
    const mock = new MockChainAdapter('mock:31337', '0x1111111111111111111111111111111111111111');
    mock.minimumRequiredSignatures = 0;
    const cgId = await createOpenCG(mock);

    const result = await mock.publishToContextGraph({
      contextGraphId: cgId,
      kaCount: 1,
      publisherNodeIdentityId: 1n,
      merkleRoot: new Uint8Array(32),
      publicByteSize: 1n,
      epochs: 1,
      tokenAmount: 1n,
      publisherSignature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
      receiverSignatures: [],
      participantSignatures: [{ identityId: 1n, r: new Uint8Array(32), vs: new Uint8Array(32) }],
      merkleLeafCount: 1,
    });

    const resolved = await mock.resolvePublishByTxHash(result.txHash);
    expect(resolved).not.toBeNull();
    expect(resolved!.batchId).toBe(result.batchId);
    expect(resolved!.txHash).toBe(result.txHash);
    expect(resolved!.publisherAddress.toLowerCase()).toBe(mock.signerAddress.toLowerCase());
    expect(resolved!.merkleRoot).toEqual(new Uint8Array(32));
    expect(resolved!.authorAddress?.toLowerCase()).toBe(mock.signerAddress.toLowerCase());
  });

  it('emits both KCCreated and KnowledgeBatchCreated for publishToContextGraph (mirrors the archived V9 helper)', async () => {
    const mock = new MockChainAdapter('mock:31337', '0x1111111111111111111111111111111111111111');
    mock.minimumRequiredSignatures = 0;
    const cgId = await createOpenCG(mock);

    const result = await mock.publishToContextGraph({
      contextGraphId: cgId,
      kaCount: 1,
      publisherNodeIdentityId: 1n,
      merkleRoot: new Uint8Array(32),
      publicByteSize: 1n,
      epochs: 1,
      tokenAmount: 1n,
      publisherSignature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
      receiverSignatures: [],
      participantSignatures: [{ identityId: 1n, r: new Uint8Array(32), vs: new Uint8Array(32) }],
      merkleLeafCount: 1,
    });

    // Drain emitted events and look for the two confirmation events the
    // ChainEventPoller / WAL consumers rely on.
    const seenTypes = new Set<string>();
    for (const evt of (mock as any).events as Array<{ type: string; data: Record<string, unknown> }>) {
      if (evt.data?.txHash === result.txHash) seenTypes.add(evt.type);
    }
    expect(seenTypes.has('KnowledgeBatchCreated')).toBe(true);
    expect(seenTypes.has('KCCreated')).toBe(true);
  });
});
