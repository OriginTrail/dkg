import { PROTOCOL_STORAGE_ACK } from '@origintrail-official/dkg-core';
import type { StorageACKEndpoint } from '../src/p2p/storage-ack-endpoint.js';

declare const endpoint: StorageACKEndpoint;

endpoint.dispatch({
  protocol: PROTOCOL_STORAGE_ACK,
  data: new Uint8Array(),
  peerId: 'local-core',
  context: {
    shareOperationId: 'share-1',
    publisherPeerId: 'metadata-peer',
    kaUal: 'did:dkg:otp:20430/0x1/1',
    assertionVersion: '1',
    accessPolicy: 'allowList',
    allowedPeers: ['reader'],
  },
});

endpoint.dispatch({
  protocol: PROTOCOL_STORAGE_ACK,
  data: new Uint8Array(),
  peerId: 'local-core',
  // @ts-expect-error A local head expectation must carry its immutable share identity and access envelope.
  context: { publisherPeerId: 'metadata-peer' },
});
