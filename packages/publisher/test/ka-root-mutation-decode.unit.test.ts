/**
 * Direct rows for the decode boundary itself (PR #2436 review r8): the poller
 * suite exercises the decoder through the lane, which never feeds it a name
 * outside the four it subscribes to — so the prototype-pollution guard needs
 * its own rows here.
 */
import { describe, expect, it } from 'vitest';
import type { ChainEvent } from '@origintrail-official/dkg-chain';
import { decodeKnowledgeAssetRootMutationEvent } from '../src/ka-root-mutation-decode.js';

const BLOCK_HASH = '0x' + 'cd'.repeat(32);
const TX_HASH = '0x' + 'ef'.repeat(32);

function event(type: string): ChainEvent {
  return {
    type,
    blockNumber: 7,
    data: { kaId: '42', blockHash: BLOCK_HASH, txHash: TX_HASH, txIndex: 0, logIndex: 1 },
  } as unknown as ChainEvent;
}

describe('decodeKnowledgeAssetRootMutationEvent', () => {
  it('rejects Object.prototype names as unknown event types (review r8)', () => {
    // Indexing a plain object accepted inherited names: `type: 'toString'`
    // read `Object.prototype.toString` as a kind, bypassed the unknown-event
    // guard, matched no switch case, and returned `{ ok: true, mutation:
    // undefined }` — which the poller then threw on while reading
    // `mutation.position`, stalling the lane behind a malformed event forever.
    for (const inherited of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__']) {
      expect(decodeKnowledgeAssetRootMutationEvent(event(inherited)), inherited).toEqual({
        ok: false,
        reason: 'unknown-event-type',
      });
    }
  });

  it('still decodes a real event type through the same guard', () => {
    const decoded = decodeKnowledgeAssetRootMutationEvent(event('KnowledgeAssetMerkleRootRemoved'));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.mutation.kind).toBe('root-removed');
      expect(decoded.mutation.kaId).toBe('42');
      expect(decoded.mutation.position.blockNumber).toBe(7);
    }
  });
});
