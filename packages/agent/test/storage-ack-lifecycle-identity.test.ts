import { describe, expect, it } from 'vitest';
import {
  contextGraphLayerUri,
  decodePublishIntent,
  encodePublishIntent,
  MemoryLayer,
} from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { resolveStorageAckLifecycleAssetUalFromLocalSwm } from '../src/storage-ack-lifecycle-identity.js';

describe('Storage ACK lifecycle asset UAL identity', () => {
  it('does not reuse stale SWM identity for inline PublishIntent ACKs', async () => {
    const store = new OxigraphStore();
    const contextGraphId = '42';
    const rootEntity = 'urn:test:root';
    await store.insert([
      {
        subject: rootEntity,
        predicate: 'http://schema.org/name',
        object: '"old SWM data"',
        graph: contextGraphLayerUri(
          contextGraphId,
          MemoryLayer.SharedWorkingMemory,
          '0x1111111111111111111111111111111111111111',
          7,
        ),
      },
    ]);

    const result = await resolveStorageAckLifecycleAssetUalFromLocalSwm({
      store,
      chain: {
        chainId: 31337,
        getDKGKnowledgeAssetsAddress: async () => {
          throw new Error('inline ACK must not resolve asset UAL from stale SWM');
        },
      } as unknown as ChainAdapter,
      intent: decodePublishIntent(encodePublishIntent({
        contextGraphId,
        publisherPeerId: 'publisher-peer',
        merkleRoot: new Uint8Array(32),
        publicByteSize: 42,
        isPrivate: false,
        kaCount: 1,
        rootEntities: [rootEntity],
        epochs: 1,
        tokenAmountStr: '1000',
        merkleLeafCount: 1,
        stagingQuads: new TextEncoder().encode(
          `<${rootEntity}> <http://schema.org/name> "inline data" .`,
        ),
      })),
    });

    expect(result).toBeUndefined();
  });
});
