import { describe, expect, it } from 'vitest';
import { compareKnowledgeAssetUpdates, knowledgeAssetUpdateKey, normalizeKnowledgeAssetUpdateIdentity as identity } from '../src/knowledge-asset-update-identity.js';

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

  it('owns duplicate, superseded, ordered and incomparable event decisions', () => {
    const held = identity({ blockNumber: 50, logIndex: 7, txHash: '0xaa', blockHash: '0x01' });
    const seen = new Set([knowledgeAssetUpdateKey(identity({ blockNumber: 49 }), 'rootA')]);
    expect(compareKnowledgeAssetUpdates(held, 'rootB', held, 'rootB', seen)).toEqual({ kind: 'duplicate' });
    expect(compareKnowledgeAssetUpdates(identity({ blockNumber: 49 }), 'rootA', held, 'rootB', seen)).toEqual({ kind: 'superseded' });
    expect(compareKnowledgeAssetUpdates(identity({ blockNumber: 49 }), 'rootC', held, 'rootB', seen)).toEqual({ kind: 'replacement', relation: 'older', checkVersion: true });
    expect(compareKnowledgeAssetUpdates(identity({ blockNumber: 51 }), 'rootC', held, 'rootB', seen)).toEqual({ kind: 'replacement', relation: 'newer', checkVersion: false });
    expect(compareKnowledgeAssetUpdates(identity({ blockNumber: 50, logIndex: 8 }), 'rootC', held, 'rootB', seen)).toEqual({ kind: 'replacement', relation: 'newer', checkVersion: false });
    expect(compareKnowledgeAssetUpdates(identity({ blockNumber: 50, logIndex: 6 }), 'rootC', held, 'rootB', seen)).toEqual({ kind: 'replacement', relation: 'older', checkVersion: true });
    expect(compareKnowledgeAssetUpdates(identity({ blockNumber: 50, logIndex: 7, txHash: '0xaa', blockHash: '0x02' }), 'rootB', held, 'rootB', seen)).toEqual({ kind: 'replacement', relation: 'incomparable', checkVersion: true });
    expect(compareKnowledgeAssetUpdates(identity({}), 'rootC', held, 'rootB', seen)).toEqual({ kind: 'replacement', relation: 'incomparable', checkVersion: false });
  });
});
