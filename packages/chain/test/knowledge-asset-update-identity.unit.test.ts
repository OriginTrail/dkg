import { describe, expect, it } from 'vitest';
import { knowledgeAssetUpdateKey, normalizeKnowledgeAssetUpdateIdentity as identity } from '../src/knowledge-asset-update-identity.js';

describe('Knowledge Asset update identity', () => {
  it('normalizes every supported metadata completeness without partial positions', () => {
    expect(() => knowledgeAssetUpdateKey({} as never, 'root')).toThrow('identity is invalid');
    expect(identity({})).toEqual({ eventKind: 'legacy-unpositioned' });
    expect(identity({ logIndex: 7, txHash: '0xAB' })).toEqual({ eventKind: 'legacy-unpositioned', txHash: '0xab' });
    expect(identity({ blockNumber: -1, logIndex: 7 })).toEqual({ eventKind: 'legacy-unpositioned' });
    expect(identity({ blockNumber: 50, logIndex: NaN, blockHash: '0xCD' })).toEqual({ eventKind: 'legacy-block', blockNumber: 50, blockHash: '0xcd' });
    expect(identity({ blockNumber: 50, txHash: '0xAB', blockHash: '0xCD' })).toEqual({ eventKind: 'transaction', blockNumber: 50, txHash: '0xab', blockHash: '0xcd' });
    expect(identity({ blockNumber: 50, logIndex: 7 })).toEqual({ eventKind: 'log', blockNumber: 50, logIndex: 7 });
    expect(identity({ blockNumber: 50, logIndex: 7, txHash: '0xAB', blockHash: '0xCD' })).toEqual({ eventKind: 'log', blockNumber: 50, logIndex: 7, txHash: '0xab', blockHash: '0xcd' });
  });

  it('keeps identity keys stable and distinguishes roots, positions, transactions and forks', () => {
    const held = identity({ blockNumber: 50, logIndex: 7, txHash: '0xaa', blockHash: '0x01' });
    const key = knowledgeAssetUpdateKey(held, 'rootB');
    expect(knowledgeAssetUpdateKey({ ...held }, 'rootB')).toBe(key);
    expect(knowledgeAssetUpdateKey(held, 'rootC')).not.toBe(key);
    for (const metadata of [
      { blockNumber: 49, logIndex: 7, txHash: '0xaa', blockHash: '0x01' },
      { blockNumber: 50, logIndex: 8, txHash: '0xaa', blockHash: '0x01' },
      { blockNumber: 50, logIndex: 7, txHash: '0xbb', blockHash: '0x01' },
      { blockNumber: 50, logIndex: 7, txHash: '0xaa', blockHash: '0x02' },
    ]) expect(knowledgeAssetUpdateKey(identity(metadata), 'rootB')).not.toBe(key);
    expect(knowledgeAssetUpdateKey(identity({ blockNumber: NaN, logIndex: 7 }), 'rootB'))
      .toBe(knowledgeAssetUpdateKey(identity({}), 'rootB'));
    expect(knowledgeAssetUpdateKey(identity({ blockNumber: 50 }), 'rootB'))
      .not.toBe(knowledgeAssetUpdateKey(identity({ blockNumber: 51 }), 'rootB'));
    expect(knowledgeAssetUpdateKey(identity({ blockNumber: 50, txHash: '0xaa' }), 'rootB'))
      .not.toBe(knowledgeAssetUpdateKey(identity({ blockNumber: 50, txHash: '0xbb' }), 'rootB'));
  });
});
