import { describe, it, expect } from 'vitest';
import { NoChainAdapter } from '../src/no-chain-adapter.js';

describe('NoChainAdapter', () => {
  const adapter = new NoChainAdapter();

  it('has chainType "evm" and chainId "none"', () => {
    expect(adapter.chainType).toBe('evm');
    expect(adapter.chainId).toBe('none');
  });

  it('getIdentityId returns 0n', async () => {
    const id = await adapter.getIdentityId();
    expect(id).toBe(0n);
  });

  const throwingMethods: Array<[string, () => Promise<unknown>]> = [
    ['registerIdentity', () => adapter.registerIdentity({ publicKey: new Uint8Array(), signature: new Uint8Array() })],
    ['ensureProfile', () => adapter.ensureProfile()],
    ['reserveUALRange', () => adapter.reserveUALRange(1)],
    ['batchMintKnowledgeAssets', () => adapter.batchMintKnowledgeAssets({
      publisherNodeIdentityId: 0n, merkleRoot: new Uint8Array(), startKAId: 0n,
      endKAId: 0n, publicByteSize: 0n, epochs: 1, tokenAmount: 0n,
      publisherSignature: { r: new Uint8Array(), vs: new Uint8Array() },
      receiverSignatures: [],
    })],
    ['publishKnowledgeAssets', () => adapter.publishKnowledgeAssets({
      kaCount: 1, publisherNodeIdentityId: 0n, merkleRoot: new Uint8Array(),
      publicByteSize: 0n, epochs: 1, tokenAmount: 0n,
      publisherSignature: { r: new Uint8Array(), vs: new Uint8Array() },
      receiverSignatures: [],
    })],
    ['updateKnowledgeAssets', () => adapter.updateKnowledgeAssets({
      batchId: 0n, newMerkleRoot: new Uint8Array(), newPublicByteSize: 0n,
    })],
    ['extendStorage', () => adapter.extendStorage({
      batchId: 0n, additionalEpochs: 1, tokenAmount: 0n,
    })],
    ['transferNamespace', () => adapter.transferNamespace('0x0')],
    ['createParanet', () => adapter.createParanet({})],
    ['submitToParanet', () => adapter.submitToParanet('kc1', 'paranet1')],
    ['revealParanetMetadata', () => adapter.revealParanetMetadata('p1', 'name', 'desc')],
  ];

  it.each(throwingMethods)('%s throws "No blockchain configured"', async (_name, fn) => {
    await expect(fn()).rejects.toThrow('No blockchain configured');
  });

  it('listenForEvents throws "No blockchain configured"', async () => {
    const iter = adapter.listenForEvents({ eventTypes: ['test'] });
    await expect(async () => {
      for await (const _event of iter) { /* consume */ }
    }).rejects.toThrow('No blockchain configured');
  });
});
