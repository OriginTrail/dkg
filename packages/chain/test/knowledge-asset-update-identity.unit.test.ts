import { describe, expect, it } from 'vitest';
import { normalizeKnowledgeAssetUpdateIdentity as identity } from '../src/knowledge-asset-update-identity.js';

describe('Knowledge Asset update identity', () => {
  it('normalizes every supported metadata completeness without partial positions', () => {
    expect(identity({})).toEqual({ eventKind: 'legacy-unpositioned' });
    expect(identity({ logIndex: 7, txHash: '0xAB' })).toEqual({ eventKind: 'legacy-unpositioned', txHash: '0xab' });
    expect(identity({ blockNumber: -1, logIndex: 7 })).toEqual({ eventKind: 'legacy-unpositioned' });
    expect(identity({ blockNumber: 50, logIndex: NaN, blockHash: '0xCD' })).toEqual({ eventKind: 'legacy-block', blockNumber: 50, blockHash: '0xcd' });
    expect(identity({ blockNumber: 50, txHash: '0xAB', blockHash: '0xCD' })).toEqual({ eventKind: 'transaction', blockNumber: 50, txHash: '0xab', blockHash: '0xcd' });
    expect(identity({ blockNumber: 50, logIndex: 7 })).toEqual({ eventKind: 'log', blockNumber: 50, logIndex: 7 });
    expect(identity({ blockNumber: 50, logIndex: 7, txHash: '0xAB', blockHash: '0xCD' })).toEqual({ eventKind: 'log', blockNumber: 50, logIndex: 7, txHash: '0xab', blockHash: '0xcd' });
  });
});
